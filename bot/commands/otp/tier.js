// bot/commands/otp/tier.js — CHEAP/BUNDLE/VIP mode menus, service & country selection, tier operator flow, OTP auto-check
// Mixed into OTPCommands.prototype by bot/commands/otp.js (bodies unchanged: `this` is the OTPCommands instance).
import CountryCatalog from '../../../services/CountryCatalog.js';
import { sessionStartedText } from '../othersView.js';
import { TIER_CONFIG } from '../../../config/tierConfig.js';
import { Markup } from 'telegraf';
import { Session, User, Number as NumberModel, Transaction } from '../../../models/index.js';
import { COUNTRIES, SERVICES } from '../../../utils/constants.js';
import { formatCurrency, maskOTP } from '../../../utils/helpers.js';
import sessionManager from '../../../services/otp/index.js';
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import { applyProfitMargin, IMAGES, KEYBOARDS } from './constants.js';

export const tierMethods = {
        
        
    // ═══════════════════════════════════════════════════════════════════════
    //  CHEAP MODE — NEW TIER-BASED FLOW
    //  Steps: Service Selection → Tier Selection → Country Selection → Auto Purchase
    // ═══════════════════════════════════════════════════════════════════════

    
async handleCheapMode(ctx) {
        const user = ctx.state.user;
        
        try {
            if (!this.tierSelector || !this.countryCatalog) {
                logger.warn('Tier system not available, falling back to legacy CHEAP flow');
                return this._handleCheapModeLegacy(ctx);
            }

            const minEntryPrice = TIER_CONFIG.budget.priceMultiplier * 0.00;
            if (this._getAvailableBalance(user) < minEntryPrice) {
                const message = 
                    `💰 <b>Insufficient Balance</b>\n\n` +
                    `CHEAP mode requires at least ${formatCurrency(minEntryPrice)}.\n` +
                    `Available: ${formatCurrency(this._getAvailableBalance(user))}\n\n` +
                    `Please deposit first.`;
                    
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]);
                
                return this.sendPhotoWithCaption(ctx, IMAGES.cheapMode, message, keyboard, 'HTML');
            }

            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'CHEAP';

            await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode);
            
        } catch (error) {
            logger.error('handleCheapMode failed', { userId: user.userId, error: error.message });
            return this._handleCheapModeLegacy(ctx);
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  LEGACY CHEAP MODE (Fallback)
    // ═══════════════════════════════════════════════════════════════════════

    
async _handleCheapModeLegacy(ctx) {
        const user = ctx.state.user;
        
        try {
            let displayPrice = config.prices?.cheapOtp || 0.00;

            if (this.smsProviderManager) {
                try {
                    const priceInfo = await this.smsProviderManager.getCheapPrice('US', 'Any');
                    if (priceInfo && priceInfo.displayPrice) {
                        displayPrice = priceInfo.displayPrice;
                    }
                } catch (priceError) {
                    logger.warn('Failed to get dynamic CHEAP price, using fallback', { 
                        error: priceError.message 
                    });
                }
            }

            if (this._getAvailableBalance(user) < displayPrice) {
                const message = 
                    `💰 <b>Insufficient Balance</b>\n\n` +
                    `Required: ${formatCurrency(displayPrice)}\n` +
                    `Available: ${formatCurrency(this._getAvailableBalance(user))}\n\n` +
                    `Please deposit first.`;
                    
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]);
                
                return this.sendPhotoWithCaption(ctx, IMAGES.cheapMode, message, keyboard, 'HTML');
            }

            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'CHEAP';
            ctx.session.cheapDisplayPrice = displayPrice;

            await this._showLegacyServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode, displayPrice);
            
        } catch (error) {
            logger.error('Legacy cheap mode failed', { userId: user.userId, error: error.message });
            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'CHEAP';
            await this._showLegacyServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode);
        }
    },

    async handleBundleMode(ctx) {
        const user = ctx.state.user;
        
        if (!user.bundleRemaining || user.bundleRemaining <= 0) {
            return this.handleBuyBundle(ctx);
        }

        if (this._isVipActive(user) && user.vipPhoneNumber) {
            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'BUNDLE';
            ctx.session.useVipNumber = true;
            return this._showLegacyServiceSelection(ctx, 'BUNDLE (VIP Number)', IMAGES.bundleOther);
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'BUNDLE';
        ctx.session.useVipNumber = false;
        await this._showLegacyServiceSelection(ctx, 'BUNDLE', IMAGES.bundleOther);
    },

    async handleVIPMode(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            const message = 
                `👑 <b>VIP Required</b>\n\n` +
                `You need an active VIP subscription.\n\n` +
                `Price: ${formatCurrency(config.prices?.vipSubscription || 5.00)}/month\n` +
                `✅ 50 OTPs per day\n` +
                `⚡ Dedicated number\n` +
                `🚀 Priority routing\n\n` +
                `Upgrade now?`;
                
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            
            return this.sendPhotoWithCaption(ctx, IMAGES.vipFirst, message, keyboard, 'HTML');
        }
        
        if (!this._canUseVip(user)) {
            const message = 
                '⚠️ <b>VIP Daily Limit Reached</b>\n\n' +
                `You've used ${config.limits?.vipDaily || 50}/${config.limits?.vipDaily || 50} VIP OTPs today.\n` +
                'Resets at midnight UTC.\n\n' +
                'Buy bundle OTPs to continue:';
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📦 Buy Bundle OTPs', 'buy_bundle_otp')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, keyboard, 'HTML');
        }
        
        if (!user.vipPhoneNumber) {
            const assignment = await this.assignVipNumber(user.userId, 'US');
            if (!assignment) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.vipOther,
                    '⚠️ <b>Number Assignment Pending</b>\n\nWe\'re setting up your VIP number. Please try again shortly.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry', 'mode_vip')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }
            user.vipPhoneNumber = assignment.phoneNumber;
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        ctx.session.useVipNumber = true;
        await this._showLegacyServiceSelection(ctx, 'VIP', IMAGES.vipOther);
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Service Selection with Search, Popular, Pagination
    //  FIXED: Async calls, shows service names with emojis, no category groups
    // ═══════════════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════
    //  SERVICE SELECTION — Auto-edit with proper fallback
    // ═══════════════════════════════════════════════════════════════════════

    
