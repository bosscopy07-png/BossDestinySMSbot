import { Markup } from 'telegraf';
import { Session, User, Number as NumberModel } from '../../models/index.js';
import { COUNTRIES, SERVICES } from '../../utils/constants.js';
import { formatCurrency, maskOTP } from '../../utils/helpers.js';
import sessionManager from '../../services/otp/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

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
    banned: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png'
};

class OTPCommands {
    constructor(bot, walletService, smsProviderManager = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.smsProviderManager = smsProviderManager;
        this.registerCommands();
        this.walletService.onDepositNotification(this.handleDepositNotification.bind(this));
    }

    // ─── Helper methods using User statics (works with plain objects) ───
    _canUseFree(user) {
        return User.canUseFree ? User.canUseFree(user) : (user.freeUsedToday || 0) < 3;
    }

    _canUseVip(user) {
        return User.canUseVip ? User.canUseVip(user) : 
            (user.vipExpiry && new Date(user.vipExpiry) > new Date() && (user.vipDailyUsed || 0) < (config.limits?.vipDaily || 50));
    }

    _isVipActive(user) {
        return User.isVipActive ? User.isVipActive(user) : 
            !!(user.vipExpiry && new Date(user.vipExpiry) > new Date());
    }

    _getAvailableBalance(user) {
        return User.getAvailableBalance ? User.getAvailableBalance(user) : 
            (user.balance || 0) - (user.lockedBalance || 0);
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

    // ─── VIP Number Management ───────────────────────────────────────────

    /**
     * Auto-assign a VIP number to user on subscription.
     * Called after successful VIP purchase.
     */
    async assignVipNumber(userId, country = 'US', preferredProvider = null) {
        try {
            if (!this.smsProviderManager?.numberPool) {
                logger.warn('No number pool available for VIP assignment', { userId });
                return null;
            }

            const assignment = await this.smsProviderManager.numberPool.acquireNumber(
                country,
                'VIP_SUBSCRIPTION',
                userId,
                preferredProvider
            );

            // Save to user record
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
                userId,
                phone: assignment.phoneNumber,
                provider: assignment.provider
            });

            return assignment;
        } catch (error) {
            logger.error('VIP number assignment failed', { userId, error: error.message });
            return null;
        }
    }

    /**
     * Release VIP number when subscription expires or is cancelled.
     */
    async releaseVipNumber(userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user?.vipNumberId) return { success: true, note: 'No VIP number assigned' };

            if (this.smsProviderManager?.numberPool) {
                await this.smsProviderManager.numberPool.releaseNumber(
                    user.vipNumberId,
                    'VIP_EXPIRED'
                );
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

    // ─── Deposit Notification ────────────────────────────────────────────

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
            logger.error('Failed to send deposit notification', { userId, error: error.message });
        }
    }

    // ─── Command Registration ────────────────────────────────────────────

    registerCommands() {
        this.bot.command('otp', this.handleOTPCommand.bind(this));
        this.bot.command('mynumber', this.handleMyNumberCommand.bind(this));
        this.bot.command('cancel', this.handleCancel.bind(this));
        this.bot.action('mode_free', this.handleFreeMode.bind(this));
        this.bot.action('mode_cheap', this.handleCheapMode.bind(this));
        this.bot.action('mode_vip', this.handleVIPMode.bind(this));
        this.bot.action('mode_bundle', this.handleBundleMode.bind(this));
        this.bot.action('view_my_number', this.handleViewMyNumber.bind(this));
        this.bot.action('request_otp_vip', this.handleRequestOtpVip.bind(this));
        this.bot.action('buy_bundle_otp', this.handleBuyBundleOtp.bind(this));
        this.bot.action('bundle_qty_5', (ctx) => this.handleBundleQuantity(ctx, 5));
        this.bot.action('bundle_qty_10', (ctx) => this.handleBundleQuantity(ctx, 10));
        this.bot.action('bundle_qty_25', (ctx) => this.handleBundleQuantity(ctx, 25));
        this.bot.action('bundle_qty_50', (ctx) => this.handleBundleQuantity(ctx, 50));
        this.bot.action('bundle_qty_custom', this.handleBundleQuantityCustom.bind(this));
        this.bot.action('confirm_bundle_purchase', this.handleConfirmBundlePurchase.bind(this));
        this.bot.action(/service_(.+)/, this.handleServiceSelect.bind(this));
        this.bot.action(/country_(.+)/, this.handleCountrySelect.bind(this));
        this.bot.action('buy_bundle', this.handleBuyBundle.bind(this));
        this.bot.action('buy_vip', this.handleBuyVIP.bind(this));
        this.bot.action('confirm_bundle', this.handleConfirmBundle.bind(this));
        this.bot.action('confirm_vip', this.handleConfirmVIP.bind(this));
        this.bot.action(/reveal_(.+)/, this.handleRevealOTP.bind(this));
        this.bot.action('check_deposit', this.handleCheckDeposit.bind(this));
        this.bot.action('cancel_otp', this.handleCancel.bind(this));
        this.bot.action('deposit', this.handleDepositInfo.bind(this));
        this.bot.action('menu', this.handleMenu.bind(this));
        this.bot.action('contact_support', this.handleContactSupport.bind(this));
        this.bot.action('cancel_vip_subscription', this.handleCancelVipSubscription.bind(this));
    }

    async sendPhotoWithCaption(ctx, imageUrl, caption, keyboard = null, parseMode = 'Markdown') {
        try {
            const payload = { caption: caption.trim(), parse_mode: parseMode };
            if (keyboard) payload.reply_markup = keyboard.reply_markup;
            return ctx.replyWithPhoto(imageUrl, payload);
        } catch (error) {
            logger.error('Photo send failed', { error: error.message });
            return keyboard
                ? ctx.reply(caption, { parse_mode: parseMode, ...keyboard })
                : ctx.reply(caption, { parse_mode: parseMode });
        }
    }

    // ─── Main OTP Menu ───────────────────────────────────────────────────

    async handleOTPCommand(ctx) {
        const user = ctx.state.user;
        const isVip = this._isVipActive(user);
        const hasBundle = (user.bundleRemaining || 0) > 0;

        let message = '📱 <b>Request OTP</b>\n\nSelect your preferred mode:';
        
        const buttons = [
            [Markup.button.callback('🆓 FREE', 'mode_free'), Markup.button.callback('💰 CHEAP', 'mode_cheap')]
        ];

        // Show bundle button if user has credits or is VIP
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

        // Add "My Number" button for VIP users
        if (isVip && user.vipPhoneNumber) {
            buttons.push([Markup.button.callback('📱 View My Number', 'view_my_number')]);
        }

        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

        const keyboard = Markup.inlineKeyboard(buttons);
        await this.sendPhotoWithCaption(ctx, IMAGES.otpMenu, message, keyboard, 'HTML');
    }

    // ─── My Number Dashboard ─────────────────────────────────────────────

    async handleMyNumberCommand(ctx) {
        return this.handleViewMyNumber(ctx);
    }

    async handleViewMyNumber(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return this.sendPhotoWithCaption(
                ctx,
                IMAGES.vipFirst,
                '❌ <b>Not a VIP User</b>\n\nYou need an active VIP subscription to have a dedicated number.\n\nUpgrade to VIP now?',
                Markup.inlineKeyboard([
                    [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );
        }

        if (!user.vipPhoneNumber) {
            // Auto-assign if missing
            const assignment = await this.assignVipNumber(user.userId, 'US');
            if (!assignment) {
                return this.sendPhotoWithCaption(
                    ctx,
                    IMAGES.vipFirst,
                    '⚠️ <b>Number Assignment Pending</b>\n\nWe\'re assigning your VIP number. Please try again in a moment.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry', 'view_my_number')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }
            // Refresh user data
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

    // ─── VIP OTP Request ─────────────────────────────────────────────────

    async handleRequestOtpVip(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user) || !user.vipPhoneNumber) {
            return ctx.answerCbQuery('❌ VIP number not available');
        }

        if (!this._canUseVip(user)) {
            return this.sendPhotoWithCaption(
                ctx,
                IMAGES.vipOther,
                '⚠️ <b>Daily Limit Reached</b>\n\nYou\'ve used all your VIP OTPs for today (50/50).\n\nResets at midnight UTC.\n\nBuy bundle OTPs to continue:',
                Markup.inlineKeyboard([
                    [Markup.button.callback('📦 Buy Bundle OTPs', 'buy_bundle_otp')],
                    [Markup.button.callback('🔙 Back', 'view_my_number')]
                ]),
                'HTML'
            );
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        ctx.session.useVipNumber = true;
        
        await this.showServiceSelection(ctx, 'VIP', IMAGES.vipOther);
    }

    // ─── Bundle OTP Purchase ─────────────────────────────────────────────

    async handleBuyBundleOtp(ctx) {
        const user = ctx.state.user;
        const prices = config.prices?.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        
        let message = 
            `📦 <b>Buy Bundle OTPs</b>\n\n` +
            `Select quantity:\n\n`;
        
        const buttons = [];
        
        for (const [qty, price] of Object.entries(prices)) {
            message += `• <code>${qty}</code> OTPs — <code>${formatCurrency(price)}</code>\n`;
            buttons.push([Markup.button.callback(`📦 ${qty} OTPs (${formatCurrency(price)})`, `bundle_qty_${qty}`)]);
        }
        
        message += `\n💰 Your Balance: <code>${formatCurrency(user.balance)}</code>`;
        
        buttons.push([Markup.button.callback('✏️ Custom Amount', 'bundle_qty_custom')]);
        buttons.push([Markup.button.callback('🔙 Back', 'view_my_number')]);
        
        const keyboard = Markup.inlineKeyboard(buttons);
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleFirst, message, keyboard, 'HTML');
    }

    async handleBundleQuantity(ctx, quantity) {
        const user = ctx.state.user;
        const prices = config.prices?.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        const price = prices[quantity] || (quantity * 0.10);
        
        if (user.balance < price) {
            return this.sendPhotoWithCaption(
                ctx,
                IMAGES.bundleOther,
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
        // Store state to await custom quantity input
        ctx.session = ctx.session || {};
        ctx.session.awaitingBundleQuantity = true;
        
        await this.sendPhotoWithCaption(
            ctx,
            IMAGES.bundleOther,
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
                {
                    $inc: { balance: -purchase.price, bundleRemaining: purchase.quantity }
                }
            );

            // Create transaction record
            const { default: Transaction } = await import('../../models/index.js'
