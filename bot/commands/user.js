// ═══════════════════════════════════════════════════════════════════════════════
//  commands/userCommands.js — Complete User Commands with Naira Deposit Support
//  Preserves: ALL existing USDT BEP-20 deposit functionality
//  Adds: Full Naira (₦) deposit flow via Paystack
// ═══════════════════════════════════════════════════════════════════════════════

import { Markup } from 'telegraf';
import QRCode from 'qrcode';
import { User, Session, Transaction, Referral, Payment } from '../../models/index.js';
import { COUNTRIES, SERVICES } from '../../utils/constants.js';
import { formatCurrency, generateReferralCode, isNewDay } from '../../utils/helpers.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import paymentService from '../../services/payment/paymentService.js';
import exchangeRateService from '../../services/payment/exchangeRate.service.js';

// ═══════════════════════════════════════════════════════════
//  IMAGE ASSETS
// ═══════════════════════════════════════════════════════════

const IMAGES = Object.freeze({
    welcome: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231506/file_0000000091ec71f4aab72fba467f0816_rgeuyd.png',
    mainMenu: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231491/file_0000000046a87246a25fc17f6f9e23ad_a92mlc.png',
    deposit: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235826/file_000000001c0c720aa51ae407e6741ca5_steie1.png',
    depositConfirmed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231494/file_00000000f5e0720a9dcc0b876fd6cd16_ctv3ww.png',
    referral: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231491/file_00000000270c71f4ba15ce962f19608a_s2vezb.png',
    stats: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235813/file_00000000bd6872438ea7ffa6d8e24a9b_aedrwq.png',
    balance: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235815/file_000000006c547246894f39172e0e16f9_xjcbxj.png',
    history: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235813/file_000000009d2c71f48ff0e002646b16ec_yil08l.png',
    support: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235819/file_000000001a2c71f4874aa9f7f5bfe40e_vxehy2.png',
    default: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235807/file_000000002930724688cd84d89728bc31_gfgpbk.png'
});

// ═══════════════════════════════════════════════════════════
//  TRANSACTION TYPES
// ═══════════════════════════════════════════════════════════

const TX_TYPES = Object.freeze({
    DEPOSIT: 'DEPOSIT',
    NAIRA_DEPOSIT: 'NAIRA_DEPOSIT',
    BUNDLE_PURCHASE: 'BUNDLE_PURCHASE',
    VIP_SUBSCRIPTION: 'VIP_SUBSCRIPTION',
    CHEAP_OTP: 'CHEAP_OTP',
    REFERRAL_REWARD: 'REFERRAL_REWARD'
});

// ═══════════════════════════════════════════════════════════
//  SUPPORT CONTACT
// ═══════════════════════════════════════════════════════════

const SUPPORT_USERNAME = 'swiftsmssupport_bot';
const SUPPORT_URL = 'https://t.me/swiftsmssupport_bot';

// ═══════════════════════════════════════════════════════════
//  WALLET DEEP LINKS - For QR code wallet buttons
// ═══════════════════════════════════════════════════════════

const WALLET_LINKS = Object.freeze({
    trust: { name: 'Trust Wallet', icon: '🛡️', url: (addr, amt) => `https://link.trustwallet.com/send?asset=c20000714_t0x55d398326f99059fF775485246999027B3197955&address=${addr}&amount=${amt}&memo=SwiftSMS` },
    metamask: { name: 'MetaMask', icon: '🦊', url: (addr, amt) => `https://metamask.app.link/send/0x55d398326f99059fF775485246999027B3197955@56/transfer?address=${addr}&uint256=${Math.round(amt * 1e6)}` },
    binance: { name: 'Binance', icon: '🔶', url: (addr, amt) => `https://app.binance.com/cedefi/transfer?address=${addr}&asset=USDT&amount=${amt}&network=BSC` },
    safepal: { name: 'SafePal', icon: '🛡️', url: (addr, amt) => `https://link.safepal.io/send?address=${addr}&amount=${amt}&token=USDT&chain=bsc` },
    tokenpocket: { name: 'TokenPocket', icon: '👛', url: (addr, amt) => `https://transfer?token=USDT&to=${addr}&amount=${amt}&chain=bsc` },
    okx: { name: 'OKX', icon: '🔵', url: (addr, amt) => `https://wallet/send?address=${addr}&amount=${amt}&token=USDT&chain=bsc` },
    bitget: { name: 'Bitget', icon: '🔴', url: (addr, amt) => `https://transfer?address=${addr}&amount=${amt}&token=USDT&chain=bsc` }
});

// ═══════════════════════════════════════════════════════════
//  NAIRA DEPOSIT CONFIG
// ═══════════════════════════════════════════════════════════