async showServiceSelection(ctx, mode, imageUrl, displayPrice = null, page = 1) {
        if (!this.serviceCatalog || mode !== 'CHEAP') {
            return this._showLegacyServiceSelection(ctx, mode, imageUrl, displayPrice);
        }

        try {
            let services = [];
            let totalPages = 1;
            let isPopularPage = false;

            if (page === 1) {
                const popular = await this.serviceCatalog.getPopularServices(15);
                services = popular;
                isPopularPage = true;
                
                const allServices = await this.serviceCatalog.getServicesPage(1, 1000);
                const remainingCount = Math.max(0, allServices.pagination.total - 15);
                totalPages = 1 + Math.ceil(remainingCount / 15);
            } else {
                const allPage = page - 1;
                const allServices = await this.serviceCatalog.getServicesPage(allPage, 15);
                services = allServices.services;
                const totalAll = allServices.pagination.total;
                totalPages = 1 + Math.ceil(Math.max(0, totalAll - 15) / 15);
            }

            const priceText = displayPrice ? `\n💰 Starting from ${formatCurrency(displayPrice)}` : '';
            let message = `📱 <b>${mode} Mode</b>${priceText}\n\n`;
            
            if (isPopularPage) {
                message += `🔥 <b>Popular Services</b> (Top 15)\n`;
                message += `<i>Most used worldwide</i>\n\n`;
            } else {
                message += `📋 <b>All Services</b> (A-Z) — Page ${page}/${totalPages}\n\n`;
            }
            
            message += `<i>Select a service:</i>`;

            const buttons = [];
            const serviceEmojis = {
                'WhatsApp': '💬', 'Telegram': '✈️', 'Facebook': '👤', 'Instagram': '📸',
                'Twitter': '🐦', 'TikTok': '🎵', 'Binance': '💰', 'Other': '💧',
                'Gmail': '📧', 'Outlook': '📨', 'Netflix': '🎬', 'Amazon': '📦',
                'PayPal': '💳', 'Snapchat': '👻', 'Discord': '🎮', 'Spotify': '🎧',
                'Uber': '🚗', 'Airbnb': '🏠', 'WeChat': '💬', 'Signal': '🔒',
                'LinkedIn': '💼', 'Tinder': '🔥', 'Google': '🔍', 'Microsoft': '🪟',
                'Apple': '🍎', 'Viber': '📞', 'Line': '📱', 'KakaoTalk': '💬',
                'Imo': '📹', 'Zalo': '💬', 'Badoo': '❤️', 'Yahoo': '📧',
                'Yandex': '🔍', 'Mail.ru': '📧', 'Odnoklassniki': '👥', 'VK': '🔷',
                'Avito': '📰', 'OLX': '📰', 'Alibaba': '📦', 'Taobao': '📦',
                'JD': '📦', 'Weibo': '📱', 'QQ': '💬', 'Baidu': '🔍',
                'DingTalk': '💬', 'Meituan': '🍔', 'Douyin': '🎵', 'Kuaishou': '🎥',
                'Pinduoduo': '🛒', 'Xiaohongshu': '📕', 'Tantan': '❤️', 'Momo': '💬',
                'Hepsiburada': '🛒', 'Trendyol': '🛒', 'N11': '🛒', 'Gittigidiyor': '🛒',
                'Letgo': '📱', 'OfferUp': '📱', 'Mercari': '📦', 'Rakuten': '🛒',
                'Shopee': '🛒', 'Lazada': '🛒', 'Tokopedia': '🛒', 'Bukalapak': '🛒',
                'Flipkart': '🛒', 'Snapdeal': '🛒', 'Myntra': '👕', 'Zomato': '🍔',
                'Swiggy': '🍔', 'Ola': '🚗', 'Grab': '🚗', 'Gojek': '🚗',
                'Bolt': '🚗', 'Careem': '🚗', 'Pathao': '🚗', 'Foodpanda': '🍔',
                'Deliveroo': '🍔', 'UberEats': '🍔', 'DoorDash': '🍔', 'Grubhub': '🍔'
            };

            for (let i = 0; i < services.length; i += 3) {
                const row = services.slice(i, i + 3).map(s => {
                    const emoji = serviceEmojis[s.name] || '📱';
                    const popularMark = s.isGlobalTop ? '🔥' : (s.isPopular ? '⭐' : '');
                    return Markup.button.callback(
                        `${emoji} ${s.name}${popularMark}`,
                        `service_select_${s.name}`
                    );
                });
                buttons.push(row);
            }

            const navRow = [];
            if (page > 1) {
                navRow.push(Markup.button.callback('◀️ Prev', `service_page_${page - 1}`));
            }
            navRow.push(Markup.button.callback('🔍 Search', 'service_search_prompt'));
            if (page < totalPages) {
                navRow.push(Markup.button.callback('Next ▶️', `service_page_${page + 1}`));
            }
            if (navRow.length > 0) buttons.push(navRow);

            if (page === 1 && totalPages > 1) {
                buttons.push([Markup.button.callback('📋 Browse All A-Z', 'service_page_2')]);
            }
            if (mode === 'CHEAP') buttons.push([Markup.button.callback('📱 OTHERS', 'others_menu'), Markup.button.callback('🕘 Recent', 'my_orders')]);
            buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

            const keyboard = Markup.inlineKeyboard(buttons);

            const editSuccess = await this._tryEditMessage(ctx, message, keyboard);
            
            if (!editSuccess) {
                await this._fallbackSendMessage(ctx, message, keyboard, imageUrl);
            }

        } catch (error) {
            logger.error('showServiceSelection failed', { error: error.message, page, stack: error.stack });
            ctx.reply('❌ Error loading services. Please try /otp again.').catch(() => {});
        }
    },

    
/**
 * Try to edit the existing message.
 * Uses editMessageCaption for photos, editMessageText for text messages.
 * Returns true if successful, false if should fallback.
 */
