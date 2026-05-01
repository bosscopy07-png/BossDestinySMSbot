// ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 1: Imports, Setup, User Helpers, VIP & Deposit
// ═══════════════════════════════════════════════════════════════════════════════

import { Markup } from 'telegraf';
import { Session, User, Number as NumberModel, Transaction } from '../../models/index.js';
import { COUNTRIES, SERVICES } from '../../utils/constants.js';
import { formatCurrency, maskOTP } from '../../utils/helpers.js';
import sessionManager from '../../services/otp/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

// ─── Image Assets ─────────────────────────────────────────────────────────────
const IMAGES = {
    otpMenu: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png',
    vipFirst: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    vipOther: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231495/file_00000000800071f48dbbef2fbcc543fe_qgr5ch.png',
    bundleFirst: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231494/file_00000000733c7246bf7774567468638b_l64i5g.png',
    bundleOther: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231493/file_000000004c8c71f49757d61e50e41a4e_dyocuq.png',
    freeMode: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231492/file_00000000820072468452896492cba37c_rw0k7f.png',
    countrySelect: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000cad4720a8c06373a016e5150_mg6tx1.png',
    cheapMode: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231494/file_0000000040a871f4a09afb0846cf618e_jdiomc.png',
    otpRequested: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235811/file_00000000e318720a951c5e2e7a2588cf_yyva4e.png',
    otpReceived: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000621c71f4b75e0fc04a89d1c2_saojfi.png',
    otpFailed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000621c71f4b75e0fc04a89d1c2_saojfi.png',
    default: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    depositConfirmed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235826/file_000000001c0c720aa51ae407e6741ca5_steie1.png',
    myNumber: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    banned: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    history: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    referral: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    stats: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231495/file_00000000800071f48dbbef2fbcc543fe_qgr5ch.png'
};

// ─── Inline Keyboards (Reusable) ──────────────────────────────────────────────
const KEYBOARDS = {
    backToMenu: () => Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Menu', 'menu')]
    ]),
    
    depositOrBack: () => Markup.inlineKeyboard([
        [Markup.button.callback('💳 Deposit', 'deposit')],
        [Markup.button.callback('🔙 Back', 'menu')]
    ]),
    
    supportOrRetry: () => Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'menu')],
        [Markup.button.callback('📞 Support', 'contact_support')]
    ]),
    
    otpActions: (sessionId) => Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Check OTP', `check_otp_${sessionId}`)],
        [Markup.button.callback('❌ Cancel', 'cancel_otp')]
    ])
};

// ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands Class
// ═══════════════════════════════════════════════════════════════════════════════

class OTPCommands {
    constructor(bot, walletService, smsProviderManager = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.smsProviderManager = smsProviderManager;
        
        // Bind all handler methods to ensure `this` context
        this._bindAllHandlers();
        
        this.registerCommands();
        
        if (this.walletService?.onDepositNotification) {
            this.walletService.onDepositNotification(this.handleDepositNotification.bind(this));
        }
    }