const NAIRA_CONFIG = Object.freeze({
    minDeposit: parseInt(config.payment?.minDepositNgn) || 500
});

class UserCommands {
    // ═══════════════════════════════════════════════════════════
    //  CONSTRUCTOR — Added paymentService, naira handler
    // ═══════════════════════════════════════════════════════════
    constructor(bot, walletService, referralService = null, notificationService = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.referralService = referralService;
        this.notificationService = notificationService;
        this.registerCommands();
    }

    registerCommands() {
        // ─── Slash Commands ─────────────────────────────────────────────
        this.bot.command('menu', this.handleMenu.bind(this));
        this.bot.command('balance', this.handleBalance.bind(this));
        this.bot.command('deposit', this.handleDeposit.bind(this));
        this.bot.command('history', this.handleHistory.bind(this));
        this.bot.command('referral', this.handleReferral.bind(this));
        this.bot.command('stats', this.handleStats.bind(this));
        this.bot.command('settings', this.handleSettings.bind(this));
        this.bot.command('support', this.handleSupport.bind(this));
        this.bot.command('buybundle', this.handleBuyBundle.bind(this));
        this.bot.command('buyvip', this.handleBuyVIP.bind(this));
        this.bot.command('refdebug', this.handleRefDebug.bind(this));
        
        // ─── Callback Actions ───────────────────────────────────────────
        this.bot.action('menu', this.handleMenu.bind(this));
        this.bot.action('deposit', this.handleDeposit.bind(this));
        this.bot.action('balance', this.handleBalance.bind(this));
        this.bot.action('history', this.handleHistory.bind(this));
        this.bot.action('referral', this.handleReferral.bind(this));
        this.bot.action('stats', this.handleStats.bind(this));
        this.bot.action('settings', this.handleSettings.bind(this));
        this.bot.action('support', this.handleSupport.bind(this));
        this.bot.action('check_deposit', this.handleCheckDeposit.bind(this));
        this.bot.action('deposit_qr', this.handleDepositQR.bind(this));
        this.bot.action('request_otp', this.handleRequestOTP.bind(this));
        this.bot.action('help', this.handleHelp.bind(this));

        this.bot.action('buy_bundle', this.handleBuyBundle.bind(this));
        this.bot.action('buy_vip', this.handleBuyVIP.bind(this));

        this.bot.action('toggle_privacy', this.handleTogglePrivacy.bind(this));
        this.bot.action('toggle_notifications', this.handleToggleNotifications.bind(this));
        this.bot.action('change_country', this.handleChangeCountry.bind(this));

        this.bot.action('export_history', this.handleExportHistory.bind(this));

        // ─── USDT Deposit Presets ───────────────────────────────────────
        this.bot.action('deposit_5', (ctx) => this.handlePresetDeposit(ctx, 5));
        this.bot.action('deposit_10', (ctx) => this.handlePresetDeposit(ctx, 10));
        this.bot.action('deposit_20', (ctx) => this.handlePresetDeposit(ctx, 20));
        this.bot.action('deposit_50', (ctx) => this.handlePresetDeposit(ctx, 50));
        this.bot.action('deposit_100', (ctx) => this.handlePresetDeposit(ctx, 100));
        this.bot.action('deposit_custom', this.handleCustomDeposit.bind(this));

        // ─── USDT Deposit Flow ──────────────────────────────────────────
        this.bot.action('deposit_usdt', this.handleUsdtDeposit.bind(this));

        // ─── Naira Deposit Flow ─────────────────────────────────────────
        this.bot.action('deposit_naira', this.handleNairaDepositStart.bind(this));
        this.bot.action('naira_confirm_amount', this.handleNairaConfirmAmount.bind(this));
        this.bot.action('naira_cancel', this.handleNairaCancel.bind(this));
        this.bot.action('naira_check_status', this.handleNairaCheckStatus.bind(this));

        // ─── Other Callbacks ────────────────────────────────────────────
        this.bot.action(/share_(.+)/, this.handleShareReferral.bind(this));
        this.bot.action(/setcountry_(.+)/, this.handleSetCountry.bind(this));
        this.bot.action(/copy_address_(.+)/, this.handleCopyAddress.bind(this));
        this.bot.action(/share_address_(.+)/, this.handleShareAddress.bind(this));

        // ─── Text Input Handlers ────────────────────────────────────────
        this.bot.on('text', async (ctx, next) => {
            // Naira amount input
            if (ctx.session?.awaitingNairaAmount) {
                delete ctx.session.awaitingNairaAmount;
                return this.handleNairaAmountInput(ctx);
            }
            // USDT custom deposit
            if (ctx.session?.awaitingDepositAmount) {
                delete ctx.session.awaitingDepositAmount;
                return this.handleDepositAmountInput(ctx);
            }
            // Custom country
            if (ctx.session?.awaitingCustomCountry) {
                delete ctx.session.awaitingCustomCountry;
                return this.handleCustomCountryInput(ctx);
            }
            return next();
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  USER HELPERS
    // ═══════════════════════════════════════════════════════════

    async _ensureUserFresh(ctx) {
        const userId = ctx.from.id.toString();

        let user = await User.findOne({ userId });

        if (!user) {
            user = new User({
                userId,
                username: ctx.from.username || null,
                firstName: ctx.from.first_name || '',
                lastName: ctx.from.last_name || '',
                balance: 0,
                lockedBalance: 0,
                bundleRemaining: 0,
                freeUsedToday: 0,
                freeResetDate: new Date(),
                vipExpiry: null,
                vipDailyUsed: 0,
                vipDailyReset: new Date(),
                mode: 'FREE',
                isBlacklisted: false,
                referralCode: generateReferralCode(),
                referralCount: 0,
                referralEarnings: 0,
                referralRewardsPending: 0,
                referralBonusReceived: false,
                totalDeposited: 0,
                totalSpent: 0,
                privacyEnabled: false,
                notificationsEnabled: true,
                preferredCountry: 'US',
                createdAt: new Date(),
                lastActive: new Date()
            });
            await user.save();
        }

        const now = new Date();
        let needsUpdate = false;
        const updates = {};

        if (isNewDay(user.freeResetDate)) {
            updates.freeUsedToday = 0;
            updates.freeResetDate = now;
            needsUpdate = true;
        }

        if (user.vipDailyReset && isNewDay(user.vipDailyReset)) {
            updates.vipDailyUsed = 0;
            updates.vipDailyReset = now;
            needsUpdate = true;
        }

        if (needsUpdate) {
            await User.updateOne({ userId }, { $set: updates });
            Object.assign(user, updates);
        }

        await User.updateOne({ userId }, { $set: { lastActive: now } }).catch(() => {});

        return user;
    }

    _canUseFree(user) {
        if (!user || user.isBlacklisted) return false;
        const limit = config.limits?.freeDaily ?? 3;
        const used = Number(user.freeUsedToday) || 0;
        return used < limit;
    }

    _freeRemaining(user) {
        if (!user) return 0;
        const limit = config.limits?.freeDaily ?? 3;
        const used = Number(user.freeUsedToday) || 0;
        return Math.max(0, limit - used);
    }

    _canUseVip(user) {
        if (!user) return false;
        if (!user.vipExpiry) return false;
        const expiry = new Date(user.vipExpiry);
        if (isNaN(expiry.getTime()) || expiry <= new Date()) return false;
        const limit = config.limits?.vipDaily ?? 50;
        const used = Number(user.vipDailyUsed) || 0;
        return used < limit;
    }

    _vipRemaining(user) {
        if (!user) return 0;
        const limit = config.limits?.vipDaily ?? 50;
        const used = Number(user.vipDailyUsed) || 0;
        return Math.max(0, limit - used);
    }

    _isVipActive(user) {
        if (!user || !user.vipExpiry) return false;
        const expiry = new Date(user.vipExpiry);
        if (isNaN(expiry.getTime())) return false;
        return expiry > new Date();
    }

    _getAvailableBalance(user) {
        if (!user) return 0;
        const balance = Number(user.balance) || 0;
        const locked = Number(user.lockedBalance) || 0;
        return Math.max(0, balance - locked);
    }

    _hasBundleCredits(user) {
        if (!user) return false;
        const remaining = Number(user.bundleRemaining) || 0;
        return remaining > 0;
    }

    _bundleRemaining(user) {
        if (!user) return 0;
        return Number(user.bundleRemaining) || 0;
    }

    _isOnCooldown(user, cooldownMinutes = 1) {
        if (!user || !user.lastActive) return false;
        const lastActive = new Date(user.lastActive);
        const cooldownMs = cooldownMinutes * 60 * 1000;
        return (Date.now() - lastActive.getTime()) < cooldownMs;
    }

    async sendPhotoWithCaption(ctx, imageUrl, caption, keyboard = null, parseMode = null) {
        try {
            const payload = { caption: caption.trim() };
            if (parseMode) payload.parse_mode = parseMode;
            if (keyboard) payload.reply_markup = keyboard.reply_markup || keyboard;
            return await ctx.replyWithPhoto(imageUrl, payload);
        } catch (error) {
            logger.error('Photo send failed', { error: error.message, url: imageUrl });
            if (keyboard) {
                return await ctx.reply(caption, { reply_markup: keyboard.reply_markup || keyboard });
            }
            return await ctx.reply(caption);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE START
    // ═══════════════════════════════════════════════════════════
    async handleStart(ctx) {
        const userId = ctx.from.id.toString();
        let user = await this._ensureUserFresh(ctx);

        const referralResult = ctx.state?.referralResult || { processed: false };
        
        if (referralResult.processed) {
            user = await User.findOne({ userId }).lean();
        }

        const freeRemaining = this._freeRemaining(user);
        const isVip = this._isVipActive(user);
        const vipRemaining = isVip ? this._vipRemaining(user) : 0;

        const welcomeMessage =
            '👋 <b>Welcome to SwiftSMS</b>, ' + (ctx.from.first_name || 'there') + '!\n\n' +
            '🔐 Get verification codes instantly for any service.\n\n' +
            (isVip ? '👑 <b>VIP Active</b> — ' + vipRemaining + ' left today\n' : '') +
            '💰 Balance: <code>' + formatCurrency(this._getAvailableBalance(user)) + '</code>\n' +
            '📦 Bundle: <code>' + (user.bundleRemaining || 0) + '</code> OTPs\n' +
            '🆓 Free Today: <code>' + (3 - freeRemaining) + '/3</code> used\n\n' +
            'Choose your mode or deposit to get started:';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆓 FREE OTP', 'mode_free'), Markup.button.callback('💵 CHEAP OTP', 'mode_cheap')],
            [Markup.button.callback('📦 Buy Bundle', 'mode_bundle'), Markup.button.callback('👑 Upgrade VIP', 'mode_vip')],
            [Markup.button.callback('💳 Deposit', 'deposit'), Markup.button.callback('📊 My Stats', 'stats')],
            [Markup.button.callback('🎁 Referral', 'referral'), Markup.button.callback('⚙️ Settings', 'settings')],
            [Markup.button.callback('💰 Check Balance', 'balance'), Markup.button.callback('🎧 Customer Service', 'support')]
        ]);

        try {
            await this.sendPhotoWithCaption(ctx, IMAGES.welcome, welcomeMessage, keyboard, 'HTML');
        } catch (err) {
            logger.error('Failed to send welcome photo, falling back to text', { error: err.message });
            await ctx.reply(welcomeMessage, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        }

        if (referralResult.processed) {
            try {
                const referrerName = referralResult.referrerName || 'a friend';

                const inviteeNotice =
                    `🎉 <b>You've got a head start!!</b>\n\n` +
                    `You were invited by <b>${referrerName}</b> 👀\n\n` +
                    `💰 Your advantage:\n` +
                    `• Faster onboarding\n` +
                    `• Priority access to virtual numbers\n` +
                    `• Instant number after your first deposit\n\n` +
                    `🚀 Make your first deposit now and start using SwiftSMS immediately!`;

                await ctx.reply(inviteeNotice, { parse_mode: 'HTML' });
            } catch (err) {
                logger.error('Failed to send invitee referral notice', {
                    userId,
                    error: err.message
                });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  DEBUG: Check referral status
    // ═══════════════════════════════════════════════════════════
    async handleRefDebug(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const user = await User.findOne({ userId }).lean();
            const referrals = await Referral.find({ referrerId: userId }).lean();
            const referredUsers = await User.find({ referredBy: user.referralCode }).lean();

            let message =
                '🔍 <b>Referral Debug</b>\n\n' +
                '<b>Your Info:</b>\n' +
                `• User ID: <code>${userId}</code>\n` +
                `• Referral Code: <code>${user.referralCode}</code>\n` +
                `• referralCount: <code>${user.referralCount || 0}</code>\n` +
                `• referralEarnings: <code>${user.referralEarnings || 0}</code>\n\n` +
                '<b>Referral Records:</b>\n' +
                `• Total in Referral collection: <code>${referrals.length}</code>\n` +
                `• Users with referredBy set: <code>${referredUsers.length}</code>\n\n` +
                '<b>Recent Referrals:</b>\n';

            if (referrals.length === 0) {
                message += '<i>No referral records found.</i>\n\n' +
                    '⚠️ <b>Problem:</b> Referrals are not being tracked.\n' +
                    'Possible causes:\n' +
                    '• Users clicked link without ?start=CODE\n' +
                    '• trackReferral() failed silently\n' +
                    '• ReferralService not injected';
            } else {
                referrals.slice(0, 5).forEach((r, i) => {
                    message += `${i+1}. ${r.referredId} — ${r.status} — ${r.createdAt?.toLocaleDateString() || 'unknown date'}\n`;
                });
            }

            await ctx.reply(message, { parse_mode: 'HTML' });

        } catch (error) {
            logger.error('refdebug error', { userId, error: error.message });
            await ctx.reply('❌ Debug failed: ' + error.message);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE MENU
    // ═════════════