async _tryEditMessage(ctx, message, keyboard) {
    try {
        // Determine if current message has a photo (caption) or is text-only
        const msg = ctx.callbackQuery?.message || ctx.message;
        const hasPhoto = msg?.photo && msg.photo.length > 0;
        
        const options = {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        };

        if (hasPhoto) {
            await ctx.editMessageCaption(message, options);
        } else {
            await ctx.editMessageText(message, options);
        }
        
        return true;
    } catch (error) {
        // Expected errors when edit is not possible:
        // - message not modified (same content)
        // - message is not a photo (for caption)
        // - message to edit not found
        // - message can't be edited
        const isExpectedError = [
            'message is not modified',
            'message to edit not found',
            'there is no caption in the message',
            "message can't be edited",
            'MESSAGE_NOT_MODIFIED',
            'MESSAGE_ID_INVALID',
            ' Bad Request: message is not modified'
        ].some(errMsg => error.message?.includes(errMsg) || error.description?.includes(errMsg));

        if (!isExpectedError) {
            logger.warn('Unexpected edit error', { error: error.message, userId: ctx.from?.id });
        }
        
        return false;
    }
},

/**
 * Fallback: delete old message and send new one.
 */
async _fallbackSendMessage(ctx, message, keyboard, imageUrl) {
    try {
        await ctx.deleteMessage();
    } catch (delErr) {
        // Message already deleted or can't delete — ignore
    }

    try {
        if (imageUrl) {
            await ctx.replyWithPhoto(imageUrl, {
                caption: message,
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        } else {
            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        }
    } catch (sendErr) {
        logger.error('Fallback send failed', { error: sendErr.message, userId: ctx.from?.id });
        // Last resort
        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        }).catch(() => {});
    }
},

    // ═══════════════════════════════════════════════════════════════════════
    //  LEGACY: Old service selection (all services at once)
    // ═══════════════════════════════════════════════════════════════════════

        
async _showLegacyServiceSelection(ctx, mode, imageUrl, displayPrice = null) {
        const priceText = displayPrice ? `\n💰 Starting from ${formatCurrency(displayPrice)}` : '';
        const message = `📱 <b>${mode} Mode</b>${priceText}\n\nChoose the service you need OTP for:`;
        const buttons = [];
        
        // Mode-specific callback prefix
        const callbackPrefix = mode === 'FREE' ? 'free_service_' :
                               mode === 'CHEAP' ? 'cheap_service_' :
                               mode === 'BUNDLE' ? 'bundle_service_' :
                               mode === 'VIP' ? 'vip_service_' :
                               'service_';
        
        for (let i = 0; i < SERVICES.length; i += 3) {
            const row = SERVICES.slice(i, i + 3).map(s => 
                Markup.button.callback(s, `${callbackPrefix}${s}`)
            );
            buttons.push(row);
        }
        
        if (mode === 'CHEAP') buttons.push([Markup.button.callback('📱 OTHERS', 'others_menu'), Markup.button.callback('🕘 Recent', 'my_orders')]);
            buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, imageUrl, message, Markup.inlineKeyboard(buttons), 'HTML');
        },

        

    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Tier Selection (Step 2 of CHEAP flow)
    // ═══════════════════════════════════════════════════════════════════════

    