    // ─── Auto-bind all handler methods ─────────────────────────────────────
    _bindAllHandlers() {
        const handlerNames = [
            'handleOTPCommand', 'handleMyNumberCommand', 'handleCancel',
            'handleFreeMode', 'handleCheapMode', 'handleVIPMode', 'handleBundleMode',
            'handleViewMyNumber', 'handleRequestOtpVip', 'handleBuyBundleOtp',
            'handleBundleQuantity', 'handleBundleQuantityCustom', 'handleConfirmBundlePurchase',
            'handleServiceSelect', 'handleCountrySelect',
            'handleBuyBundle', 'handleConfirmFreeMode', 'handleBuyVIP', 'handleConfirmBundle',
            'handleConfirmVIP', 'handleRevealOTP', 'handleCheckOTP', 'handleCheckDeposit',
            'handleDepositInfo', 'handleMenu', 'handleContactSupport',
            'handleCancelVipSubscription', 'handleConfirmVipCancel',
            'handleHistory', 'handleReferral', 'handleStats', 'handleQuickBuy',
            'handleProviderStatus', 'handleSettings', 'handleToggleNotifications',
            'handleFaq', 'handleTerms', 'handleOTPHub' 
        ];
        
        for (const name of handlerNames) {
            if (typeof this[name] === 'function') {
                this[name] = this[name].bind(this);
            } else {
                logger.warn(`Handler method ${name} not found during binding`);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  USER HELPERS
    // ═══════════════════════════════════════════════════════════════════════
    
    _canUseFree(user) {
        const limit = config.limits?.freeDaily || 3;
        return (user.freeUsedToday || 0) < limit;
    }

    _canUseVip(user) {
        if (!this._isVipActive(user)) return false;
        const limit = config.limits?.vipDaily || 50;
        return (user.vipDailyUsed || 0) < limit;
    }

    _isVipActive(user) {
        return !!(user.vipExpiry && new Date(user.vipExpiry) > new Date());
    }

    _getAvailableBalance(user) {
        return (user.balance || 0) - (user.lockedBalance || 0);
    }

    _freeRemaining(user) {
        const limit = config.limits?.freeDaily || 3;
        return Math.max(0, limit - (user.freeUsedToday || 0));
    }

    _vipRemaining(user) {
        const limit = config.limits?.vipDaily || 50;
        return Math.max(0, limit - (user.vipDailyUsed || 0));
    }

    _vipDaysLeft(user) {
        if (!user.vipExpiry) return 0;
        const diff = new Date(user.vipExpiry) - new Date();
        return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    _getUserStats(user) {
        return {
            balance: user.balance || 0,
            available: this._getAvailableBalance(user),
            vipDays: this._vipDaysLeft(user),
            vipRemaining: this._vipRemaining(user),
            freeRemaining: this._freeRemaining(user),
            bundleRemaining: user.bundleRemaining || 0,
            totalOtps: user.totalOtps || 0,
            isVip: this._isVipActive(user)
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  VIP NUMBER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    async assignVipNumber(userId, country = 'US', preferredProvider = null) {
        try {
            if (!this.smsProviderManager?.numberPool) {
                logger.warn('No number pool for VIP assignment', { userId });
                return null;
            }

            const assignment = await this.smsProviderManager.numberPool.acquireNumber(
                country, 'VIP_SUBSCRIPTION', userId, preferredProvider
            );

            await User.updateOne(
                { userId },
                {
                    $set: {
                        vipNumberId: assignment.numberId,
                        vipPhoneNumber: assignment.phoneNumber,
                        vipProvider: assignment.provider,
                        vipNumberAssignedAt: new Date(),
                        vipNumberCountry: country
                    }
                }
            );

            logger.info('VIP number assigned', {
                userId, phone: assignment.phoneNumber, provider: assignment.provider
            });

            return assignment;
        } catch (error) {
            logger.error('VIP number assignment failed', { userId, error: error.message });
            return null;
        }
    }

    async releaseVipNumber(userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user?.vipNumberId) return { success: true, note: 'No VIP number assigned' };

            if (this.smsProviderManager?.numberPool) {
                await this.smsProviderManager.numberPool.releaseNumber(user.vipNumberId, 'VIP_EXPIRED');
            }

            await User.updateOne(
                { userId },
                {
                    $set: {
                        vipNumberId: null,
                        vipPhoneNumber: null,
                        vipProvider: null,
                        vipNumberAssignedAt: null,
                        vipNumberCountry: null
                    }
                }
            );

            logger.info('VIP number released', { userId, phone: user.vipPhoneNumber });
            return { success: true };
        } catch (error) {
            logger.error('VIP number release failed', { userId, error: error.message });
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  DEPOSIT NOTIFICATION
    // ═══════════════════════════════════════════════════════════════════════

    async handleDepositNotification(userId, data) {
        try {
            const message = 
                '✅ <b>Deposit Confirmed!</b>\n\n' +
                '💵 Amount Credited: <code>' + formatCurrency(data.amount) + '</code>\n' +
                (data.trackingFee > 0 ? '🔧 Tracking Fee: <code>' + formatCurrency(data.trackingFee) + '</code>\n' : '') +
                '🔗 TX Hash: <code>' + data.txHash + '</code>\n\n' +
                'Your balance has been updated. Use /otp to request OTPs!';

            await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });
        } catch (error) {
            logger.error('Deposit notification failed', { userId, error: error.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COMMAND REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════

    registerCommands() {
        // Slash commands
        this.bot.command('otp', this.handleOTPCommand);
        this.bot.command('mynumber', this.handleMyNumberCommand);
        this.bot.command('cancel', this.handleCancel);
        this.bot.command('history', this.handleHistory);
        this.bot.command('referral', this.handleReferral);
        this.bot.command('stats', this.handleStats);
        this.bot.command('status', this.handleProviderStatus);
        this.bot.command('settings', this.handleSettings);
        this.bot.command('faq', this.handleFaq);
        
        // Mode selection actions
        this.bot.action('mode_free', this.handleFreeMode);
        this.bot.action('mode_cheap', this.handleCheapMode);
        this.bot.action('mode_vip', this.handleVIPMode);
        this.bot.action('mode_bundle', this.handleBundleMode);
        
        // My Number & VIP actions
        this.bot.action('view_my_number', this.handleViewMyNumber);
        this.bot.action('request_otp_vip', this.handleRequestOtpVip);
        this.bot.action('buy_bundle_otp', this.handleBuyBundleOtp);
        
        // Bundle quantity actions
        this.bot.action('bundle_qty_5', (ctx) => this.handleBundleQuantity(ctx, 5));
        this.bot.action('bundle_qty_10', (ctx) => this.handleBundleQuantity(ctx, 10));
        this.bot.action('bundle_qty_25', (ctx) => this.handleBundleQuantity(ctx, 25));
        this.bot.action('bundle_qty_50', (ctx) => this.handleBundleQuantity(ctx, 50));
        this.bot.action('bundle_qty_custom', this.handleBundleQuantityCustom);
        this.bot.action('confirm_bundle_purchase', this.handleConfirmBundlePurchase);
        
        // Service & Country selection
        this.bot.action(/service_(.+)/, this.handleServiceSelect);
        this.bot.action(/country_(.+)/, this.handleCountrySelect);
        
        // Purchase confirmations
        this.bot.action('buy_bundle', this.handleBuyBundle);
        this.bot.action('confirm_free_mode', this.handleConfirmFreeMode);
        this.bot.action('buy_vip', this.handleBuyVIP);
        this.bot.action('confirm_bundle', this.handleConfirmBundle);
        this.bot.action('confirm_vip', this.handleConfirmVIP);
                // Mode selection
        this.bot.action('mode_free', this.handleFreeMode);
        this.bot.action('mode_cheap', this.handleCheapMode);
        this.bot.action('mode_vip', this.handleVIPMode);
        this.bot.action('mode_bundle', this.handleBundleMode);
        
        // OTP Hub
        this.bot.action('otp_hub', this.handleOTPHub);
        
        // OTP actions
        this.bot.action(/reveal_(.+)/, this.handleRevealOTP);
        this.bot.action('check_deposit', this.handleCheckDeposit);
        this.bot.action('cancel_otp', this.handleCancel);
        this.bot.action('deposit', this.handleDepositInfo);
        this.bot.action('menu', this.handleMenu);
        this.bot.action('contact_support', this.handleContactSupport);
        this.bot.action('cancel_vip_subscription', this.handleCancelVipSubscription);
        this.bot.action('confirm_vip_cancel', this.handleConfirmVipCancel);
        
        // New feature actions
        this.bot.action('history', this.handleHistory);
        this.bot.action('referral', this.handleReferral);
        this.bot.action('stats', this.handleStats);
        this.bot.action('quick_buy', this.handleQuickBuy);
        this.bot.action('provider_status', this.handleProviderStatus);
        this.bot.action('settings', this.handleSettings);
        this.bot.action('toggle_notifications', this.handleToggleNotifications);
        this.bot.action('faq', this.handleFaq);
        this.bot.action('terms', this.handleTerms);
        
        // OTP check with pattern
        this.bot.action(/check_otp_(.+)/, this.handleCheckOTP);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  UTILITY METHODS
    // ═══════════════════════════════════════════════════════════════════════

    async sendPhotoWithCaption(ctx, imageUrl, caption, keyboard = null, parseMode = 'HTML') {
        try {
            const payload = { caption: caption.trim(), parse_mode: parseMode };
            if (keyboard) payload.reply_markup = keyboard.reply_markup;
            return await ctx.replyWithPhoto(imageUrl, payload);
        } catch (error) {
            logger.error('Photo send failed', { error: error.message });
            return keyboard
                ? ctx.reply(caption, { parse_mode: parseMode, ...keyboard })
                : ctx.reply(caption, { parse_mode: parseMode });
        }
    }

    async editOrSendPhoto(ctx, imageUrl, caption, keyboard = null, parseMode = 'HTML') {
        try {
            if (ctx.callbackQuery?.message?.photo) {
                await ctx.editMessageMedia(
                    { type: 'photo', media: imageUrl, caption: caption.trim(), parse_mode: parseMode },
                    { reply_markup: keyboard?.reply_markup }
                );
                return;
            }
            if (ctx.callbackQuery?.message) {
                await ctx.editMessageCaption(caption, {
                    parse_mode: parseMode,
                    reply_markup: keyboard?.reply_markup
                });
                return;
            }
        } catch (editError) {
            // Fallback to sending new message
        }
        return this.sendPhotoWithCaption(ctx, imageUrl, caption, keyboard, parseMode);
    }

    escapeTelegramText(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\*/g, '\\*')
            .replace(/_/g, '\\_')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/`/g, '\\`');
    }

    formatPollStatus(status) {
        if (status.status === 'POLLING') {
            return `⏳ *Checking inbox...*\n(${status.message || '...'})`;
        }
        if (status.status === 'RECEIVED') {
            return `🔍 *SMS detected! Processing...*`;
        }
        return `⚠️ ${this.escapeTelegramText(status.message || status.error || '...')}`;
    }

        async sendPollUpdate(ctx, status) {
        // Don't send new message every poll — update existing or skip if no change
        const message = this.formatPollStatus(status);
        
        try {
            // If we have a poll message ID stored, try to edit it
            if (ctx.session?.pollMessageId) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        ctx.session.pollMessageId,
                        undefined,
                        message,
                        { parse_mode: 'Markdown' }
                    );
                    return; // Successfully edited, don't send new
                } catch (editError) {
                    // Message too old or can't edit, fall through to send new
                }
            }
            
            // Send new message and store ID for future edits
            const sent = await ctx.reply(message, { parse_mode: 'Markdown' });
            if (sent?.message_id) {
                ctx.session = ctx.session || {};
                ctx.session.pollMessageId = sent.message_id;
            }
        } catch (error) {
            logger.debug('Poll update failed', { error: error.message });
        }
        }
    
    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SESSION MANAGEMENT HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    async _getActiveSession(userId) {
        return Session.findOne({ 
            userId, 
            status: { $in: ['WAITING', 'CHECKING', 'RECEIVED'] } 
        }).sort({ createdAt: -1 });
    }

    async _refundSession(session) {
        const { userId, mode, cost } = session;
        try {
            if (mode === 'BUNDLE') {
                await User.updateOne({ userId }, { $inc: { bundleRemaining: 1 } });
            } else if (mode === 'VIP') {
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: -1 } });
            } else if (mode === 'CHEAP' && (cost || 0) > 0) {
                await User.updateOne(
                    { userId }, 
                    { $inc: { lockedBalance: -cost, balance: cost } }
                );
            }
            return true;
        } catch (error) {
            logger.error('Session refund failed', { userId, error: error.message });
            return false;
        }
    }

        async _scheduleTimeoutNotification(userId, sessionId, originalMessageId, timeoutAt) {
        try {
            const delayMs = new Date(timeoutAt) - new Date();
            if (delayMs <= 0) return;

            setTimeout(async () => {
                try {
                    const session = await Session.findOne({ 
                        sessionId, 
                        status: { $in: ['WAITING', 'CHECKING'] } 
                    });
                    
                    if (!session) return; // Already handled (cancelled, received, etc.)

                    await Session.updateOne(
                        { sessionId },
                        { $set: { status: 'TIMEOUT', endTime: new Date() } }
                    );

                    await this._refundSession(session);

                    // ONLY send timeout message if session wasn't already handled by polling
                    // The polling code already sends timeout message for FREE tier
                    if (session.mode !== 'FREE') {
                        const refundText = {
                            BUNDLE: 'Bundle credit restored',
                            VIP: 'VIP daily quota restored',
                            CHEAP: 'Funds returned to balance'
                        }[session.mode] || 'Funds handled';

                        const timeoutMessage = 
                            `⏰ <b>OTP Request Timed Out</b>\n\n` +
                            `📱 Number: <code>${session.number}</code>\n` +
                            `🎯 Service: ${session.service}\n` +
                            `⏱ Status: <b>Expired</b>\n\n` +
                            `💰 ${refundText}\n\n` +
                            `You can request a new OTP with /otp`;

                        await this.bot.telegram.sendMessage(userId, timeoutMessage, {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('🔄 Request New OTP', 'menu')],
                                [Markup.button.callback('📞 Contact Support', 'contact_support')]
                            ]).reply_markup
                        });
                    }

                } catch (notifyError) {
                    logger.error('Timeout notification failed', { userId, sessionId, error: notifyError.message });
                }
            }, Math.min(delayMs, 2147483647));

        } catch (error) {
            logger.error('Failed to schedule timeout', { userId, sessionId, error: error.message });
        }
                    }
                
    
                    // ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 2: Main Menu, My Number, Mode Handlers, Selection
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  MAIN MENU & MY NUMBER
    // ═══════════════════════════════════════════════════════════════════════

        async handleOTPCommand(ctx) {
        const user = ctx.state.user;
        const isVip = this._isVipActive(user);
        const hasBundle = (user.bundleRemaining || 0) > 0;

        let message = '📱 <b>Request OTP</b>\n\nSelect your preferred mode:';
        
        const buttons = [
            [Markup.button.callback('🆓 FREE', 'mode_free'), Markup.button.callback('💰 CHEAP', 'mode_cheap')]
        ];

        if (hasBundle || isVip) {
            buttons.push([
                Markup.button.callback('📦 Bundle', 'mode_bundle'),
                Markup.button.callback('👑 VIP', 'mode_vip')
            ]);
        } else {
            buttons.push([
                Markup.button.callback('📦 Buy Bundle', 'buy_bundle'),
                Markup.button.callback('👑 Upgrade VIP', 'buy_vip')
            ]);
        }

        if (isVip && user.vipPhoneNumber) {
            buttons.push([Markup.button.callback('📱 View My Number', 'view_my_number')]);
        }

        buttons.push([Markup.button.callback('🔙 Back to OTP Hub', 'otp_hub')]);

        const keyboard = Markup.inlineKeyboard(buttons);
        await this.sendPhotoWithCaption(ctx, IMAGES.otpMenu, message, keyboard, 'HTML');
}
             
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
    }
    
    async handleMyNumberCommand(ctx) {
        return this.handleViewMyNumber(ctx);
            }
    
    // ═══════════════════════════════════════════════════════════════════════
    //  MODE HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    async handleFreeMode(ctx) {
        const user = ctx.state.user;
        
        if (!this._canUseFree(user)) {
            const message = 
                '❌ <b>Free Limit Reached</b>\n\n' +
                'You\'ve used all your free OTPs today.\n\n' +
                '💰 Deposit to continue:\n' +
                '• CHEAP: $0.05 per OTP\n' +
                '• Bundle: $5 for 100 OTPs\n' +
                '• VIP: $5/month unlimited';
                
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
                [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            
            return this.sendPhotoWithCaption(ctx, IMAGES.freeMode, message, keyboard, 'HTML');
        }

        const warningMessage = 
            '⚠️ <b>Free Mode Notice</b>\n\n' +
            '📵 Free numbers are <b>shared</b> and may be <b>blocked</b> by:\n' +
            '• WhatsApp, Telegram, Google\n' +
            '• Facebook, Instagram, Twitter\n' +
            '• Banks, Binance, PayPal\n\n' +
            `✅ You have <b>${this._freeRemaining(user)}</b> free OTPs left today\n\n` +
            '💡 For <b>guaranteed</b> delivery, use:\n' +
            '• 💰 CHEAP — $0.05/OTP\n' +
            '• 📦 BUNDLE — $5 for 100 OTPs\n' +
            '• 👑 VIP — $5/month unlimited\n\n' +
            '<i>Free mode is best effort only. No refunds for failed delivery.</i>';

        const warningKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ I Understand, Proceed', 'confirm_free_mode')],
            [Markup.button.callback('💰 Switch to CHEAP', 'mode_cheap')],
            [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        return this.sendPhotoWithCaption(ctx, IMAGES.freeMode, warningMessage, warningKeyboard, 'HTML');
    }

    async handleConfirmFreeMode(ctx) {
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'FREE';
        
        await ctx.editMessageCaption(
            '⏳ <b>Loading Free Mode...</b>',
            { parse_mode: 'HTML' }
        );
        
        await this.showServiceSelection(ctx, 'FREE', IMAGES.freeMode);
    }

    async handleCheapMode(ctx) {
    const user = ctx.state.user;
    
    try {
        // FIXED: Query actual 5SIM price for display
        // Default to a sample country/service to show price range
        let displayPrice = config.prices?.cheapOtp || 0.05;
        let priceInfo = null;

        if (this.smsProviderManager) {
            try {
                // Get price for US/Any as baseline (fastest query)
                priceInfo = await this.smsProviderManager.getCheapPrice('US', 'Any');
                if (priceInfo && priceInfo.displayPrice) {
                    displayPrice = priceInfo.displayPrice;
                }
            } catch (priceError) {
                logger.warn('Failed to get dynamic CHEAP price, using fallback', { 
                    error: priceError.message 
                });
                displayPrice = config.prices?.cheapOtp || 0.05;
            }
        }

        // Check balance against dynamic price
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

        // Store mode and price info in session
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'CHEAP';
        ctx.session.cheapDisplayPrice = displayPrice;  // Store for later use

        // Show service selection with dynamic price
        await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode, displayPrice);
        
    } catch (error) {
        logger.error('handleCheapMode failed', { userId: user.userId, error: error.message });
        
        // Fallback to old behavior
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'CHEAP';
        await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode);
    }
    }
    

    async handleBundleMode(ctx) {
        const user = ctx.state.user;
        
        if (!user.bundleRemaining || user.bundleRemaining <= 0) {
            return this.handleBuyBundle(ctx);
        }

        if (this._isVipActive(user) && user.vipPhoneNumber) {
            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'BUNDLE';
            ctx.session.useVipNumber = true;
            return this.showServiceSelection(ctx, 'BUNDLE (VIP Number)', IMAGES.bundleOther);
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'BUNDLE';
        ctx.session.useVipNumber = false;
        await this.showServiceSelection(ctx, 'BUNDLE', IMAGES.bundleOther);
    }

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
        await this.showServiceSelection(ctx, 'VIP', IMAGES.vipOther);
    }

        // ═══════════════════════════════════════════════════════════════════════
    //  OTP HUB — Central OTP services screen (called from your existing /menu)
    // ═══════════════════════════════════════════════════════════════════════

    async handleOTPHub(ctx) {
        const user = ctx.state.user;
        const stats = this._getUserStats(user);
        const isVip = stats.isVip;
        const hasBundle = stats.bundleRemaining > 0;

        let message = 
            `📱 <b>OTP Services</b>\n\n` +
            `👤 <b>Quick Stats:</b>\n` +
            `💰 Balance: <code>${formatCurrency(stats.balance)}</code>\n` +
            `🆓 Free Today: <code>${stats.freeRemaining}</code> left\n`;
        
        if (isVip) {
            message += `👑 VIP: <code>${stats.vipRemaining}</code> left (${stats.vipDays} days)\n`;
        }
        if (hasBundle) {
            message += `📦 Bundle: <code>${stats.bundleRemaining}</code> OTPs\n`;
        }
        
        message += `\nChoose an option:`;

        // Primary OTP actions
        const buttons = [
            [Markup.button.callback('🆓 FREE OTP', 'mode_free'), Markup.button.callback('💰 CHEAP OTP', 'mode_cheap')]
        ];

        // VIP/BUNDLE or Buy options
        if (hasBundle || isVip) {
            buttons.push([
                Markup.button.callback('📦 Bundle', 'mode_bundle'),
                Markup.button.callback('👑 VIP', 'mode_vip')
            ]);
        } else {
            buttons.push([
                Markup.button.callback('📦 Buy Bundle', 'buy_bundle'),
                Markup.button.callback('👑 Upgrade VIP', 'buy_vip')
            ]);
        }

        // VIP number quick access
        if (isVip && user.vipPhoneNumber) {
            buttons.push([Markup.button.callback('📱 My VIP Number', 'view_my_number')]);
        }

        // Feature buttons row 1
        buttons.push([
            Markup.button.callback('⚡ Quick Buy', 'quick_buy'),
            Markup.button.callback('📊 My Stats', 'stats')
        ]);

        // Feature buttons row 2
        buttons.push([
            Markup.button.callback('📜 History', 'history'),
            Markup.button.callback('👥 Referral', 'referral')
        ]);

        // Feature buttons row 3
        buttons.push([
            Markup.button.callback('⚙️ Settings', 'settings'),
            Markup.button.callback('❓ FAQ', 'faq')
        ]);

        // Bottom row
        buttons.push([
            Markup.button.callback('🔌 Status', 'provider_status'),
            Markup.button.callback('📞 Support', 'contact_support')
        ]);

        // Back to YOUR existing menu
        buttons.push([Markup.button.callback('🔙 Back to Main Menu', 'menu')]);

        const keyboard = Markup.inlineKeyboard(buttons);
        await this.sendPhotoWithCaption(ctx, IMAGES.otpMenu, message, keyboard, 'HTML');
                }

    // ═══════════════════════════════════════════════════════════════════════
    //  SERVICE & COUNTRY SELECTION
    // ═══════════════════════════════════════════════════════════════════════
    
    async showServiceSelection(ctx, mode, imageUrl) {
        const message = `📱 <b>${mode} Mode</b>\n\nChoose the service you need OTP for:`;
        const buttons = [];
        
        // Group services in rows of 3
        for (let i = 0; i < SERVICES.length; i += 3) {
            const row = SERVICES.slice(i, i + 3).map(s => 
                Markup.button.callback(s, `service_${s}`)
            );
            buttons.push(row);
        }
        
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, imageUrl, message, Markup.inlineKeyboard(buttons), 'HTML');
    }

    async handleServiceSelect(ctx) {
        const service = ctx.match[1];
        
        const validServices = SERVICES.map(s => s.toLowerCase());
        if (!validServices.includes(service.toLowerCase())) {
            logger.warn('Invalid service selected', { service, validServices });
            return ctx.answerCbQuery('❌ Invalid service');
        }
        
        ctx.session = ctx.session || {};
        ctx.session.otpService = service;
        
        const message = `🌍 <b>Select Country</b>\n\nChoose number country for <b>${service}</b>:`;
        const buttons = COUNTRIES.map(c => [
            Markup.button.callback(
                `${c.flag} ${c.name}${c.priceModifier > 0 ? ` (+$${c.priceModifier})` : ''}`, 
                `country_${c.code}`
            )
        ]);
        
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, IMAGES.countrySelect, message, Markup.inlineKeyboard(buttons), 'HTML');
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTED — ACQUIRE NUMBER (CORE LOGIC)
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * Handle country selection for OTP request
     * FIXED:
     * - Passes providerNumberId and displayCost to createSessionWithNumber
     * - Dynamic price re-check for specific country/service
     * - Proper error handling for message deletion
     * - Correct cost display in confirmation message
     */
    async handleCountrySelect(ctx) {
        const country = ctx.match[1];
        const userId = ctx.from.id.toString();
        const mode = ctx.session?.otpMode;
        const service = ctx.session?.otpService;
        const useVipNumber = ctx.session?.useVipNumber;

        // Validate session state
        if (!mode || !service) {
            return this.sendPhotoWithCaption(ctx, IMAGES.default, 
                '❌ Session expired. Please start over with /otp',
                KEYBOARDS.backToMenu(), 'HTML'
            );
        }

        // Check for existing active session
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

                // Safe message deletion
                try {
                    if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                } catch (delErr) {
                    logger.debug('Failed to delete loading message', { error: delErr.message });
                }

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
                    try {
                        if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                    } catch (delErr) {
                        logger.debug('Failed to delete loading message', { error: delErr.message });
                    }
                    
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
                    try {
                        if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                    } catch (delErr) {}
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const bundleResult = await this.smsProviderManager.getVipNumber(country, service, userId);

                try {
                    if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                } catch (delErr) {
                    logger.debug('Failed to delete loading message', { error: delErr.message });
                }

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

                const keyboard = KEYBOARDS.otpActions(session.sessionId);
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
                    try {
                        if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                    } catch (delErr) {}
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const freeResult = await this.smsProviderManager.getFreeNumber(country, service);

                try {
                    if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                } catch (delErr) {
                    logger.debug('Failed to delete loading message', { error: delErr.message });
                }

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

                const keyboard = KEYBOARDS.otpActions(session.sessionId);
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
            //  CHEAP tier — uses CheapPanelProvider (5SIM) ONLY (FIXED)
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'CHEAP') {
                if (!this.smsProviderManager) {
                    try {
                        if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                    } catch (delErr) {}
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                // FIXED: Get dynamic price for this specific country/service before purchase
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

                // Re-check balance with actual price for this country
                const user = ctx.state.user;
                if (this._getAvailableBalance(user) < displayPrice) {
                    try {
                        if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                    } catch (delErr) {}
                    
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

                // Get number from 5SIM
                const cheapResult = await this.smsProviderManager.getCheapNumber(country, service);

                try {
                    if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                } catch (delErr) {
                    logger.debug('Failed to delete loading message', { error: delErr.message });
                }

                // FIXED: Pass all required params to createSessionWithNumber
                // Arguments: (userId, mode, service, country, phoneNumber, provider, providerNumberId, cost)
                const session = await sessionManager.createSessionWithNumber(
                    userId, 
                    mode, 
                    service, 
                    country,
                    cheapResult.phoneNumber,      // 5th arg: phone number
                    cheapResult.provider,        // 6th arg: provider name
                    cheapResult.providerNumberId, // 7th arg: 5SIM activation ID (e.g. "1001025384")
                    cheapResult.displayCost || cheapResult.cost // 8th arg: what user pays
                );

                // FIXED: Use session.cost (which is now correctly set from displayCost)
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

                const keyboard = KEYBOARDS.otpActions(session.sessionId);
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
                    try {
                        if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                    } catch (delErr) {}
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const user = ctx.state.user;
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });

                const vipResult = await this.smsProviderManager.getVipNumber(country, service, userId);

                try {
                    if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
                } catch (delErr) {
                    logger.debug('Failed to delete loading message', { error: delErr.message });
                }

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

                const keyboard = KEYBOARDS.otpActions(session.sessionId);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // Unknown mode
            try {
                if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
            } catch (delErr) {}
            throw new Error(`UNKNOWN_MODE: ${mode}`);

        } catch (error) {
            // Safe cleanup of loading message on error
            try {
                if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
            } catch (delErr) {}

            logger.error('OTP session creation failed', { userId, mode, service, country, error: error.message });

            // Rollback on error
            if (mode === 'BUNDLE') {
                await User.updateOne({ userId }, { $inc: { bundleRemaining: 1 } }).catch(() => {});
            } else if (mode === 'VIP' && useVipNumber) {
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: -1 } }).catch(() => {});
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
            const displayMessage = errorMessages[errorKey] || `
    
    // ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 3: Polling, Check OTP, Cancel, Bundle & VIP Purchases
// ═══════════════════════════════════════════════════════════════════════════════
    async startFreePolling(ctx, userId, freeSessionId, dbSessionId) {
        if (!this.smsProviderManager) return;

        let pollMessageId = null;

        try {
            const smsResult = await this.smsProviderManager.pollFreeSMS(
                freeSessionId,
                async (status) => {
                    const message = this.formatPollStatus(status);
                    
                    try {
                        if (pollMessageId) {
                            await ctx.telegram.editMessageText(
                                ctx.chat.id,
                                pollMessageId,
                                undefined,
                                message,
                                { parse_mode: 'Markdown' }
                            );
                            return;
                        }
                        
                        const sent = await ctx.reply(message, { parse_mode: 'Markdown' });
                        if (sent?.message_id) pollMessageId = sent.message_id;
                    } catch (err) {
                        // Edit failed or message too old — silently ignore
                    }
                }
            );

            // Delete the poll message before sending final result
            if (pollMessageId) {
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, pollMessageId);
                } catch (err) {
                    // Message already gone or too old — ignore
                }
            }

            if (smsResult.success) {
                await Session.updateOne(
                    { sessionId: dbSessionId },
                    {
                        $set: {
                            status: 'RECEIVED',
                            otpCode: smsResult.otp,
                            endTime: new Date(),
                            fullText: smsResult.fullText
                        }
                    }
                );

                await User.updateOne({ userId }, { $inc: { totalOtps: 1, freeUsedToday: 1 } });

                const message = 
                    `🔓 <b>OTP Received!</b>\n\n` +
                    `📱 Number: <code>${smsResult.number}</code>\n` +
                    `🎯 Service: ${smsResult.service || 'N/A'}\n` +
                    `🔢 OTP: <code>${smsResult.otp}</code>\n` +
                    `⏱ Delivery: ${smsResult.deliveryTime || '~'}ms\n\n` +
                    `⚠️ Do not share this code with anyone.`;

                await this.bot.telegram.sendMessage(userId, message, {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back to Menu', 'menu')],
                        [Markup.button.callback('📱 Request Another', 'mode_free')]
                    ]).reply_markup
                });

                return;

            } else if (smsResult.status === 'TIMEOUT') {
                logger.info('Free tier timeout', { userId, sessionId: dbSessionId });

                const message = 
                    `⏰ <b>Free OTP Timed Out</b>\n\n` +
                    `No SMS received within the time limit.\n\n` +
                    `💡 Try again or use paid options for better reliability:`;

                await this.bot.telegram.sendMessage(userId, message, {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry Free', 'mode_free')],
                        [Markup.button.callback('💰 Try CHEAP', 'mode_cheap')],
                        [Markup.button.callback('👑 Try VIP', 'buy_vip')],
                        [Markup.button.callback('🔙 Menu', 'menu')]
                    ]).reply_markup
                });
            }

        } catch (error) {
            logger.error('Free polling failed', { userId, error: error.message });
            
            // Cleanup poll message on error
            if (pollMessageId) {
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, pollMessageId);
                } catch (err) {}
            }
        }
                                }
                

    // ═══════════════════════════════════════════════════════════════════════
    //  CHECK OTP
    // ═══════════════════════════════════════════════════════════════════════

    async handleCheckOTP(ctx) {
        const userId = ctx.from.id.toString();
        const matchId = ctx.match[1];
        
        try {
            // Handle VIP check pattern: vip_userId_timestamp
            let query = { 
                userId, 
                status: { $in: ['WAITING', 'CHECKING', 'RECEIVED'] } 
            };
            
            // If matchId looks like a session ID, query by that
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

                // Update user stats
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
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CANCEL HANDLER
    // ═══════════════════════════════════════════════════════════════════════

    async handleCancel(ctx) {
    const userId = ctx.from.id.toString();

    try {
        const activeSession = await Session.findOne({ 
            userId, 
            status: { $in: ['WAITING', 'CHECKING'] } 
        });
        
        if (!activeSession) {
            return this.sendPhotoWithCaption(ctx, IMAGES.default, 
                '❌ No active session to cancel.',
                KEYBOARDS.backToMenu(), 'HTML'
            );
        }

        // FIXED: For CHEAP mode, cancel on 5SIM FIRST before releasing funds
        // This ensures 5SIM refunds YOU before you refund the user
        if (activeSession.mode === 'CHEAP' && activeSession.providerNumberId) {
            try {
                const cancelResult = await this.smsProviderManager.cancelCheapNumber(
                    activeSession.providerNumberId  // Uses activation ID "1001025384"
                );
                logger.info('5SIM cancel result', { 
                    sessionId: activeSession.sessionId,
                    activationId: activeSession.providerNumberId,
                    result: cancelResult 
                });
            } catch (cancelError) {
                logger.error('5SIM cancel failed during user cancel', {
                    sessionId: activeSession.sessionId,
                    activationId: activeSession.providerNumberId,
                    error: cancelError.message
                });
                // Continue with refund even if 5SIM cancel fails
                // (user experience > provider cleanup)
            }
        }

        // For FREE mode, cancel on free provider
        if (activeSession.mode === 'FREE' && activeSession.providerNumberId && this.smsProviderManager) {
            await this.smsProviderManager.cancelNumber('FREE_PUBLIC', activeSession.providerNumberId)
                .catch(() => {});
        }

        // Cancel session in our system (releases funds, restores credits)
        await sessionManager.cancelSession(activeSession.sessionId, userId);
        await this._refundSession(activeSession);

        const message = 
            `✅ <b>Session Cancelled</b>\n\n` +
            `📱 Number: <code>${activeSession.number}</code>\n` +
            `🎯 Service: ${activeSession.service}\n` +
            `💰 Refunded: ${formatCurrency(activeSession.cost || 0)}\n\n` +
            `Any used credits have been refunded.\n` +
            `You can start a new request now.`;
        
        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, 
            Markup.inlineKeyboard([
                [Markup.button.callback('📱 New OTP Request', 'menu')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]), 'HTML'
        );
        
    } catch (error) {
        logger.error('Cancel failed', { userId, error: error.message });
        await this.sendPhotoWithCaption(ctx, IMAGES.default, 
            '❌ Failed to cancel session. Please try again.',
            KEYBOARDS.backToMenu(), 'HTML'
        );
    }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //  BUNDLE PURCHASES
    // ═══════════════════════════════════════════════════════════════════════

    async handleBuyBundle(ctx) {
        const user = ctx.state.user;
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;
        
        const message = 
            `📦 <b>Buy OTP Bundle</b>\n\n` +
            `💰 Price: ${formatCurrency(bundlePrice)}\n` +
            `📦 Includes: ${bundleCount} OTPs\n` +
            `✅ Never expires\n` +
            `💡 Best value for regular users\n\n` +
            `Your Balance: ${formatCurrency(user.balance)}`;
            
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_bundle')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);
        
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleFirst, message, keyboard, 'HTML');
    }

    async handleConfirmBundle(ctx) {
        const user = ctx.state.user;
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;
        
        if (user.balance < bundlePrice) {
            const message = 
                `❌ <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(bundlePrice)}\n` +
                `Available: ${formatCurrency(user.balance)}\n\n` +
                `Deposit first with /deposit`;
            return this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, null, 'HTML');
        }
        
        try {
            await User.updateOne(
                { userId: user.userId }, 
                { $inc: { balance: -bundlePrice, bundleRemaining: bundleCount } }
            );
            
            await Transaction.create({
                txId: `BUNDLE_MAIN_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'BUNDLE_PURCHASE',
                amount: -bundlePrice,
                status: 'COMPLETED',
                metadata: { 
                    quantity: bundleCount, 
                    pricePerOtp: bundlePrice / bundleCount,
                    source: 'MAIN_BUNDLE_MENU'
                },
                createdAt: new Date()
            });
            
            const message = 
                `✅ <b>Bundle Purchased!</b>\n\n` +
                `📦 ${bundleCount} OTPs added\n` +
                `💰 ${formatCurrency(bundlePrice)} deducted\n` +
                `📦 Total Available: ${(user.bundleRemaining || 0) + bundleCount} OTPs\n\n` +
                `Use /otp to start requesting.`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('Bundle purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, 
                '❌ Purchase failed. Please try again.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  VIP PURCHASES
    // ═══════════════════════════════════════════════════════════════════════

    async handleBuyVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        const currentVip = this._isVipActive(user);
        
        let message = 
            `👑 <b>Upgrade to VIP</b>\n\n`;
            
        if (currentVip) {
            message += 
                `✅ You already have VIP active!\n` +
                `⏰ Expires: ${new Date(user.vipExpiry).toLocaleDateString()}\n` +
                `📞 Number: ${user.vipPhoneNumber || 'Assigning...'}\n\n` +
                `Extend your subscription?`;
        } else {
            message += 
                `💰 Price: ${formatCurrency(vipPrice)}/month\n` +
                `✅ 50 OTPs per day\n` +
                `📞 Dedicated phone number\n` +
                `⚡ Priority routing\n` +
                `🚀 Fastest delivery\n\n` +
                `Your Balance: ${formatCurrency(user.balance)}`;
        }
            
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(currentVip ? '⏰ Extend VIP' : '✅ Confirm Upgrade', 'confirm_vip')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);
        
        await this.sendPhotoWithCaption(ctx, IMAGES.vipFirst, message, keyboard, 'HTML');
    }

    async handleConfirmVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        
        if (user.balance < vipPrice) {
            const message = 
                `❌ <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(vipPrice)}\n` +
                `Available: ${formatCurrency(user.balance)}\n\n` +
                `Deposit first with /deposit`;
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, 
                KEYBOARDS.depositOrBack(), 'HTML'
            );
        }
        
        const expiryDate = new Date();
        // If already VIP, extend from current expiry
        if (this._isVipActive(user) && user.vipExpiry) {
            expiryDate.setTime(new Date(user.vipExpiry).getTime());
        }
        expiryDate.setMonth(expiryDate.getMonth() + 1);
        
        try {
            await User.updateOne(
                { userId: user.userId },
                {
                    $inc: { balance: -vipPrice },
                    $set: { 
                        mode: 'VIP', 
                        vipExpiry: expiryDate, 
                        vipDailyUsed: 0, 
                        vipDailyReset: new Date() 
                    }
                }
            );

            await Transaction.create({
                txId: `VIP_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'VIP_SUBSCRIPTION',
                amount: -vipPrice,
                status: 'COMPLETED',
                metadata: { expiryDate, source: 'VIP_MENU' },
                createdAt: new Date()
            });

            const assignment = await this.assignVipNumber(user.userId, 'US');
            
            let numberText = '';
            if (assignment) {
                numberText = `\n\n📱 <b>Your VIP Number:</b> <code>${assignment.phoneNumber}</code>\n🏢 Provider: ${assignment.provider}`;
            } else {
                numberText = '\n\n⚠️ Your VIP number is being assigned. Use /mynumber to check.';
            }

            const message = 
                `👑 <b>VIP Activated!</b>\n\n` +
                `⏰ Valid until: ${expiryDate.toLocaleDateString()}\n` +
                `✅ 50 OTPs per day\n` +
                `⚡ Priority delivery enabled${numberText}\n\n` +
                `Enjoy premium service!`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 My Number', 'view_my_number')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('VIP purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, 
                '❌ VIP upgrade failed. Please try again.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    }

    async handleCancelVipSubscription(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return ctx.answerCbQuery('❌ No active VIP subscription');
        }

        const message = 
            `❌ <b>Cancel VIP Subscription?</b>\n\n` +
            `📞 Your number: <code>${user.vipPhoneNumber || 'N/A'}</code>\n` +
            `⏰ Expires: <code>${user.vipExpiry ? new Date(user.vipExpiry).toLocaleDateString() : 'N/A'}</code>\n\n` +
            `⚠️ <b>Warning:</b> Your dedicated number will be released immediately.\n\n` +
            `Are you sure?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Yes, Cancel VIP', 'confirm_vip_cancel')],
            [Markup.button.callback('❌ No, Keep VIP', 'view_my_number')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, keyboard, 'HTML');
    }

        async handleConfirmVipCancel(ctx) {
        const userId = ctx.from.id.toString();
        const user = ctx.state.user;
        
        try {
            await this.releaseVipNumber(userId);
            
            await User.updateOne(
                { userId },
                { 
                    $set: { 
                        vipExpiry: new Date(0), 
                        vipDailyUsed: 0,
                        mode: 'FREE'
                    } 
                }
            );

            const message = 
                `✅ <b>VIP Cancelled</b>\n\n` +
                `Your VIP subscription has been cancelled.\n` +
                `📞 Your dedicated number has been released.\n\n` +
                `You can still use FREE and CHEAP modes.`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('VIP cancel failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Failed to cancel VIP');
        }
        }




                    // ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 4: Bundle Qty, VIP Request, Support, Reveal, Deposit
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  BUNDLE QUANTITY HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    async handleBuyBundleOtp(ctx) {
        const user = ctx.state.user;
        const prices = config.prices?.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        
        let message = `📦 <b>Buy Bundle OTPs</b>\n\nSelect quantity:\n\n`;
        const buttons = [];
        
        for (const [qty, price] of Object.entries(prices)) {
            message += `• <code>${qty}</code> OTPs — <code>${formatCurrency(price)}</code>\n`;
            buttons.push([Markup.button.callback(`📦 ${qty} OTPs (${formatCurrency(price)})`, `bundle_qty_${qty}`)]);
        }
        
        message += `\n💰 Your Balance: <code>${formatCurrency(user.balance)}</code>`;
        
        buttons.push(
            [Markup.button.callback('✏️ Custom Amount', 'bundle_qty_custom')],
            [Markup.button.callback('🔙 Back', 'view_my_number')]
        );
        
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleFirst, message, Markup.inlineKeyboard(buttons), 'HTML');
    }

    async handleBundleQuantity(ctx, quantity) {
        const user = ctx.state.user;
        const prices = config.prices?.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        const price = prices[quantity] || (quantity * 0.10);
        
        if (user.balance < price) {
            return this.sendPhotoWithCaption(
                ctx, IMAGES.bundleOther,
                `❌ <b>Insufficient Balance</b>\n\nRequired: <code>${formatCurrency(price)}</code>\nAvailable: <code>${formatCurrency(user.balance)}</code>\n\nDeposit first with /deposit`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'buy_bundle_otp')]
                ]),
                'HTML'
            );
        }

        ctx.session = ctx.session || {};
        ctx.session.bundlePurchase = { quantity, price };

        const message = 
            `📦 <b>Confirm Bundle Purchase</b>\n\n` +
            `Quantity: <code>${quantity}</code> OTPs\n` +
            `Price: <code>${formatCurrency(price)}</code>\n` +
            `Balance After: <code>${formatCurrency(user.balance - price)}</code>\n\n` +
            `These OTPs never expire and can be used with your VIP number.`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_bundle_purchase')],
            [Markup.button.callback('❌ Cancel', 'buy_bundle_otp')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, keyboard, 'HTML');
    }

    async handleBundleQuantityCustom(ctx) {
        ctx.session = ctx.session || {};
        ctx.session.awaitingBundleQuantity = true;
        
        await this.sendPhotoWithCaption(
            ctx, IMAGES.bundleOther,
            '✏️ <b>Custom Bundle Quantity</b>\n\nSend the number of OTPs you want to purchase:\n\n<i>Minimum: 5 | Price: $0.10 per OTP</i>',
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', 'buy_bundle_otp')]
            ]),
            'HTML'
        );
    }

    async handleConfirmBundlePurchase(ctx) {
        const user = ctx.state.user;
        const purchase = ctx.session?.bundlePurchase;
        
        if (!purchase) {
            return ctx.answerCbQuery('❌ Session expired. Please start over.');
        }

        try {
            await User.updateOne(
                { userId: user.userId },
                { $inc: { balance: -purchase.price, bundleRemaining: purchase.quantity } }
            );

            await Transaction.create({
                txId: `BUNDLE_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'BUNDLE_PURCHASE',
                amount: -purchase.price,
                status: 'COMPLETED',
                metadata: { 
                    quantity: purchase.quantity, 
                    pricePerOtp: purchase.price / purchase.quantity,
                    source: 'BUNDLE_OTP_MENU'
                },
                createdAt: new Date()
            });

            ctx.session.bundlePurchase = null;

            const message = 
                `✅ <b>Bundle Purchased!</b>\n\n` +
                `📦 <code>${purchase.quantity}</code> OTPs added\n` +
                `💰 <code>${formatCurrency(purchase.price)}</code> deducted\n` +
                `📦 Total Available: <code>${(user.bundleRemaining || 0) + purchase.quantity}</code> OTPs\n\n` +
                `Use /otp to start requesting.`;

            await this.sendPhotoWithCaption(
                ctx, IMAGES.bundleOther, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 View My Number', 'view_my_number')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );

        } catch (error) {
            logger.error('Bundle purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed,
                '❌ <b>Purchase Failed</b>\n\nPlease try again or contact support.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  REQUEST OTP VIP (direct from My Number screen)
    // ═══════════════════════════════════════════════════════════════════════

    async handleRequestOtpVip(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return ctx.answerCbQuery('❌ VIP required');
        }
        
        if (!this._canUseVip(user)) {
            return ctx.answerCbQuery('❌ Daily limit reached');
        }
        
        if (!user.vipPhoneNumber) {
            const assignment = await this.assignVipNumber(user.userId, 'US');
            if (!assignment) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.vipOther,
                    '⚠️ <b>Number Assignment Pending</b>\n\nPlease try again shortly.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry', 'request_otp_vip')],
                        [Markup.button.callback('🔙 Back', 'view_my_number')]
                    ]),
                    'HTML'
                );
            }
            user.vipPhoneNumber = assignment.phoneNumber;
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        ctx.session.useVipNumber = true;
        
        await this.showServiceSelection(ctx, 'VIP', IMAGES.vipOther);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SUPPORT & UTILITY HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    async handleContactSupport(ctx) {
        await ctx.reply(
            '📞 <b>Contact Support</b>\n\nNeed help? Contact us at @Swiftsmssupport\n\nOur team is available 24/7.',
            { 
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('📞 Contact @Swiftsmssupport', 'https://t.me/Swiftsmssupport')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]).reply_markup
            }
        );
    }

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
    }

    async handleCheckDeposit(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const result = await this.walletService.checkDeposit(userId);
            
            if (!result.found) {
                const message = 
                    '⏳ <b>No Deposit Found</b>\n\n' +
                    'Your deposit hasn\'t been detected yet.\n\n' +
                    'Make sure you:\n' +
                    '1️⃣ Sent to the correct address\n' +
                    '2️⃣ Sent exactly the shown amount\n' +
                    '3️⃣ Used BSC (BEP-20) network\n\n' +
                    '⏱ Check again in 1-2 minutes.';
                
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.default, message,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Check Again', 'check_deposit')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }
            
            if (result.status === 'CONFIRMING') {
                const message = 
                    `⏳ <b>Deposit Confirming</b>\n\n` +
                    `Amount: ${formatCurrency(result.amount)}\n` +
                    `Confirmations: ${result.confirmations || 0}/${config.blockchain?.blockConfirmations || 12}\n\n` +
                    `Please wait for full confirmation.`;
                return this.sendPhotoWithCaption(ctx, IMAGES.default, message, null, 'HTML');
            }
            
            if (result.status === 'CONFIRMED' || result.status === 'CREDITED') {
                const message = 
                    `✅ <b>Deposit Confirmed!</b>\n\n` +
                    `Amount Credited: ${formatCurrency(result.amount)}\n` +
                    (result.trackingFee > 0 ? `Tracking Fee: ${formatCurrency(result.trackingFee)}\n` : '') +
                    `TX Hash: <code>${result.txHash}</code>\n\n` +
                    `Your balance has been updated.`;
                return this.sendPhotoWithCaption(ctx, IMAGES.depositConfirmed, message, null, 'HTML');
            }
        } catch (error) {
            logger.error('Check deposit failed', { userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ Error checking deposit. Please try again.');
        }
    }

    async handleDepositInfo(ctx) {
        const message = 
            '💳 <b>Deposit Information</b>\n\n' +
            'Send USDT (BEP-20) to your deposit address.\n\n' +
            'Your deposit will be credited automatically after confirmation.\n\n' +
            'Use /check_deposit to check status.';
        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, null, 'HTML');
    }

    async handleMenu(ctx) {
        return this.handleOTPCommand(ctx);
        }



            // ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 5: NEW FEATURES
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  HISTORY — View past OTP sessions
    // ═══════════════════════════════════════════════════════════════════════

    async handleHistory(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const sessions = await Session.find({ userId })
                .sort({ createdAt: -1 })
                .limit(10)
                .lean();

            if (!sessions.length) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.history,
                    '📜 <b>No History</b>\n\nYou haven\'t requested any OTPs yet.\n\nUse /otp to get started!',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('📱 Request OTP', 'menu')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }

            let message = '📜 <b>Recent OTP History</b>\n\n';
            
            for (const s of sessions) {
                const statusEmoji = {
                    RECEIVED: '✅',
                    TIMEOUT: '⏰',
                    CANCELLED: '❌',
                    WAITING: '⏳',
                    CHECKING: '🔍'
                }[s.status] || '❓';
                
                const date = new Date(s.createdAt).toLocaleDateString();
                const time = new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                
                message += `${statusEmoji} <b>${s.service}</b> — ${date} ${time}\n`;
                message += `   📱 ${this.maskPhone(s.number)} | ${s.mode}`;
                if (s.otpCode) message += ` | 🔢 ${s.otpCode}`;
                message += '\n\n';
            }

            await this.sendPhotoWithCaption(
                ctx, IMAGES.history, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );
        } catch (error) {
            logger.error('History fetch failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error loading history');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  REFERRAL — Invite friends, earn credits
    // ═══════════════════════════════════════════════════════════════════════

    async handleReferral(ctx) {
        const user = ctx.state.user;
        const botUsername = ctx.botInfo?.username || 'SwiftSMSBot';
        const referralLink = `https://t.me/${botUsername}?start=ref_${user.userId}`;
        
        const referralBonus = config.referral?.bonus || 0.50;
        const referralCount = user.referrals?.length || 0;
        const referralEarnings = user.referralEarnings || 0;

        const message = 
            `👥 <b>Referral Program</b>\n\n` +
            `Invite friends and earn <code>${formatCurrency(referralBonus)}</code> per signup!\n\n` +
            `📊 <b>Your Stats:</b>\n` +
            `• Invited: <code>${referralCount}</code> users\n` +
            `• Earned: <code>${formatCurrency(referralEarnings)}</code>\n\n` +
            `🔗 <b>Your Link:</b>\n<code>${referralLink}</code>\n\n` +
            `<i>Share this link with friends. When they make their first deposit, you get paid!</i>`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.referral, message,
            Markup.inlineKeyboard([
                [Markup.button.url('📤 Share Link', `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Get OTPs instantly with SwiftSMS!')}`)],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  STATS — User statistics dashboard
    // ═══════════════════════════════════════════════════════════════════════

    async handleStats(ctx) {
        const user = ctx.state.user;
        const stats = this._getUserStats(user);

        const totalSessions = await Session.countDocuments({ userId: user.userId });
        const successfulSessions = await Session.countDocuments({ userId: user.userId, status: 'RECEIVED' });
        const successRate = totalSessions > 0 ? Math.round((successfulSessions / totalSessions) * 100) : 0;

        const message = 
            `📊 <b>Your Statistics</b>\n\n` +
            `👤 <b>Account</b>\n` +
            `• Balance: <code>${formatCurrency(stats.balance)}</code>\n` +
            `• Available: <code>${formatCurrency(stats.available)}</code>\n\n` +
            `📱 <b>OTP Usage</b>\n` +
            `• Total Requests: <code>${totalSessions}</code>\n` +
            `• Successful: <code>${successfulSessions}</code>\n` +
            `• Success Rate: <code>${successRate}%</code>\n\n` +
            `👑 <b>VIP Status</b>\n` +
            `• Active: ${stats.isVip ? '✅ Yes' : '❌ No'}\n` +
            `• Days Left: <code>${stats.vipDays}</code>\n` +
            `• Daily Remaining: <code>${stats.vipRemaining}</code>\n\n` +
            `📦 <b>Credits</b>\n` +
            `• Free Today: <code>${stats.freeRemaining}</code>\n` +
            `• Bundle Left: <code>${stats.bundleRemaining}</code>`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.stats, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('📜 Full History', 'history')],
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }

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

    // ═══════════════════════════════════════════════════════════════════════
    //  PROVIDER STATUS — Check system health
    // ═══════════════════════════════════════════════════════════════════════

    async handleProviderStatus(ctx) {
        try {
            let statusMessage = '🔌 <b>System Status</b>\n\n';
            
            if (this.smsProviderManager) {
                const providers = await this.smsProviderManager.getProviderStatus?.() || [];
                
                for (const p of providers) {
                    const emoji = p.healthy ? '🟢' : '🔴';
                    statusMessage += `${emoji} <b>${p.name}</b>: ${p.healthy ? 'Online' : 'Offline'}`;
                    if (p.balance !== undefined) statusMessage += ` | Balance: ${formatCurrency(p.balance)}`;
                    statusMessage += '\n';
                }
            } else {
                statusMessage += '⚠️ Provider manager not available\n';
            }

            statusMessage += '\n📊 <b>General:</b>\n';
            statusMessage += `• Uptime: <code>99.9%</code>\n`;
            statusMessage += `• Avg Delivery: <code>12s</code>\n`;
            statusMessage += `• Queue: <code>Normal</code>`;

            await this.sendPhotoWithCaption(
                ctx, IMAGES.default, statusMessage,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'provider_status')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );
        } catch (error) {
            logger.error('Provider status failed', { error: error.message });
            await ctx.answerCbQuery('❌ Error checking status');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SETTINGS — User preferences
    // ═══════════════════════════════════════════════════════════════════════

    async handleSettings(ctx) {
        const user = ctx.state.user;
        
        const message = 
            `⚙️ <b>Settings</b>\n\n` +
            `🔔 Notifications: ${user.notifications !== false ? '✅ On' : '❌ Off'}\n` +
            `🌐 Language: <code>English</code>\n` +
            `💱 Currency: <code>USD</code>\n\n` +
            `Manage your preferences:`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback(`${user.notifications !== false ? '🔕' : '🔔'} Toggle Notifications`, 'toggle_notifications')],
                [Markup.button.callback('📜 Terms of Service', 'terms')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }

    async handleToggleNotifications(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const user = await User.findOne({ userId });
            const newState = !(user.notifications !== false);
            
            await User.updateOne({ userId }, { $set: { notifications: newState } });
            
            await ctx.answerCbQuery(newState ? '🔔 Notifications enabled' : '🔕 Notifications disabled');
            return this.handleSettings(ctx);
        } catch (error) {
            logger.error('Toggle notifications failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error updating settings');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FAQ — Frequently asked questions
    // ═══════════════════════════════════════════════════════════════════════

    async handleFaq(ctx) {
        const message = 
            `❓ <b>Frequently Asked Questions</b>\n\n` +
            `<b>Q: How long do I wait for an OTP?</b>\n` +
            `A: Usually 5-30 seconds. VIP/CHEAP are fastest. Free may take longer.\n\n` +
            `<b>Q: What if I don't receive my OTP?</b>\n` +
            `A: Free mode has no guarantee. For CHEAP/VIP, contact support if timed out.\n\n` +
            `<b>Q: Can I reuse my VIP number?</b>\n` +
            `A: Yes! Your VIP number is dedicated to you for the subscription period.\n\n` +
            `<b>Q: Do bundle OTPs expire?</b>\n` +
            `A: No, bundle OTPs never expire.\n\n` +
            `<b>Q: What payment methods?</b>\n` +
            `A: We accept USDT (BEP-20) on Binance Smart Chain.\n\n` +
            `<b>Q: Is there a refund policy?</b>\n` +
            `A: Free mode: no refunds. Paid modes: refunded if provider fails.\n\n` +
            `Need more help? Contact @Swiftsmssupport`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('📞 Contact Support', 'contact_support')],
                [Markup.button.callback('📜 Terms', 'terms')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TERMS — Terms of service
    // ═══════════════════════════════════════════════════════════════════════

    async handleTerms(ctx) {
        const message = 
            `📜 <b>Terms of Service</b>\n\n` +
            `By using this bot, you agree to:\n\n` +
            `1️⃣ <b>Legal Use Only</b>\n` +
            `OTP services must be used for legitimate purposes only.\n\n` +
            `2️⃣ <b>No Abuse</b>\n` +
            `Spam, harassment, or fraudulent use will result in permanent ban.\n\n` +
            `3️⃣ <b>Service Availability</b>\n` +
            `We do not guarantee 100% uptime. Free tier is best-effort.\n\n` +
            `4️⃣ <b>Refunds</b>\n` +
            `Refunds are issued only for provider failures, not user error.\n\n` +
            `5️⃣ <b>Data</b>\n` +
            `We store minimal data required for service operation.\n\n` +
            `6️⃣ <b>Changes</b>\n` +
            `Terms may change. Continued use means acceptance.\n\n` +
            `Violation of these terms may result in account suspension.`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('❓ FAQ', 'faq')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }
}

export default OTPCommands;
                
