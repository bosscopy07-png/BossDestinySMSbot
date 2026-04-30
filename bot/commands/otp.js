// ═══════════════════════════════════════════════════════════
//  OTPCommands.js — Complete Implementation
// ═══════════════════════════════════════════════════════════

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

    // ─── User Helpers ────────────────────────────────────────────────────
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

    // ─── Deposit Notification ──────────────────────────────────────────────
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

    // ─── Command Registration ──────────────────────────────────────────────
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
        this.bot.action('confirm_free_mode', this.handleConfirmFreeMode.bind(this));
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
        
        this.bot.action(/check_otp_(.+)/, this.handleCheckOTP.bind(this));
    }

    // ─── Utility Methods ───────────────────────────────────────────────────
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
        const message = this.formatPollStatus(status);
        try {
            await ctx.reply(message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.debug('Poll update send failed', { error: error.message });
        }
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }

    // ─── Main Menu & My Number ─────────────────────────────────────────────
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

        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

        const keyboard = Markup.inlineKeyboard(buttons);
        await this.sendPhotoWithCaption(ctx, IMAGES.otpMenu, message, keyboard, 'HTML');
    }

    async handleMyNumberCommand(ctx) {
        return this.handleViewMyNumber(ctx);
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

    // ─── Mode Handlers ─────────────────────────────────────────────────────
    async handleFreeMode(ctx) {
        const user = ctx.state.user;
        
        if (!this._canUseFree(user)) {
            const message = 
                '❌ <b>Free Limit Reached</b>\n\n' +
                'You\'ve used all 3 free OTPs today.\n\n' +
                '💰 Deposit to continue:\n' +
                '• CHEAP: $0.05 per OTP\n' +
                '• Bundle: $5 for 100 OTPs';
                
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            
            return this.sendPhotoWithCaption(ctx, IMAGES.freeMode, message, keyboard, 'HTML');
        }

        const warningMessage = 
            '⚠️ <b>Free Mode Notice</b>\n\n' +
            '📵 Free numbers are <b>shared</b> and may be <b>blocked</b> by:\n' +
            '• WhatsApp, Telegram\n' +
            '• Google, Facebook, Instagram\n' +
            '• Banks, Binance, PayPal\n\n' +
            '✅ For <b>guaranteed</b> delivery, use:\n' +
            '• 💰 CHEAP — $0.05/OTP\n' +
            '• 📦 BUNDLE — $5 for 100 OTPs\n\n' +
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
        const cheapPrice = config.prices?.cheapOtp || 0.05;
        
        if (this._getAvailableBalance(user) < cheapPrice) {
            const message = 
                `💰 <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(cheapPrice)}\n` +
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
                `Includes: Unlimited OTPs (50/day max)\n\n` +
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
                'You\'ve used 50/50 VIP OTPs today.\n' +
                'Resets at midnight UTC.';
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, null, 'HTML');
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

    // ─── Service & Country Selection ───────────────────────────────────────
    async showServiceSelection(ctx, mode, imageUrl) {
        const message = `📱 <b>${mode} Mode</b>\n\nChoose the service you need OTP for:`;
        const buttons = [];
        
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
        
        const message = `🌍 <b>Select Country</b>\n\nChoose number country for ${service}:`;
        const buttons = COUNTRIES.map(c => [
            Markup.button.callback(
                `${c.flag} ${c.name}${c.priceModifier > 0 ? ` (+$${c.priceModifier})` : ''}`, 
                `country_${c.code}`
            )
        ]);
        
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, IMAGES.countrySelect, message, Markup.inlineKeyboard(buttons), 'HTML');
    }

    // ─── Country Selected — ACQUIRE NUMBER ────────────────────────────────
    async handleCountrySelect(ctx) {
        const country = ctx.match[1];
        const userId = ctx.from.id.toString();
        const mode = ctx.session?.otpMode;
        const service = ctx.session?.otpService;
        const useVipNumber = ctx.session?.useVipNumber;
        
        if (!mode || !service) {
            return this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ Session expired. Please start over with /otp');
        }

        try {
            const loadingMsg = await ctx.reply('⏳ Assigning number...');

            // VIP/BUNDLE with VIP number
            if (useVipNumber && this._isVipActive(ctx.state.user) && ctx.state.user.vipPhoneNumber) {
                const user = ctx.state.user;
                
                if (mode === 'VIP') {
                    await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });
                } else if (mode === 'BUNDLE') {
                    await User.updateOne({ userId }, { $inc: { bundleRemaining: -1 } });
                }

                await ctx.deleteMessage(loadingMsg.message_id);

                const costText = mode === 'VIP' ? 'VIP (daily quota)' : 'BUNDLE (1 credit)';

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: ${mode}\n` +
                    `📱 Number: <code>${user.vipPhoneNumber}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: ${costText}\n\n` +
                    `⚠️ Your dedicated VIP number. OTP will arrive shortly.`;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('🔍 Check OTP', `check_otp_${userId}_${Date.now()}`)],
                    [Markup.button.callback('❌ Cancel', 'cancel_otp')]
                ]);
                
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

            // Standard flow
            if (mode === 'BUNDLE') {
                const user = await User.findOne({ userId });
                if (!user?.bundleRemaining || user.bundleRemaining <= 0) {
                    await ctx.deleteMessage(loadingMsg.message_id);
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
            }

            // INTEGRATED: Use SMSProviderManager for FREE and CHEAP tiers
            let session;
            
            if (mode === 'FREE' && this.smsProviderManager) {
                const freeResult = await this.smsProviderManager.getNumber('FREE', country, service);
                
                session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    freeResult.phoneNumber, 'FREE_PUBLIC',
                    freeResult.sessionId
                );
                
                this.startFreePolling(ctx, userId, freeResult.sessionId, session.sessionId);
                
            } else if (mode === 'CHEAP' && this.smsProviderManager) {
                const cheapResult = await this.smsProviderManager.getNumber('CHEAP', country, service);
                
                session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    cheapResult.phoneNumber, cheapResult.provider,
                    cheapResult.providerNumberId
                );
                
            } else {
                session = await sessionManager.createSession(userId, mode, service, country);
            }

            await ctx.deleteMessage(loadingMsg.message_id);

            const costText = mode === 'FREE' ? 'FREE' : 
                            mode === 'BUNDLE' ? 'BUNDLE (1 credit used)' : 
                            formatCurrency(session.cost);

            const message = 
                `📱 <b>OTP Request Started</b>\n\n` +
                `🌍 Mode: ${mode}\n` +
                `📱 Number: <code>${session.number}</code>\n` +
                `🎯 Service: ${service}\n` +
                `⏳ Status: Waiting for OTP...\n` +
                `💰 Cost: ${costText}\n` +
                `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                `⚠️ ${mode === 'FREE' ? 'Shared number. OTP not guaranteed.' : mode === 'BUNDLE' ? 'Bundle credit used. No additional charge.' : 'Funds locked. Will be deducted on delivery.'}`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔍 Check OTP', `check_otp_${session.sessionId}`)],
                [Markup.button.callback('❌ Cancel', 'cancel_otp')]
            ]);
            
            const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

            if (sentMessage?.message_id) {
                await this._scheduleTimeoutNotification(
                    userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                );
            }

        } catch (error) {
            logger.error('OTP session creation failed', { userId, mode, service, error: error.message });
            
            if (mode === 'BUNDLE') {
                await User.updateOne({ userId }, { $inc: { bundleRemaining: 1 } }).catch(() => {});
            } else if (mode === 'VIP' && useVipNumber) {
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
                NO_BALANCE: '💰 5SIM balance insufficient. Fund wallet or use FREE tier.',
                ALL_PROVIDERS_FAILED: '❌ All providers failed. Try again later or different country.',
                NO_PROVIDERS_AVAILABLE: '❌ No providers available. Check /status.'
            };
            
            await this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed, 
                errorMessages[error.message] || `❌ Error: ${error.message}`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Retry', 'menu')],
                    [Markup.button.callback('📞 Support', 'contact_support')]
                ]),
                'HTML'
            );
        }
    }

    // ─── Free Tier Polling ─────────────────────────────────────────────────
    async startFreePolling(ctx, userId, freeSessionId, dbSessionId) {
        if (!this.smsProviderManager) return;

        try {
            const smsResult = await this.smsProviderManager.pollFreeSMS(
                freeSessionId,
                (status) => this.sendPollUpdate(ctx, status)
            );

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

                const message = 
                    `🔓 <b>OTP Received!</b>\n\n` +
                    `📱 Number: <code>${smsResult.number}</code>\n` +
                    `🔢 OTP: <code>${smsResult.otp}</code>\n` +
                    `⏱ Delivery: ${smsResult.deliveryTime}ms\n\n` +
                    `⚠️ Do not share this code with anyone.`;

                await this.bot.telegram.sendMessage(userId, message, {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back to Menu', 'menu')]
                    ]).reply_markup
                });

            } else if (smsResult.status === 'TIMEOUT') {
                logger.info('Free tier timeout', { userId, sessionId: dbSessionId });
            }

        } catch (error) {
            logger.error('Free polling failed', { userId, error: error.message });
        }
    }

    // ─── Check OTP ─────────────────────────────────────────────────────────
    async handleCheckOTP(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const activeSession = await Session.findOne({ 
                userId, 
                status: { $in: ['WAITING', 'CHECKING', 'RECEIVED'] }
            }).sort({ createdAt: -1 });

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
                        [Markup.button.callback('🔙 Back to Menu', 'menu')]
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
                if (ctx.callbackQuery?.message) {
                    await ctx.editMessageCaption(updatedMessage, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard.reply_markup
                    });
                } else {
                    await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, updatedMessage, keyboard, 'HTML');
                }
            } catch (editError) {
                await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, updatedMessage, keyboard, 'HTML');
            }

        } catch (error) {
            logger.error('Check OTP failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error checking OTP status');
        }
    }

    // ─── Timeout Notification ──────────────────────────────────────────────
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
                    
                    if (!session) return;

                    await Session.updateOne(
                        { sessionId },
                        { $set: { status: 'TIMEOUT', endTime: new Date() } }
                    );

                    if (session.mode === 'BUNDLE') {
                        await User.updateOne({ userId }, { $inc: { bundleRemaining: 1 } }).catch(() => {});
                    } else if (session.mode === 'VIP') {
                        await User.updateOne({ userId }, { $inc: { vipDailyUsed: -1 } }).catch(() => {});
                    } else if (session.mode === 'CHEAP' && session.cost > 0) {
                        await User.updateOne(
                            { userId }, 
                            { $inc: { lockedBalance: -session.cost, balance: session.cost } }
                        ).catch(() => {});
                    }

                    const timeoutMessage = 
                        `⏰ <b>OTP Request Timed Out</b>\n\n` +
                        `📱 Number: <code>${session.number}</code>\n` +
                        `🎯 Service: ${session.service}\n` +
                        `⏱ Status: <b>Expired</b>\n\n` +
                        `💰 ${session.mode === 'FREE' ? 'No charges (FREE mode)' : 
                             session.mode === 'BUNDLE' ? 'Bundle credit restored' :
                             session.mode === 'VIP' ? 'VIP daily quota restored' :
                             'Funds returned to balance'}\n\n` +
                        `You can request a new OTP with /otp`;

                    await this.bot.telegram.sendMessage(userId, timeoutMessage, {
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔄 Request New OTP', 'menu')],
                            [Markup.button.callback('📞 Contact Support', 'contact_support')]
                        ]).reply_markup
                    });

                } catch (notifyError) {
                    logger.error('Timeout notification failed', { userId, sessionId, error: notifyError.message });
                }
            }, delayMs);

        } catch (error) {
            logger.error('Failed to schedule timeout', { userId, sessionId, error: error.message });
        }
    }

    // ─── Cancel Handler ────────────────────────────────────────────────────

   async handleCancel(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const activeSession = await Session.findOne({ 
                userId, 
                status: { $in: ['WAITING', 'CHECKING'] } 
            });
            
            if (!activeSession) {
                return this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ No active session to cancel.');
            }
            
            const sessionMode = activeSession.mode;
            const sessionCost = activeSession.cost || 0;
            
            await sessionManager.cancelSession(activeSession.sessionId, userId);
            
            let refundText = '';
            if (sessionMode === 'BUNDLE') {
                await User.updateOne({ userId }, { $inc: { bundleRemaining: 1 } }).catch(() => {});
                refundText = '💰 Bundle credit restored.\n';
            } else if (sessionMode === 'VIP') {
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: -1 } }).catch(() => {});
                refundText = '💰 VIP daily quota restored.\n';
            } else if (sessionMode === 'CHEAP' && sessionCost > 0) {
                await User.updateOne(
                    { userId }, 
                    { $inc: { lockedBalance: -sessionCost, balance: sessionCost } }
                ).catch(() => {});
                refundText = '💰 Funds returned to your balance.\n';
            }

            if (sessionMode === 'FREE' && activeSession.providerSessionId && this.smsProviderManager) {
                await this.smsProviderManager.cancelNumber('FREE_PUBLIC', activeSession.providerSessionId)
                    .catch(() => {});
            }
            
            const message = 
                `✅ <b>Session Cancelled</b>\n\n` +
                `📱 Number: <code>${activeSession.number}</code>\n` +
                `${refundText}` +
                `You can start a new request now.`;
            
            await this.sendPhotoWithCaption(ctx, IMAGES.default, message, null, 'HTML');
            
        } catch (error) {
            logger.error('Cancel failed', { userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ Failed to cancel session. Please try again.');
        }
    }

    // ─── Bundle & VIP Purchases ────────────────────────────────────────────
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
        
        await User.updateOne(
            { userId: user.userId }, 
            { $inc: { balance: -bundlePrice, bundleRemaining: bundleCount } }
        );
        
        const message = 
            `✅ <b>Bundle Purchased!</b>\n\n` +
            `📦 ${bundleCount} OTPs added\n` +
            `💰 ${formatCurrency(bundlePrice)} deducted\n` +
            `📦 Total Available: ${(user.bundleRemaining || 0) + bundleCount} OTPs\n\n` +
            `Use /otp to start requesting.`;
            
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, null, 'HTML');
    }

    async handleBuyVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        
        const message = 
            `👑 <b>Upgrade to VIP</b>\n\n` +
            `💰 Price: ${formatCurrency(vipPrice)}/month\n` +
            `✅ Unlimited OTPs (50/day)\n` +
            `⚡ Priority routing\n` +
            `🚀 Fastest delivery\n\n` +
            `Your Balance: ${formatCurrency(user.balance)}`;
            
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Upgrade', 'confirm_vip')],
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
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, null, 'HTML');
        }
        
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + 1);
        
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
            `✅ Unlimited OTPs (50/day)\n` +
            `⚡ Priority delivery enabled${numberText}\n\n` +
            `Enjoy premium service!`;
            
        await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, null, 'HTML');
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

    // ─── Bundle Quantity Handlers ──────────────────────────────────────────
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

            const { Transaction } = await import('../../models/index.js');
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
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Retry', 'buy_bundle_otp')],
                    [Markup.button.callback('📞 Contact Support', 'contact_support')]
                ]),
                'HTML'
            );
        }
    }

    // ─── Support & Utility Handlers ────────────────────────────────────────
    async handleContactSupport(ctx) {
        await ctx.reply(
            '📞 <b>Contact Support</b>\n\nNeed help? Contact us at @Swiftsmssupport\n\nOur team is available 24/7.',
            { 
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('📞 Contact @Swiftsmssupport', 'https://t.me/Swiftsmssupport')]
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
        await ctx.reply('🏠 Main Menu');
    }
}

export default OTPCommands;