async showTierSelection(ctx, service) {
        const tierInfos = this.tierSelector.getAllTierInfos();
        
        let message = 
            `📱 <b>${service}</b>\n\n` +
            `Choose Number Quality:\n\n`;

        const buttons = [];

        for (const tier of tierInfos) {
            const emoji = tier.emoji;
            const label = tier.label;
            const badge = tier.badge;
            
            let priceText = '';
            try {
                const baseline = await this.tierSelector.selectOperator(
                    tier.key, 'US', service, { timeoutMs: 5000 }
                ).catch(() => null);
                
                if (baseline?.displayPrice) {
                    priceText = ` — from ${formatCurrency(baseline.displayPrice)}`;
                }
            } catch (e) {
                // Ignore price fetch errors
            }

            const badgeText = badge ? ` [${badge.toUpperCase()}]` : '';
            
            message += `${emoji} <b>${label}</b>${badgeText}\n`;
            message += `   ${tier.description}${priceText}\n\n`;

            buttons.push([Markup.button.callback(
                `${emoji} ${label}${badgeText}${priceText}`,
                `tier_${tier.key}`
            )]);
        }

        buttons.push([Markup.button.callback('🔙 Back to Services', 'tier_back_service')]);

        await this.sendPhotoWithCaption(ctx, IMAGES.cheapMode, message, Markup.inlineKeyboard(buttons), 'HTML');
    },

    async handleTierSelect(ctx, tierKey) {
        const service = ctx.session?.otpService;
        
        if (!service) {
            return ctx.answerCbQuery('❌ Session expired. Start over.', { show_alert: true });
        }

        const tierInfo = this.tierSelector.getTierInfo(tierKey);
        if (!tierInfo) {
            return ctx.answerCbQuery('❌ Invalid tier selected');
        }

        ctx.session = ctx.session || {};
        ctx.session.selectedTier = tierKey;

        await ctx.answerCbQuery(`✅ ${tierInfo.label} selected`);

        await this.showTierCountrySelection(ctx, service, tierKey, 1);
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Country Selection with Tier-Aware Live Pricing (Step 3)
    // ═════
            

    
async showTierCountrySelection(ctx, service, tierKey, page = 1, searchQuery = null) {
        const tierInfo = this.tierSelector.getTierInfo(tierKey);
        
        try {
            // Try to edit loading message
            try {
                await ctx.editMessageCaption(
                    `🌍 <b>Loading ${tierInfo.emoji} ${tierInfo.label} countries...</b>`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                // Not a caption message or can't edit
            }

            const result = await this.countryCatalog.getCountriesForService(
                service, 
                tierKey, 
                { 
                    page, 
                    perPage: 12,
                    searchQuery,
                    topOnly: false
                }
            );

            if (!result.countries || result.countries.length === 0) {
                const noStockMessage = 
                    `⚠️ <b>No ${tierInfo.label} Numbers Available</b>\n\n` +
                    `No ${tierInfo.label.toLowerCase()} numbers available for <b>${service}</b> currently.\n\n` +
                    `Try:\n` +
                    `• Another tier\n` +
                    `• Another service\n` +
                    `• Search for a specific country`;

                const fallbackButtons = [];
                const otherTiers = this.tierSelector.getAllTierInfos().filter(t => t.key !== tierKey);
                for (const t of otherTiers) {
                    fallbackButtons.push([Markup.button.callback(
                        `${t.emoji} Try ${t.label}`,
                        `tier_${t.key}`
                    )]);
                }
                fallbackButtons.push([Markup.button.callback('🔙 Back to Tiers', 'tier_back_tier')]);
                fallbackButtons.push([Markup.button.callback('🔙 Main Menu', 'menu')]);

                return this.sendPhotoWithCaption(
                    ctx, IMAGES.otpFailed, noStockMessage, 
                    Markup.inlineKeyboard(fallbackButtons), 'HTML'
                );
            }

            let message = 
                `🌍 <b>Select Country for ${service}</b>\n` +
                `${tierInfo.emoji} <b>${tierInfo.label} Tier</b>\n\n`;

            if (searchQuery) {
                message += `🔍 Search: "${searchQuery}"\n`;
            }

            message += `Showing ${result.countries.length} countries (cheapest first):\n\n`;

            const buttons = [];
            const COLUMNS = 3;

            for (let i = 0; i < result.countries.length; i += COLUMNS) {
                const row = result.countries.slice(i, i + COLUMNS).map(country => {
                    const flag = country.flag || isoToFlag(country.code);
                    // FIXED: Apply profit margin to display price
                    const rawPrice = country.displayPrice || country.price;
                    const displayPrice = rawPrice ? applyProfitMargin(rawPrice) : null;
                    const priceText = displayPrice 
                        ? ` $${displayPrice.toFixed(2)}`
                        : (country.price ? ` ~$${applyProfitMargin(country.price).toFixed(2)}` : '');
                        const stockText = country.stock > 0 ? ` ✅` : ' ❌';
                    
                    const label = `${flag} ${country.code}${priceText}${stockText}`;
                    
                    return Markup.button.callback(label, `country_select_${country.code}`);
                });
                buttons.push(row);
            }

            const navRow = [];
            if (result.pagination.hasPrev) {
                navRow.push(Markup.button.callback('◀️ Prev', `country_page_${page - 1}`));
            }
            navRow.push(Markup.button.callback('🔍 Search', 'country_search_prompt'));
            if (result.pagination.hasNext) {
                navRow.push(Markup.button.callback('Next ▶️', `country_page_${page + 1}`));
            }
            if (navRow.length > 0) buttons.push(navRow);

            buttons.push([Markup.button.callback('🔙 Back to Tiers', 'tier_back_tier')]);
            buttons.push([Markup.button.callback('🔙 Main Menu', 'menu')]);

            const keyboard = Markup.inlineKeyboard(buttons);

            // FIXED: Robust auto-edit
            const editSuccess = await this._tryEditMessage(ctx, message, keyboard);
            
            if (!editSuccess) {
                await this._fallbackSendMessage(ctx, message, keyboard, IMAGES.countrySelect);
            }

        } catch (error) {
            logger.error('Tier country selection failed', { 
                service, tierKey, page, error: error.message 
            });
            
            return this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed,
                `❌ <b>Error Loading Countries</b>\n\n${error.message}\n\nPlease try again.`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Retry', `tier_${tierKey}`)],
                    [Markup.button.callback('🔙 Back', 'tier_back_tier')]
                ]),
                'HTML'
            );
        }
        },

                            async handleTierCountrySelect(ctx, countryCode) {
    const userId = ctx.from.id.toString();
    const service = ctx.session?.otpService;
    const tierKey = ctx.session?.selectedTier;
    
    // FIXED: Check if user selected a fallback operator from the alternatives list
    const fallbackOperator = ctx.session?.fallbackOperator;

    if (!service || !tierKey) {
        return ctx.answerCbQuery('❌ Session expired. Start over.', { show_alert: true });
    }

    await ctx.answerCbQuery('⏳ Purchasing number...');

    let loadingMsg = null;
    let selection = null;
    let attemptedOperators = [];
    
    try {
        loadingMsg = await ctx.reply('⏳ Finding best operator and purchasing number...');

        // FIXED: If fallback operator was selected by user, use it directly
        // instead of calling selectOperator() again which would return the same failed operator
        if (fallbackOperator) {
            logger.info('Using fallback operator from session', {
                userId,
                fallbackOperator,
                tierKey,
                service,
                country: countryCode
            });
            
            // Get fallback operators list and find the selected one
            const fallbackOps = await this.tierSelector.getFallbackOperators(
                tierKey, countryCode, service, null
            );
            
            selection = fallbackOps.find(op => op.operator === fallbackOperator);
            
            if (!selection) {
                // Fallback operator no longer available, clear and error
                delete ctx.session.fallbackOperator;
                throw new Error('FALLBACK_EXPIRED: Selected operator no longer available');
            }
        } else {
            // Normal flow: select best operator from tier.
            // CORE REQUIREMENT #5: this is a purchase-time selection, not a menu
            // display — use live (uncached) inventory, since stock can change
            // between the user opening the country list and pressing buy.
            selection = await this.tierSelector.selectOperator(tierKey, countryCode, service, {
                timeoutMs: 15000,
                skipCache: true
            });
        }

        logger.info('Tier operator selected', {
            userId,
            tier: tierKey,
            service,
            country: countryCode,
            operator: selection.operator,
            price: selection.price,
            displayPrice: selection.displayPrice,
            stock: selection.stock,
            score: selection.score,
            isFallback: !!fallbackOperator
        });

        const user = ctx.state.user;
        if (this._getAvailableBalance(user) < selection.displayPrice) {
            try {
                if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
            } catch (delErr) {}

            const message = 
                `💰 <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(selection.displayPrice)}\n` +
                `Available: ${formatCurrency(this._getAvailableBalance(user))}\n\n` +
                `Price varies by operator quality. Please deposit more.`;
                
            return this.sendPhotoWithCaption(
                ctx, IMAGES.cheapMode, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', `tier_${tierKey}`)]
                ]), 'HTML'
            );
        }

        const cheapProvider = this.smsProviderManager?.getProvider('CHEAP_PANEL');
        if (!cheapProvider) {
            throw new Error('CHEAP_PROVIDER_NOT_AVAILABLE');
                                                                   }

        // ═══════════════════════════════════════════════════════════════════
        //  CORE REQUIREMENT #4/#5: AUTOMATIC IN-REQUEST FALLBACK
        //  Do not tell the user "no free number" just because the single
        //  best-scored operator failed at the exact moment of purchase (it may
        //  have sold out between menu display and button press). Silently try
        //  a few more eligible operators in the same tier before ever falling
        //  back to asking the user to pick manually. No balance is touched
        //  until one of these attempts actually succeeds, so retrying here is
        //  free of double-charge risk (see SessionManager._handleFinances,
        //  which only runs once, after a successful getNumber()).
        // ═══════════════════════════════════════════════════════════════════
        const MAX_AUTO_FALLBACK_ATTEMPTS = 3;
        let cheapResult = null;
        let lastAttemptError = null;

        try {
            attemptedOperators.push(selection.operator);
            cheapResult = await cheapProvider.getNumber(countryCode, service, selection.operator);
        } catch (firstError) {
            lastAttemptError = firstError;
            const isRecoverable = /NO_NUMBERS|NOT_AVAILABLE|OUT_OF_STOCK/i.test(firstError.message || '');

            if (isRecoverable) {
                logger.warn('Primary operator failed at purchase time, attempting automatic fallback', {
                    userId, tierKey, countryCode, service,
                    failedOperator: selection.operator,
                    error: firstError.message
                });

                // Try a few more cached candidates first, then one live-refreshed
                // batch, before giving up automatically.
                for (const forceRefresh of [false, true]) {
                    if (cheapResult) break;

                    const candidates = await this.tierSelector.getFallbackOperators(
                        tierKey, countryCode, service, selection.operator, { forceRefresh }
                    ).catch(() => []);

                    for (const candidate of candidates) {
                        if (cheapResult || attemptedOperators.includes(candidate.operator)) continue;
                        if (attemptedOperators.length >= MAX_AUTO_FALLBACK_ATTEMPTS) break;

                        // Re-check balance against this candidate's own price —
                        // different operators in the tier can be priced differently.
                        if (this._getAvailableBalance(user) < (candidate.displayPrice ?? candidate.price ?? 0)) {
                            continue;
                        }

                        attemptedOperators.push(candidate.operator);
                        try {
                            logger.info('Auto-fallback attempting operator', {
                                userId, tierKey, countryCode, service, operator: candidate.operator
                            });
                            cheapResult = await cheapProvider.getNumber(countryCode, service, candidate.operator);
                            selection = candidate; // so downstream messaging reflects the operator actually purchased
                        } catch (fallbackErr) {
                            lastAttemptError = fallbackErr;
                            if (!/NO_NUMBERS|NOT_AVAILABLE|OUT_OF_STOCK/i.test(fallbackErr.message || '')) {
                                throw fallbackErr; // non-recoverable — stop retrying, surface immediately
                            }
                            logger.warn('Auto-fallback operator also failed', {
                                userId, operator: candidate.operator, error: fallbackErr.message
                            });
                        }
                    }
                }
            }

            if (!cheapResult) {
                // Automatic fallback exhausted — fall through to the existing
                // manual "choose alternative operator" UI in the catch block below.
                throw lastAttemptError || firstError;
            }
        }

        try {
            if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
        } catch (delErr) {
            logger.debug('Failed to delete loading message', { error: delErr.message });
        }

                // FIXED: Pass operator and routedProvider to session
        const session = await sessionManager.createSessionWithNumber(
            userId, 
            'CHEAP', 
            service, 
            countryCode,
            cheapResult.phoneNumber,
            cheapResult.provider,
            cheapResult.providerNumberId,
            cheapResult.displayCost || selection.displayPrice,
            selection.operator,           // ← FIXED: Pass selected operator
            selection.providerKey         // ← FIXED: Pass provider key (5sim/smspool/etc)
        );
            // ═══════════════════════════════════════════════════════════════════════
        //  AUTO-OTP: Start polling immediately after purchase
        //  This checks every 5 seconds and auto-sends OTP when received
        // ═══════════════════════════════════════════════════════════════════════
        if (this.sessionManager && session?.sessionId) {
            this.startAutoOTPCheck(session.sessionId, ctx, 5000);
            logger.info('Auto OTP polling started', { 
                sessionId: session.sessionId, 
                userId,
                interval: '5s' 
            });
        }

    
        // FIXED: Store session info for auto-OTP delivery
        ctx.session.tierOperator = selection.operator;
        ctx.session.tierKey = tierKey;
        ctx.session.selectedCountry = countryCode;
        
        // FIXED: Clear fallback operator after successful purchase
        delete ctx.session.fallbackOperator;

        const message = sessionStartedText({ mode: `CHEAP · ${tierKey.toUpperCase()}`, number: session.number, service, price: session.cost, timeoutAt: session.timeoutAt, extra: [`🏢 Operator: <code>${selection.operator}</code>`, `⭐ Quality score: ${selection.score.toFixed(2)}`], note: 'Your balance is reserved and only charged when your code arrives. Cancel any time for a full refund.' });

        const keyboard = KEYBOARDS.otpActions(session.sessionId, session.number);
        const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

        // FIXED: Store message info for auto-OTP delivery editing
        if (sentMessage?.message_id) {
            ctx.session.lastOtpMessageId = sentMessage.message_id;
            ctx.session.lastOtpChatId = ctx.chat?.id;
            
            await this._scheduleTimeoutNotification(
                userId, session.sessionId, sentMessage.message_id, session.timeoutAt
            );
        }

    } catch (error) {
        try {
            if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
        } catch (delErr) {}

        logger.error('Tier country purchase failed', {
            userId, tierKey, countryCode, service, error: error.message
        });

        // FIXED: Clear fallback operator on any error so next attempt starts fresh
        delete ctx.session.fallbackOperator;

        if (error.message?.includes('NO_NUMBERS') || error.message?.includes('NOT_AVAILABLE') || error.message?.includes('FALLBACK_EXPIRED')) {
            try {
                // Exclude the primary failed operator AND every operator the
                // automatic in-request fallback above already tried (and failed),
                // so we don't show the user an alternative we already know is empty.
                const failedOperator = selection?.operator || fallbackOperator;
                const triedSet = new Set([failedOperator, ...attemptedOperators].filter(Boolean));

                const fallbackOps = (await this.tierSelector.getFallbackOperators(
                    tierKey, countryCode, service, failedOperator, { forceRefresh: true }
                )).filter(op => !triedSet.has(op.operator));
                
                if (fallbackOps && fallbackOps.length > 0) {
                    const message = 
                        `⚠️ <b>Primary Operator Unavailable</b>\n\n` +
                        `Operator <code>${failedOperator || 'unknown'}</code> ran out of stock.\n\n` +
                        `Available alternatives in ${tierKey} tier:`;

                    const buttons = fallbackOps.slice(0, 3).map(op => [
                        Markup.button.callback(
                            `🏢 ${op.operator} — ${formatCurrency(op.displayPrice || op.price)}`,
                            `tier_fallback_${op.operator}`
                        )
                    ]);

                    buttons.push([Markup.button.callback('🔙 Back to Countries', `tier_${tierKey}`)]);
                    
                    return this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, message, Markup.inlineKeyboard(buttons), 'HTML');
                }
            } catch (fallbackError) {
                logger.error('Fallback display failed', { error: fallbackError.message });
            }
        }

        const errorMessages = {
            NO_NUMBERS: '❌ No numbers available for this operator. Try another country or tier.',
            NO_BALANCE: '💰 Provider balance insufficient. Contact support.',
            NOT_AVAILABLE: '❌ Service not available in this country for selected tier.',
            TIMEOUT: '⏱ Operator selection timed out. Please try again.',
            INSUFFICIENT_BALANCE: '💰 Your balance is too low for this selection.',
            FALLBACK_EXPIRED: '❌ Selected operator is no longer available. Please try again.'
        };

        const errorKey = Object.keys(errorMessages).find(key => error.message?.includes(key));
        const displayMessage = errorMessages[errorKey] || `❌ Error: ${error.message}`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.otpFailed, 
            displayMessage,
            Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Retry', `tier_country_${countryCode}`)],
                [Markup.button.callback('🔙 Back to Countries', `tier_${tierKey}`)],
                [Markup.button.callback('📞 Support', 'contact_support')]
            ]), 'HTML'
        );
    }
            },

                
            
    /**
     * Start automatic OTP polling for a session
     * Single photo message with bold box and copyable code button
     */
    
