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

        const tierI
