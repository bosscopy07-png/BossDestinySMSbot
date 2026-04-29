// ==================== PART 1: CONSTANTS & IMAGES ====================

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
// ==================== PART 2: CLASS & HELPERS ====================

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
        // ==================== PART 3: VIP NUMBER MANAGEMENT ====================

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
    // ==================== PART 4: DEPOSIT NOTIFICATION & REGISTRATION ====================

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
    // ⭐ NEW: Added 'check_otp' action handler

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
        
        // ⭐ NEW: Check OTP button handler
        this.bot.action(/check_otp_(.+)/, this.handleCheckOTP.bind(this));
    }
    // ==================== PART 5: UTILITY METHODS ====================

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
    