startAutoOTPCheck(sessionId, ctx, intervalMs = 5000) {
let checkCount = 0;
const maxChecks = 36;

const checkInterval = setInterval(async () => {
    checkCount++;

    try {
        const status = await this.sessionManager.checkSessionStatus(sessionId);

        if (status.status === 'RECEIVED' && status.otpCode) {
            clearInterval(checkInterval);

            const otpCode = status.otpCode;

            const caption = `

🔓 <b>OTP RECEIVED</b>

📱 <b>Number:</b>
<code>${status.number}</code>

🎯 <b>Service:</b> ${status.service}
⏱️ <b>Time:</b> ${checkCount * 5}s
━━━━━━━━━━━━━━━
🔐 <b>OTP CODE</b>

<code>${otpCode}</code>
━━━━━━━━━━━━━━━
⚠️ Do not share this code with anyone.
`.trim();

            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: `🔐 Copy OTP: ${otpCode}`,
                            copy_text: {
                                text: otpCode
                            }
                        }
                    ],
                    [
                        {
                            text: '📱 New OTP',
                            callback_data: 'mode_cheap'
                        },
                        {
                            text: '🔙 Menu',
                            callback_data: 'menu'
                        }
                    ]
                ]
            };

            await ctx.telegram.sendPhoto(
                ctx.from.id,
                IMAGES.otpRequested,
                {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );

            logger.info('Auto OTP delivered', {
                sessionId,
                userId: ctx.from.id
            });

            return;
        }

        if (!['WAITING', 'CHECKING'].includes(status.status)) {
            clearInterval(checkInterval);
            return;
        }

        

    } catch (error) {
        logger.error('Auto OTP check error', {
            sessionId,
            error: error.message
        });
    }
}, intervalMs);

    },

           
        async handleCopyOTP(ctx) {
        const otpCode = ctx.match[1];
        
        try {
            // Show alert popup with code — user can long-press to copy
            await ctx.answerCbQuery(`📋 ${otpCode}`, { show_alert: true });
            
            // Also send a separate copyable message that auto-deletes
            const copyMsg = await ctx.telegram.sendMessage(ctx.from.id, `<code>${otpCode}</code>`, {
                parse_mode: 'HTML'
            });
            
            // Auto-delete after 30 seconds to keep chat clean
            setTimeout(async () => {
                try {
                    await ctx.telegram.deleteMessage(ctx.from.id, copyMsg.message_id);
                } catch (e) {}
            }, 30000);
            
            logger.debug('OTP copy triggered', { userId: ctx.from.id });
        } catch (error) {
            logger.error('Copy OTP failed', { error: error.message });
        }
        },

    
    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Pagination Handlers
    // ═══════════════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════
    //  SERVICE PAGE NAVIGATION — Edit existing message
    // ═══════════════════════════════════════════════════════════════════════

    
