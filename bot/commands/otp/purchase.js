// bot/commands/otp/purchase.js — Country selection → number purchase, OTP check/reveal, my number, quick buy
// Mixed into OTPCommands.prototype by bot/commands/otp.js (bodies unchanged: `this` is the OTPCommands instance).
import { Markup } from 'telegraf';
import { Session, User, Number as NumberModel, Transaction } from '../../../models/index.js';
import { formatCurrency, maskOTP } from '../../../utils/helpers.js';
import sessionManager from '../../../services/otp/index.js';
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import { IMAGES, KEYBOARDS } from './constants.js';

export const purchaseMethods = {
             
    async handleViewMyNumber(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return this.sendPhotoWithCaption(
                ctx, IMAGES.vipFirst,
                '❌ <b>Not a VIP User</b>\n\nYou need an active VIP subscription to have a dedicated number.\n\nUpgrade to VIP now?',
                Markup.inlineKeyboard([
                    [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );
        }

        if (!user.vipPhoneNumber) {
            const assignment = await this.assignVipNumber(user.userId, 'US');
            if (!assignment) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.vipFirst,
                    '⚠️ <b>Number Assignment Pending</b>\n\nWe\'re assigning your VIP number. Please try again in a moment.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry', 'view_my_number')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }
            user.vipPhoneNumber = assignment.phoneNumber;
            user.vipNumberId = assignment.numberId;
            user.vipProvider = assignment.provider;
        }

        const daysLeft = this._vipDaysLeft(user);
        const vipRemaining = this._vipRemaining(user);
        const bundleRemaining = user.bundleRemaining || 0;

        const message = 
            `📱 <b>Your VIP Number</b>\n\n` +
            `📞 <b>Number:</b> <code>${user.vipPhoneNumber}</code>\n` +
            `🏢 <b>Provider:</b> ${user.vipProvider}\n` +
            `🌍 <b>Country:</b> ${user.vipNumberCountry || 'US'}\n\n` +
            `⏰ <b>VIP Status</b>\n` +
            `• Expires: <code>${user.vipExpiry ? new Date(user.vipExpiry).toLocaleDateString() : 'N/A'}</code>\n` +
            `• Days Left: <code>${daysLeft}</code> day${daysLeft !== 1 ? 's' : ''}\n` +
            `• Daily OTPs: <code>${vipRemaining}</code> remaining today\n\n` +
            `📦 <b>Bundle Credits</b>\n` +
            `• Available: <code>${bundleRemaining}</code> OTPs\n\n` +
            `<i>Your number is dedicated to you. Use it for any service.</i>`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔢 Request OTP', 'request_otp_vip')],
            [Markup.button.callback('📦 Buy More OTPs', 'buy_bundle_otp')],
            [Markup.button.callback('❌ Cancel VIP', 'cancel_vip_subscription')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.myNumber, message, keyboard, 'HTML');
    },

    
    async handleMyNumberCommand(ctx) {
        return this.handleViewMyNumber(ctx);
    },

        
                            
// ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 3: Core Purchase Logic, Polling, Check OTP, Cancel
//  INTEGRATED: Tier-based operator selection for CHEAP mode
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTED — ACQUIRE NUMBER (CORE LOGIC)
    // ═══════════════════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTED — ACQUIRE NUMBER (CORE LOGIC)
    //  MERGED: Handles both tier-based and legacy flows
    // ═══════════════════════════════════════════════════════════════════════

    
async handleCountrySelect(ctx, countryCode = null) {
        const country = countryCode || ctx.match?.[1];
        const userId = ctx.from?.id?.toString();
        const mode = ctx.session?.otpMode;
        const service = ctx.session?.otpService;
        const useVipNumber = ctx.session?.useVipNumber;

        // ── Validation ──
        if (!country) {
            return ctx.answerCbQuery('❌ Invalid country').catch(() => {});
        }

        if (!mode || !service) {
            return this.sendPhotoWithCaption(ctx, IMAGES.default, 
                '❌ Session expired. Please start over with /otp',
                KEYBOARDS.backToMenu(), 'HTML'
            );
        }

        // Validate country exists in dynamic catalog
        const hasCountry = this.countryCatalog?.hasCountry(country);
        if (!hasCountry && mode === 'CHEAP' && this.tierSelector) {
            return ctx.answerCbQuery('🌍 Invalid country selected. Please try again.', { show_alert: true });
        }

        // ── Route to tier-based flow if applicable ──
        if (mode === 'CHEAP' && this.tierSelector && ctx.session?.selectedTier) {
            return this.handleTierCountrySelect(ctx, country);
        }

        // ── Check existing session ──
        const existingSession = await this._getActiveSession(userId);
        if (existingSession && existingSession.status !== 'RECEIVED') {
            return this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed,
                '⏳ <b>Active Session Exists</b>\n\nYou already have an active OTP request.\n\nCancel it first to start a new one.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔍 Check Status', `check_otp_${existingSession.sessionId}`)],
                    [Markup.button.callback('❌ Cancel Session', 'cancel_otp')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );
        }

        let loadingMsg = null;
        
        try {
            loadingMsg = await ctx.reply('⏳ Assigning number...');

            // ═════════════════════════════════════════════════════════════════
            //  VIP/BUNDLE with VIP number — uses NumberPool ONLY
            // ═════════════════════════════════════════════════════════════════
            if (useVipNumber && this._isVipActive(ctx.state.user) && ctx.state.user.vipPhoneNumber) {
                const user = ctx.state.user;
                
                if (mode === 'VIP') {
                    await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });
                } else if (mode === 'BUNDLE') {
                    await User.updateOne({ userId }, { $inc: { bundleRemaining: -1 } });
                }

                await this._safeDeleteMessage(ctx, loadingMsg);

                const costText = mode === 'VIP' ? 'VIP (daily quota)' : 'BUNDLE (1 credit)';

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: ${mode}\n` +
                    `📱 Number: <code>${user.vipPhoneNumber}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: ${costText}\n\n` +
                    `⚠️ Your dedicated VIP number. OTP will arrive shortly.`;

                const keyboard = KEYBOARDS.otpActions(`vip_${userId}_${Date.now()}`);
                
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                const session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    user.vipPhoneNumber, user.vipProvider
                );

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // ═════════════════════════════════════════════════════════════════
            //  BUNDLE without VIP number — uses NumberPool ONLY
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'BUNDLE') {
                const user = await User.findOne({ userId });
                if (!user?.bundleRemaining || user.bundleRemaining <= 0) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    
                    return this.sendPhotoWithCaption(
                        ctx, IMAGES.bundleFirst,
                        '❌ <b>No Bundle Credits</b>\n\nYour bundle OTPs have been exhausted. Buy a new bundle to continue.',
                        Markup.inlineKeyboard([
                            [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
                            [Markup.button.callback('🔙 Back', 'menu')]
                        ]),
                        'HTML'
                    );
                }
                
                await User.updateOne({ userId }, { $inc: { bundleRemaining: -1 } });

                if (!this.smsProviderManager) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const bundleResult = await this.smsProviderManager.getVipNumber(country, service, userId);

                await this._safeDeleteMessage(ctx, loadingMsg);

                const session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    bundleResult.phoneNumber, bundleResult.provider,
                    bundleResult.providerNumberId || bundleResult.numberId
                );

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: BUNDLE\n` +
                    `📱 Number: <code>${session.number}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: BUNDLE (1 credit used)\n` +
                    `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                    `⚠️ Bundle credit used. No additional charge.`;

                const keyboard = KEYBOARDS.otpActions(session.sessionId, session.number);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // ═════════════════════════════════════════════════════════════════
            //  FREE tier — uses FreeProvider ONLY
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'FREE') {
                if (!this.smsProviderManager) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const freeResult = await this.smsProviderManager.getFreeNumber(country, service);

                await this._safeDeleteMessage(ctx, loadingMsg);

                const session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    freeResult.phoneNumber, 'FREE_PUBLIC',
                    freeResult.sessionId
                );

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: FREE\n` +
                    `📱 Number: <code>${session.number}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: FREE\n` +
                    `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                    `⚠️ Shared number. OTP not guaranteed.`;

                const keyboard = KEYBOARDS.otpActions(session.sessionId, session.number);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                this.startFreePolling(ctx, userId, freeResult.sessionId, session.sessionId);

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // ═════════════════════════════════════════════════════════════════
            //  CHEAP tier — LEGACY PATH (when tier system NOT used)
            //  New tier flow bypasses this via handleTierCountrySelect
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'CHEAP') {
                if (!this.smsProviderManager) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                let priceInfo = null;
                let displayPrice = ctx.session?.cheapDisplayPrice || config.prices?.cheapOtp || 0.05;
                
                try {
                    priceInfo = await this.smsProviderManager.getCheapPrice(country, service);
                    if (priceInfo?.displayPrice) {
                        displayPrice = priceInfo.displayPrice;
                        logger.info('Dynamic price fetched for CHEAP', {
                            country, service, simPrice: priceInfo.simPrice, displayPrice
                        });
                    }
                } catch (priceError) {
                    logger.warn('Dynamic price check failed, using fallback', { 
                        country, service, error: priceError.message, fallbackPrice: displayPrice 
                    });
                }

                const user = ctx.state.user;
                if (this._getAvailableBalance(user) < displayPrice) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    
                    const message = 
                        `💰 <b>Insufficient Balance</b>\n\n` +
                        `Required: ${formatCurrency(displayPrice)}\n` +
                        `Available: ${formatCurrency(this._getAvailableBalance(user))}\n\n` +
                        `Price varies by country. Please deposit more.`;
                        
                    return this.sendPhotoWithCaption(
                        ctx, IMAGES.cheapMode, message,
                        Markup.inlineKeyboard([
                            [Markup.button.callback('💳 Deposit', 'deposit')],
                            [Markup.button.callback('🔙 Back', 'menu')]
                        ]), 'HTML'
                    );
                }

                const cheapResult = await this.smsProviderManager.getCheapNumber(country, service);

                await this._safeDeleteMessage(ctx, loadingMsg);

                const session = await sessionManager.createSessionWithNumber(
                    userId, 
                    mode, 
                    service, 
                    country,
                    cheapResult.phoneNumber,
                    cheapResult.provider,
                    cheapResult.providerNumberId,
                    cheapResult.displayCost || cheapResult.cost
                );

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: CHEAP\n` +
                    `📱 Number: <code>${session.number}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: ${formatCurrency(session.cost)}\n` +
                    `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                    `⚠️ Funds locked. Will be deducted on delivery.\n` +
                    `Cancel anytime to get full refund.`;

                const keyboard = KEYBOARDS.otpActions(session.sessionId, session.number);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // ═════════════════════════════════════════════════════════════════
            //  VIP tier (without dedicated number) — uses NumberPool ONLY
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'VIP') {
                if (!this.smsProviderManager) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const user = ctx.state.user;
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });

                const vipResult = await this.smsProviderManager.getVipNumber(country, service, userId);

                await this._safeDeleteMessage(ctx, loadingMsg);

                const session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    vipResult.phoneNumber, vipResult.provider,
                    vipResult.providerNumberId || vipResult.numberId
                );

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: VIP\n` +
                    `📱 Number: <code>${session.number}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: VIP (daily quota)\n` +
                    `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                    `⚠️ Priority delivery enabled.`;

                const keyboard = KEYBOARDS.otpActions(session.sessionId, session.number);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            await this._safeDeleteMessage(ctx, loadingMsg);
            throw new Error(`UNKNOWN_MODE: ${mode}`);

        } catch (error) {
            await this._safeDeleteMessage(ctx, loadingMsg);

            logger.error('OTP session creation failed', { userId, mode, service, country, error: error.message });

            // Restore credits on failure
            if (mode === 'BUNDLE') {
                await User.updateOne({ userId }, { $inc: { bundleRemaining: 1 } }).catch(() => {});
            } else if (mode === 'VIP') {
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: -1 } }).catch(() => {});
            }

            const errorMessages = {
                ACTIVE_SESSION_EXISTS: '⏳ You already have an active session. Use /cancel first.',
                INSUFFICIENT_BALANCE: '💰 Insufficient balance. Deposit first with /deposit',
                FREE_LIMIT_REACHED: '🆓 Free limit reached for today.',
                USER_BLACKLISTED: '🚫 Your account is suspended.',
                VIP_EXPIRED: '👑 VIP expired. Renew your subscription.',
                VIP_DAILY_LIMIT_REACHED: '⚠️ VIP daily limit (50) reached.',
                BUNDLE_EMPTY: '📦 No bundle credits left. Buy a bundle first.',
                CHEAP_PROVIDER_INACTIVE: '💰 CHEAP provider is not available. Please try FREE or upgrade to VIP.',
                CHEAP_NO_NUMBERS: '💰 No CHEAP numbers available for this country. Try another country or FREE mode.',
                CHEAP_PROVIDER_NOT_FOUND: '💰 CHEAP service not configured. Contact support.',
                FREE_PROVIDER_INACTIVE: '🆓 Free provider is not available. Please try CHEAP or VIP.',
                FREE_NO_NUMBERS: '🆓 No free numbers available. Try again later.',
                FREE_PROVIDER_NOT_FOUND: '🆓 Free service not configured. Contact support.',
                POOL_NOT_AVAILABLE: '👑 VIP pool not configured. Contact support.',
                POOL_EMPTY: '👑 No VIP numbers available. Contact support to restock.',
                SMS_PROVIDER_NOT_AVAILABLE: '🔌 SMS service temporarily unavailable. Try again later.',
                INVALID_COUNTRY: '🌍 Invalid country selected. Please try again.',
                ALL_PROVIDERS_FAILED: '❌ Service temporarily unavailable. Try again later or different country.',
                NO_PROVIDERS_AVAILABLE: '❌ No providers available. Check /status.',
                NUMBER_UNAVAILABLE: '❌ No numbers available for this country/service. Try another.',
                TIMEOUT: '⏱ Request timed out. Please try again.'
            };

            const errorKey = Object.keys(errorMessages).find(key => error.message?.includes(key));
            const displayMessage = errorMessages[errorKey] || `❌ Error: ${error.message}`;

            await this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed, 
                displayMessage,
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
                    },

    // ═══════════════════════════════════════════════════════════════════════
    //  CHECK OTP
    // ═══════════════════════════════════════════════════════════════════════

    
async handleCheckOTP(ctx) {
        const userId = ctx.from.id.toString();
        const matchId = ctx.match[1];
        
        try {
            let query = { 
                userId, 
                status: { $in: ['WAITING', 'CHECKING', 'RECEIVED'] } 
            };
            
            if (!matchId.startsWith('vip_')) {
                query = { sessionId: matchId, userId };
            }
            
            const activeSession = await Session.findOne(query).sort({ createdAt: -1 });

            if (!activeSession) {
                return ctx.answerCbQuery('❌ No active OTP session found');
            }

            if (activeSession.status === 'RECEIVED' && activeSession.otpCode) {
                await ctx.answerCbQuery('✅ OTP received!');
                
                const message = 
                    `🔓 <b>OTP Received!</b>\n\n` +
                    `📱 Number: <code>${activeSession.number}</code>\n` +
                    `🎯 Service: ${activeSession.service}\n` +
                    `🔢 OTP: <code>${activeSession.otpCode}</code>\n` +
                    `🕐 Delivered: ${activeSession.endTime ? new Date(activeSession.endTime).toLocaleTimeString() : 'Just now'}\n\n` +
                    `⚠️ Do not share this code with anyone.`;

                await this.sendPhotoWithCaption(
                    ctx, IMAGES.otpReceived, message,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back to Menu', 'menu')],
                        [Markup.button.callback('📱 Request Another', 'menu')]
                    ]),
                    'HTML'
                );
                return;
            }

            const status = await sessionManager.checkSessionStatus(activeSession.sessionId);
            
            if (status.status === 'RECEIVED' && status.otpCode) {
                await Session.updateOne(
                    { sessionId: activeSession.sessionId },
                    { $set: { status: 'RECEIVED', otpCode: status.otpCode, endTime: new Date() } }
                );

                await User.updateOne({ userId }, { $inc: { totalOtps: 1 } });

                await ctx.answerCbQuery('✅ OTP received!');
                
                const message = 
                    `🔓 <b>OTP Received!</b>\n\n` +
                    `📱 Number: <code>${activeSession.number}</code>\n` +
                    `🎯 Service: ${activeSession.service}\n` +
                    `🔢 OTP: <code>${status.otpCode}</code>\n\n` +
                    `⚠️ Do not share this code with anyone.`;

                await this.sendPhotoWithCaption(
                    ctx, IMAGES.otpReceived, message,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back to Menu', 'menu')]
                    ]),
                    'HTML'
                );
                return;
            }

            const timeLeft = activeSession.timeoutAt 
                ? Math.max(0, Math.floor((new Date(activeSession.timeoutAt) - new Date()) / 1000)) 
                : 0;
            
            await ctx.answerCbQuery(`⏳ Still waiting... ${timeLeft}s left`);
            
            const costText = activeSession.mode === 'FREE' ? 'FREE' : 
                            activeSession.mode === 'BUNDLE' ? 'BUNDLE (1 credit used)' : 
                            activeSession.mode === 'VIP' ? 'VIP (daily quota)' :
                            formatCurrency(activeSession.cost);

            const updatedMessage = 
                `📱 <b>OTP Request In Progress</b>\n\n` +
                `🌍 Mode: ${activeSession.mode}\n` +
                `📱 Number: <code>${activeSession.number}</code>\n` +
                `🎯 Service: ${activeSession.service}\n` +
                `⏳ Status: <b>Still waiting...</b>\n` +
                `💰 Cost: ${costText}\n` +
                `⏱ Time Left: <code>${timeLeft}s</code>\n\n` +
                `🔍 Last checked: ${new Date().toLocaleTimeString()}`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔍 Check Again', `check_otp_${activeSession.sessionId}`)],
                [Markup.button.callback('❌ Cancel', 'cancel_otp')]
            ]);

            try {
                await this.editOrSendPhoto(ctx, IMAGES.otpRequested, updatedMessage, keyboard, 'HTML');
            } catch (editError) {
                await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, updatedMessage, keyboard, 'HTML');
            }

        } catch (error) {
            logger.error('Check OTP failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error checking OTP status');
        }
    },

    async handleRevealOTP(ctx) {
        const sessionId = ctx.match[1];
        const userId = ctx.from.id.toString();
        
        try {
            const session = await Session.findOne({ sessionId, userId });
            if (!session || session.status !== 'RECEIVED') {
                return ctx.answerCbQuery('❌ OTP not available');
            }
            
            await ctx.answerCbQuery();
            
            const message = 
                `🔓 <b>Full OTP Revealed</b>\n\n` +
                `📱 Number: <code>${session.number}</code>\n` +
                `🔢 OTP: <code>${session.otpCode}</code>\n` +
                `🕐 Delivered: ${session.endTime ? new Date(session.endTime).toLocaleTimeString() : 'N/A'}\n\n` +
                `⚠️ Do not share this code with anyone.`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.otpReceived, message, null, 'HTML');
            
        } catch (error) {
            await ctx.answerCbQuery('❌ Error revealing OTP');
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  QUICK BUY — One-tap cheapest option
    // ═══════════════════════════════════════════════════════════════════════

    
async handleQuickBuy(ctx) {
        const user = ctx.state.user;
        const stats = this._getUserStats(user);

        let message = '⚡ <b>Quick Buy</b>\n\n';
        const buttons = [];

        if (stats.freeRemaining > 0) {
            message += `🆓 Free OTPs available: <code>${stats.freeRemaining}</code>\n`;
            buttons.push([Markup.button.callback('🆓 Use Free OTP', 'mode_free')]);
        }

        if (stats.bundleRemaining > 0) {
            message += `📦 Bundle credits: <code>${stats.bundleRemaining}</code>\n`;
            buttons.push([Markup.button.callback('📦 Use Bundle Credit', 'mode_bundle')]);
        }

        if (stats.isVip && stats.vipRemaining > 0) {
            message += `👑 VIP daily: <code>${stats.vipRemaining}</code> left\n`;
            buttons.push([Markup.button.callback('👑 Use VIP', 'mode_vip')]);
        }

        const cheapPrice = config.prices?.cheapOtp || 0.05;
        if (stats.available >= cheapPrice) {
            message += `💰 CHEAP OTP: <code>${formatCurrency(cheapPrice)}</code>\n`;
            buttons.push([Markup.button.callback('💰 Buy CHEAP OTP', 'mode_cheap')]);
        }

        if (!buttons.length) {
            message += '❌ No credits available and insufficient balance.\n\nDeposit to continue.';
            buttons.push([Markup.button.callback('💳 Deposit', 'deposit')]);
        }

        buttons.push([Markup.button.callback('🔙 Main Menu', 'menu')]);

        await this.sendPhotoWithCaption(
            ctx, IMAGES.otpMenu, message,
            Markup.inlineKeyboard(buttons), 'HTML'
        );
    }
};

export default purchaseMethods;