async handleTierServicePage(ctx, page) {
        try {
            await ctx.answerCbQuery(`Page ${page}`);
            
            // Just call showServiceSelection which handles editing
            await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode, null, page);
            
        } catch (error) {
            logger.error('handleTierServicePage failed', { error: error.message, page });
            ctx.answerCbQuery('❌ Error loading page').catch(() => {});
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY PAGE NAVIGATION — Edit existing message
    // ═══════════════════════════════════════════════════════════════════════

    
async handleTierCountryPage(ctx, page) {
        const service = ctx.session?.otpService;
        const tierKey = ctx.session?.selectedTier;

        if (!service || !tierKey) {
            return ctx.answerCbQuery('❌ Session expired', { show_alert: true });
        }

        try {
            await ctx.answerCbQuery(`Page ${page}`);
            await this.showTierCountrySelection(ctx, service, tierKey, page);
        } catch (error) {
            logger.error('handleTierCountryPage failed', { error: error.message, page, service, tierKey });
            ctx.answerCbQuery('❌ Error loading page').catch(() => {});
        }
    },

        
    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Search Handlers
    //  FIXED: Async calls to searchServices()
    // ═══════════════════════════════════════════════════════════════════════
    
async handleTierSearchService(ctx, query) {
        if (!query || query.trim().length < 2) {
            return ctx.reply('❌ Please enter at least 2 characters to search.');
        }

        const results = await this.serviceCatalog.searchServices(query);
        
        if (results.length === 0) {
            return ctx.reply(
                `❌ No services found for "${query}"\n\nTry another search term.`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔍 Search Again', 'service_search_prompt')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ])
            );
        }

        let message = `🔍 <b>Search Results for "${query}"</b>\n\nFound ${results.length} services:\n\n`;
        const buttons = [];

        const serviceEmojis = {
            'WhatsApp': '💬', 'Telegram': '✈️', 'Facebook': '👤', 'Instagram': '📸',
            'Twitter': '🐦', 'TikTok': '🎵', 'Binance': '💰', 'Coinbase': '₿',
            'Gmail': '📧', 'Outlook': '📨', 'Netflix': '🎬', 'Amazon': '📦',
            'PayPal': '💳', 'Snapchat': '👻', 'Discord': '🎮', 'Spotify': '🎧',
            'Uber': '🚗', 'Airbnb': '🏠', 'WeChat': '💬', 'Signal': '🔒',
            'LinkedIn': '💼', 'Tinder': '🔥', 'Google': '🔍', 'Microsoft': '🪟',
            'Apple': '🍎', 'Viber': '📞', 'Line': '📱', 'KakaoTalk': '💬',
            'Imo': '📹', 'Zalo': '💬', 'Badoo': '❤️', 'Other': '💧'
        };

        // 3 columns
        for (let i = 0; i < results.length && i < 15; i += 3) {
            const row = results.slice(i, i + 3).map(r => {
                const emoji = serviceEmojis[r.name] || '📱';
                return Markup.button.callback(
                    `${emoji} ${r.name}`,
                    `service_select_${r.name}`
                );
            });
            buttons.push(row);
        }

        buttons.push([Markup.button.callback('🔍 New Search', 'service_search_prompt')]);
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

        // Try to edit, fallback to reply
        try {
            await ctx.editMessageCaption(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
        } catch (e) {
            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
        }
                            },

        
    

    async handleTierSearchCountry(ctx, query) {
        const service = ctx.session?.otpService;
        const tierKey = ctx.session?.selectedTier;

        if (!service || !tierKey) {
            return ctx.reply('❌ Session expired. Please start over with /otp');
        }

        // countryCatalog.searchCountries is synchronous (returns array)
        const matches = this.countryCatalog.searchCountries(query);
        
        if (matches.length === 0) {
            return ctx.reply(
                `❌ No countries found for "${query}"\n\nTry country name or ISO code (e.g., US, UK).`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔍 Search Again', 'country_search_prompt')],
                    [Markup.button.callback('🔙 Back', `tier_${tierKey}`)]
                ])
            );
        }

        await this.showTierCountrySelection(ctx, service, tierKey, 1, query);
    },
                // ═══════════════════════════════════════════════════════════════════════
    //  SERVICE & COUNTRY SELECTION
    //  FIXED: Uses dynamic catalog, no hardcoded SERVICES/COUNTRIES
    // ═══════════════════════════════════════════════════════════════════════
          /**
     * Check if a service exists in dynamic catalog
     * FIXED: Added type guard to prevent non-string inputs
     */
    
async hasService(serviceName) {
        await this._ensureLoaded();
        
        // FIXED: Type guard — ensure serviceName is a string
        if (!serviceName || typeof serviceName !== 'string') {
            logger.warn('hasService called with invalid type', { 
                serviceName, 
                type: typeof serviceName 
            });
            return false;
        }
        
        return this._serviceMap.has(serviceName.toLowerCase());
    },

        
            async handleServiceSelect(ctx, serviceName = null) {
        // FIXED: Ensure serviceName is a string
        let service = serviceName;
        
        if (!service && ctx.message?.text) {
            service = ctx.message.text.trim();
        }
        
        // Guard against non-string inputs (function, object, number, etc.)
        if (!service || typeof service !== 'string') {
            logger.warn('handleServiceSelect: invalid service input', { 
                service, 
                type: typeof service,
                serviceName,
                match: ctx.match?.[1],
                matchType: typeof ctx.match
            });
            return ctx.answerCbQuery('❌ Invalid service').catch(() => {});
        }
        
        const isValid = await this.serviceCatalog.hasService(service);
        if (!isValid) {
            logger.warn('Invalid service selected', { service });
            return ctx.answerCbQuery('❌ Invalid service').catch(() => {});
        }
        
        ctx.session = ctx.session || {};
        ctx.session.otpService = service;
        
        const mode = ctx.session?.otpMode;

        if (mode === 'CHEAP' && this.tierSelector) {
            return this.showTierSelection(ctx, service);
        }

        if (mode === 'CHEAP') {
            return this._showCheapCountrySelectionLegacy(ctx, service);
        }
        
        // For non-CHEAP modes
        const message = `🌍 <b>Select Country</b>\n\nChoose number country for <b>${service}</b>:`;
        
        const availableCountries = await this.countryCatalog.getCountriesForService(service, 'standard', {
            topOnly: true,
            perPage: 20
        });
        
        const buttons = availableCountries.countries.map(c => [
            Markup.button.callback(
                `${c.flag} ${c.name}${c.displayPrice ? ` (${formatCurrency(c.displayPrice)})` : ''}`, 
                `country_select_${c.code}`
            )
        ]);
        
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, IMAGES.countrySelect, message, Markup.inlineKeyboard(buttons), 'HTML');
            },

        
        
        
                                                                                                      
        /**
     * Legacy country selection with CHEAP provider prices.
     * FIXED: Uses dynamic country catalog as fallback instead of hardcoded COUNTRIES
     * 
     * @param {Object} ctx - Telegraf context
     * @param {string} service - Service code (e.g., 'wa', 'ig')
     * @returns {Promise<void>}
     */
    
async _showCheapCountrySelectionLegacy(ctx, service) {
        const userId = ctx.from?.id?.toString();
        if (!userId) {
            logger.error('Missing user ID in country selection');
            return ctx.reply('❌ Authentication error. Please try /start').catch(() => {});
        }

        let loadingMsg = null;
        
        try {
            loadingMsg = await ctx.reply('🌍 Fetching available countries...');
            
            if (!this.smsProviderManager) {
                throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
            }

            const countriesResult = await this.smsProviderManager.getCheapCountries(service);
            
            if (!countriesResult || countriesResult.length === 0) {
                await this._safeDeleteMessage(ctx, loadingMsg);
                
                return this.sendPhotoWithCaption(
                    ctx, 
                    IMAGES.otpFailed,
                    `❌ <b>No Countries Available</b>\n\nNo countries have stock for <b>${service}</b> right now.\n\nTry another service or check back later.`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Another Service', 'menu')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }

            // Fetch prices in parallel with concurrency limit
            const countriesWithPrices = await this._fetchPricesParallel(
                countriesResult.slice(0, 20), 
                service
            );

            // Sort by display price ascending
            countriesWithPrices.sort((a, b) => (a.displayPrice ?? Infinity) - (b.displayPrice ?? Infinity));

            await this._safeDeleteMessage(ctx, loadingMsg);

            const message = `🌍 <b>Select Country for ${service}</b>\n\nPrices include service fee. Cheapest shown first:`;
            const buttons = this._buildCountryButtons(countriesWithPrices);
            buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
            
            await this.sendPhotoWithCaption(
                ctx, 
                IMAGES.countrySelect, 
                message, 
                Markup.inlineKeyboard(buttons), 
                'HTML'
            );

        } catch (error) {
            await this._safeDeleteMessage(ctx, loadingMsg);

            logger.error('Failed to fetch CHEAP countries', { userId, service, error: error.message });
            
            // FIXED: Use dynamic country catalog fallback instead of hardcoded COUNTRIES
            const fallbackCountries = await this.countryCatalog.getCountriesForService(service, 'standard', {
                topOnly: true,
                perPage: 20
            });

            const message = `🌍 <b>Select Country</b>\n\n⚠️ Live prices unavailable. Showing available countries for <b>${service}</b>:`;
            
            const buttons = fallbackCountries.countries.map(c => [
                Markup.button.callback(
                    `${c.flag} ${c.name}${c.displayPrice ? ` (${formatCurrency(c.displayPrice)})` : ''}`, 
                    `country_${c.code}`
                )
            ]);
            
            buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
            
            await this.sendPhotoWithCaption(
                ctx, 
                IMAGES.countrySelect, 
                message, 
                Markup.inlineKeyboard(buttons), 
                'HTML'
            );
        }
    },

    /**
     * Fetch prices in parallel with error resilience.
     * @private
     */
    
async _fetchPricesParallel(countries, service) {
        const pricePromises = countries.map(async (country) => {
            try {
                const priceInfo = await this.smsProviderManager.getCheapPrice(country.code, service);
                return {
                    ...country,
                    simPrice: priceInfo.simPrice,
                    displayPrice: priceInfo.displayPrice,
                    stock: priceInfo.stock
                };
            } catch (priceErr) {
                return {
                    ...country,
                    simPrice: null,
                    displayPrice: null,
                    stock: country.stock || 0
                };
            }
        });

        return Promise.all(pricePromises);
    },

    /**
     * Build inline keyboard rows for country selection.
     * @private
     */
    
_buildCountryButtons(countriesWithPrices) {
        const buttons = [];
        
        for (let i = 0; i < countriesWithPrices.length; i += 2) {
            const row = countriesWithPrices.slice(i, i + 2).map(c => {
                const priceText = c.displayPrice 
                    ? ` $${c.displayPrice.toFixed(2)}`
                    : (c.simPrice ? ` ~$${(c.simPrice + 0.20).toFixed(2)}` : '');
                const stockText = c.stock > 5 ? '' : ` (${c.stock} left)`;
                
                return Markup.button.callback(
                    `${this._getFlag(c.code)} ${c.name}${priceText}${stockText}`,
                    `country_${c.code}`
                );
            });
            buttons.push(row);
        }

        return buttons;
    },

        
    /**
     * Get emoji flag for country code.
     * FIXED: Uses isoToFlag utility instead of hardcoded map
     * @private
     */
    
_getFlag(code) {
        // Use the same utility as CountryCatalog for consistency
        if (!code || typeof code !== 'string' || code.length !== 2) return '🌍';
        const cc = code.toUpperCase();
        const OFFSET = 127397;
        try {
            return (
                String.fromCodePoint(cc.charCodeAt(0) + OFFSET) +
                String.fromCodePoint(cc.charCodeAt(1) + OFFSET)
            );
        } catch {
            return '🌍';
        }
    },

        
    /**
     * Get popular services, with global top 15 first, then config, then A-Z backfill
     * FIXED: Prioritizes actually popular services (WhatsApp, Telegram, etc.)
     */
    
async getPopularServices(minCount = 15) {
        await this._ensureLoaded();

        if (this._allServices.size === 0) {
            return [];
        }

        const result = [];
        const added = new Set();

        // FIXED: Hardcoded global top 15 most popular services worldwide
        const GLOBAL_TOP_15 = [
            'WhatsApp', 'Telegram', 'Facebook', 'Instagram', 'Twitter',
            'TikTok', 'Gmail', 'Google', 'Netflix', 'Amazon',
            'PayPal', 'Snapchat', 'Discord', 'Spotify', 'Uber'
        ];

        // Step 1: Add global top 15 that exist in catalog
        for (const name of GLOBAL_TOP_15) {
            const normalized = name.toLowerCase();
            if (this._serviceMap.has(normalized)) {
                const displayName = this._serviceMap.get(normalized);
                if (!added.has(displayName)) {
                    result.push({
                        name: displayName,
                        category: this._getServiceCategory(displayName),
                        isPopular: true,
                        isGlobalTop: true
                    });
                    added.add(displayName);
                }
            }
        }

        // Step 2: Add from POPULAR_SERVICES config (excluding already added)
        for (const name of POPULAR_SERVICES) {
            if (added.size >= minCount) break;
            const normalized = name.toLowerCase();
            if (this._serviceMap.has(normalized)) {
                const displayName = this._serviceMap.get(normalized);
                if (!added.has(displayName)) {
                    result.push({
                        name: displayName,
                        category: this._getServiceCategory(displayName),
                        isPopular: true,
                        isGlobalTop: false
                    });
                    added.add(displayName);
                }
            }
        }

        // Step 3: Backfill from catalog A-Z until minCount reached
        const needed = minCount - result.length;
        if (needed > 0) {
            const remaining = Array.from(this._allServices)
                .filter(s => !added.has(s))
                .sort((a, b) => a.localeCompare(b)); // A-Z sort

            for (const name of remaining.slice(0, needed)) {
                result.push({
                    name,
                    category: this._getServiceCategory(name),
                    isPopular: false,
                    isGlobalTop: false
                });
                added.add(name);
            }
        }

        logger.debug('Popular services', {
            globalTop: result.filter(s => s.isGlobalTop).length,
            configPopular: result.filter(s => s.isPopular && !s.isGlobalTop).length,
            backfill: result.filter(s => !s.isPopular).length,
            total: result.length
        });

        return result;
    }
};

export default tierMethods;
            
