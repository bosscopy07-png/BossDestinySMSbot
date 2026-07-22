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
async handleMenu(ctx) {
    const user = await this._ensureUserFresh(ctx);

    const freeRemaining = this._freeRemaining(user);
    const isVip = this._isVipActive(user);
    const vipRemaining = isVip ? this._vipRemaining(user) : 0;

    const menuText =
        '📋 <b>Main Menu</b>\n\n' +
        '💰 Balance: <code>' + formatCurrency(this._getAvailableBalance(user)) + '</code>\n' +
        '📦 Bundle: <code>' + (user.bundleRemaining || 0) + '</code> OTPs\n' +
        '🆓 Free Today: <code>' + (3 - freeRemaining) + '/3</code> used\n\n' +
        (isVip ? '👑 VIP: <code>' + (50 - vipRemaining) + '/50</code> used\n' : '') +
        '\nWhat would you like to do?';

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔢 Request OTP', 'request_otp'), Markup.button.callback('💳 Deposit', 'deposit')],
        [Markup.button.callback('📜 History', 'history'), Markup.button.callback('📊 Stats', 'stats')],
        [Markup.button.callback('🎁 Referral', 'referral'), Markup.button.callback('⚙️ Settings', 'settings')],
        [Markup.button.callback('💰 Balance', 'balance'), Markup.button.callback('🎧 Support', 'support')],
        [Markup.button.callback('❓ Help', 'help'), Markup.button.callback('📱 OTP Services', 'otp_hub')]
    ]);

    try {
        await ctx.editMessageText(menuText, {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        });
    } catch {
        await this.sendPhotoWithCaption(ctx, IMAGES.mainMenu, menuText, keyboard, 'HTML');
    }
}

// ═══════════════════════════════════════════════════════════
//  HANDLE REQUEST OTP
// ═══════════════════════════════════════════════════════════
async handleRequestOTP(ctx) {
    try { await ctx.answerCbQuery('Opening OTP...'); } catch (e) {}

    const user = await this._ensureUserFresh(ctx);
    const freeRemaining = this._freeRemaining(user);
    const isVip = this._isVipActive(user);
    const vipRemaining = isVip ? this._vipRemaining(user) : 0;

    const message =
        '🔢 <b>Request OTP</b>\n\n' +
        '🆓 Free Today: <code>' + (3 - freeRemaining) + '/3</code> used\n\n' +
        '💵 Cheap: <code>' + formatCurrency(config.prices?.cheapOtp || 0.05) + '</code> per OTP\n' +
        '📦 Bundle: <code>' + (user.bundleRemaining || 0) + '</code> OTPs left\n' +
        (isVip  ? '👑 VIP: <code>' + (50 - vipRemaining) + '/50</code> used today\n' : '👑 VIP: <i>Inactive</i>\n') +
        '\nSelect your preferred mode:';

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🆓 FREE', 'mode_free'), Markup.button.callback('💵 CHEAP', 'mode_cheap')],
        [Markup.button.callback('📦 BUNDLE', 'mode_bundle'), Markup.button.callback('👑 VIP', 'mode_vip')],
        [Markup.button.callback('🔙 Back', 'menu')]
    ]);

    await this.sendPhotoWithCaption(ctx, IMAGES.welcome, message, keyboard, 'HTML');
}

// ═══════════════════════════════════════════════════════════
//  HANDLE BALANCE
// ═══════════════════════════════════════════════════════════
async handleBalance(ctx) {
    const userId = ctx.from.id.toString();
    const user = await this._ensureUserFresh(ctx);

    const pendingDeposit = await Transaction.findOne({
        userId: user.userId,
        type: TX_TYPES.DEPOSIT,
        status: { $in: ['PENDING', 'CONFIRMING'] }
    }).sort({ createdAt: -1 });

    // Check for pending Naira payment
    const pendingNaira = await Payment.findOne({
        userId: user.userId,
        status: 'PENDING',
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }).sort({ createdAt: -1 });

    const isVip = this._isVipActive(user);
    const freeRemaining = this._freeRemaining(user);
    const vipRemaining = isVip ? this._vipRemaining(user) : 0;

    let masterAddress = 'Loading...';
    try {
        if (this.walletService?.getMasterAddress) {
            masterAddress = await this.walletService.getMasterAddress();
        }
    } catch (e) {
        masterAddress = 'Unavailable';
    }

    let message =
        '💰 <b>Your Balance</b>\n\n' +
        '💵 Available: <code>' + formatCurrency(this._getAvailableBalance(user)) + '</code>\n' +
        '🔒 Locked: <code>' + formatCurrency(user.lockedBalance || 0) + '</code>\n' +
        '💳 Total Deposited: <code>' + formatCurrency(user.totalDeposited || 0) + '</code>\n' +
        '📉 Total Spent: <code>' + formatCurrency(user.totalSpent || 0) + '</code>\n\n' +
        '📦 Bundle OTPs: <code>' + (user.bundleRemaining || 0) + '</code>\n' +
        '🆓 Free Today: <code>' + (3 - freeRemaining) + '/3</code>\n' +
        (isVip ? '👑 VIP: <code>' + (50 - vipRemaining) + '/50</code> used\n' : '👑 VIP: <i>Inactive</i>\n') +
        '\n';

    if (pendingDeposit) {
        message += '⏳ Pending USDT Deposit: <code>' + formatCurrency(pendingDeposit.metadata?.requestedAmount || pendingDeposit.amount) + '</code>\n\n';
    }

    if (pendingNaira) {
        message += '⏳ Pending Naira Deposit: <code>₦' + pendingNaira.amountNaira.toLocaleString() + '</code> → <code>$' + pendingNaira.amountUsd.toFixed(2) + '</code>\n' +
            `Reference: <code>${pendingNaira.reference}</code>\n\n`;
    }

    message += '💎 <b>Deposit Address:</b>\n<code>' + masterAddress + '</code>';

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💳 Deposit', 'deposit')],
        [Markup.button.callback('📜 Transaction History', 'history')],
        [Markup.button.callback('🔙 Back to Menu', 'menu')]
    ]);

    await this.sendPhotoWithCaption(ctx, IMAGES.balance, message, keyboard, 'HTML');
}

// ═══════════════════════════════════════════════════════════
//  HANDLE DEPOSIT — Main deposit menu with both options
// ═══════════════════════════════════════════════════════════
async handleDeposit(ctx) {
    const userId = ctx.from.id.toString();
    try {
        await ctx.answerCbQuery('💳 Deposit').catch(() => {});

        const message =
            '💰 <b>Deposit Funds</b>\n\n' +
            'Choose a deposit method:\n\n' +
            '💵 <b>USDT BEP-20</b> — Crypto deposit with automatic confirmation\n' +
            '🇳🇬 <b>Naira (₦)</b> — Pay with card, bank transfer, or USSD';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('₮ USDT BEP-20', 'deposit_usdt')],
            [Markup.button.callback('🇳🇬 Naira (₦)', 'deposit_naira')],
            [Markup.button.callback('⬅️ Back', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard, 'HTML');

    } catch (error) {
        logger.error('Deposit handler error', { userId, error: error.message });
        await ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}

// ═══════════════════════════════════════════════════════════
//  USDT DEPOSIT FLOW — Preserved exactly as before
// ═══════════════════════════════════════════════════════════
async handleUsdtDeposit(ctx) {
    const userId = ctx.from.id.toString();
    try {
        await ctx.answerCbQuery('₮ USDT BEP-20');

        const message =
            '💳 <b>Select Deposit Amount</b>\n\n' +
            'Choose a preset amount or enter a custom amount:\n\n' +
            '💵 <code>$5</code> — Quick start\n' +
            '💵 <code>$10</code> — Popular\n' +
            '💵 <code>$20</code> — Great value\n' +
            '💵 <code>$50</code> — Power user\n' +
            '💵 <code>$100</code> — Maximum bonus\n\n' +
            'Or tap Custom to enter any amount.';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💵 $5', 'deposit_5'), Markup.button.callback('💵 $10', 'deposit_10')],
            [Markup.button.callback('💵 $20', 'deposit_20'), Markup.button.callback('💵 $50', 'deposit_50')],
            [Markup.button.callback('💵 $100', 'deposit_100')],
            [Markup.button.callback('✏️ Custom Amount', 'deposit_custom')],
            [Markup.button.callback('🔙 Back', 'deposit')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard, 'HTML');

    } catch (error) {
        logger.error('USDT deposit error', { userId, error: error.message });
        await ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}

async handleCustomDeposit(ctx) {
    const userId = ctx.from.id.toString();
    try {
        ctx.session = ctx.session || {};
        ctx.session.awaitingDepositAmount = true;
        await ctx.answerCbQuery('Enter custom amount');
        const message =
            '✏️ <b>Custom Deposit</b>\n\n' +
            'Send the amount you want to deposit (in USD):\n\n' +
            '<i>Examples: 5, 10.50, 25</i>\n\n' +
            'Minimum: <code>$0.50</code>';
        await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, null, 'HTML');
    } catch (error) {
        logger.error('Custom deposit error', { userId, error: error.message });
    }
}

async handlePresetDeposit(ctx, amount) {
    const userId = ctx.from.id.toString();
    try {
        await ctx.answerCbQuery(`Deposit $${amount}`);
        await this.showDepositDetails(ctx, userId, amount);
    } catch (error) {
        logger.error('Preset deposit error', { userId, amount, error: error.message });
        await ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}

async handleDepositAmountInput(ctx) {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text.trim().replace(/[^0-9.]/g, '');
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 0.50) {
        return this.sendPhotoWithCaption(
            ctx,
            IMAGES.deposit,
            '❌ <b>Invalid amount.</b>\n\nMinimum deposit is <code>$0.50</code>.\nTry /deposit again.',
            null,
            'HTML'
        );
    }
    await this.showDepositDetails(ctx, userId, amount);
}

async showDepositDetails(ctx, userId, requestedAmount) {
    try {
        const depositInfo = await this.walletService.getDepositInfo(userId, requestedAmount);

        const trackingAmount = depositInfo.amount || depositInfo.trackingAmount || depositInfo.baseAmount || requestedAmount;
        const actualAmount = depositInfo.baseAmount || requestedAmount;

        let depositAddress = depositInfo.address;
        if (!depositAddress && this.walletService?.getMasterAddress) {
            depositAddress = await this.walletService.getMasterAddress();
        }
        if (!depositAddress || depositAddress === 'WALLET_NOT_READY') {
            throw new Error('WALLET_ADDRESS_UNAVAILABLE');
        }

        const message =
            '💳 <b>Deposit $' + actualAmount + '</b>\n\n' +
            '📬 <b>Send to this address:</b>\n<code>' + depositAddress + '</code>\n\n' +
            '💵 You will receive: <code>$' + actualAmount + '</code>\n' +
            '📬 Send exactly: <code>' + trackingAmount + '</code> USDT\n' +
            '🌐 Network: <code>' + (depositInfo.network || 'BSC (BEP-20)') + '</code>\n\n' +
            '⚠️ <b>IMPORTANT:</b>\n' +
            '• Send ONLY USDT on BSC (BEP-20)\n' +
            '• Send EXACTLY <code>' + trackingAmount + '</code> USDT\n' +
            '• The extra <code>' + (trackingAmount - actualAmount).toFixed(4) + '</code> is for deposit identification only\n\n' +
            '✅ <code>$' + actualAmount + '</code> will be credited to your balance.\n' +
            '⏱ Funds credited automatically in 1-2 minutes.';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📋 Copy Address', 'copy_address_' + depositAddress)],
            [Markup.button.callback('📤 Share Address', 'share_address_' + depositAddress)],
            [Markup.button.callback('📱 Show Instant Transfer', 'deposit_qr')],
            [Markup.button.callback('🔍 Check Deposit', 'check_deposit')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard, 'HTML');

    } catch (error) {
        logger.error('Show deposit details error', { userId, error: error.message });

        if (error.message === 'WALLET_ADDRESS_UNAVAILABLE') {
            return ctx.reply('❌ Wallet service is initializing. Please wait 10 seconds and try /deposit again.');
        }

        await ctx.reply('❌ Error generating deposit. Please try again.');
    }
}

async handleDepositQR(ctx) {
    const userId = ctx.from.id.toString();
    
    try {
        const user = await User.findOne({ userId });
        const trackingAmount = user?.depositTrackingAmount;
        const requestedAmount = user?.depositRequestedAmount || trackingAmount;

        if (!trackingAmount) {
            return ctx.answerCbQuery('⚠️ Click Deposit first').catch(() => {});
        }

        let masterAddress = '';
        try {
            if (this.walletService?.getMasterAddress) {
                masterAddress = await this.walletService.getMasterAddress();
            }
        } catch (e) {
            return ctx.answerCbQuery('❌ Address unavailable').catch(() => {});
        }

        await ctx.answerCbQuery('📱 Loading deposit...').catch(() => {});

        const caption =
            '💰 <b>Deposit to Fund Your Balance</b>\n\n' +
            '📬 <b>Send Exactly:</b> <code>' + trackingAmount + '</code> USDT\n' +
            '📬 <b>To Address:</b> <code>' + masterAddress + '</code>\n\n' +
            '⚠️ <b>Must be BSC (BEP-20) Network Only!</b>\n\n' +
            '💵 <b>Amount Credited:</b> <code>$' + requestedAmount + '</code>\n\n' +
            '🔽 <b>Tap Your Wallet Below to Pay Instantly:</b>';

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🛡️ Trust Wallet', url: 'https://link.trustwallet.com/send?asset=c20000714_t0x55d398326f99059fF775485246999027B3197955&address=' + masterAddress + '&amount=' + trackingAmount + '&memo=SwiftSMS' },
                        { text: '🦊 MetaMask', url: 'https://metamask.app.link/send/0x55d398326f99059fF775485246999027B3197955@56/transfer?address=' + masterAddress + '&uint256=' + Math.round(trackingAmount * 1e6) }
                    ],
                    [
                        { text: '🔶 Binance Pay', url: 'https://www.binance.com/en/my/wallet/account/payment/send' },
                        { text: '🛡️ SafePal', url: 'https://link.safepal.io/send?address=' + masterAddress + '&amount=' + trackingAmount + '&token=USDT&chain=bsc' }
                    ],
                    [
                        { text: '👛 TokenPocket', url: 'https://tokenpocket.pro/' },
                        { text: '🔵 OKX Wallet', url: 'https://www.okx.com/web3' }
                    ],
                    [
                        { text: '🔴 Bitget Wallet', url: 'https://web3.bitget.com/' },
                        { text: '🟣 Bybit Wallet', url: 'https://www.bybit.com/en-US/web3' }
                    ],
                    [
                        { text: '🟢 Gate.io', url: 'https://www.gate.io/web3' },
                        { text: '🟠 MEXC', url: 'https://www.mexc.com/web3' }
                    ],
                    [{ text: '📋 Copy Address', callback_data: 'copy_address_' + masterAddress }],
                    [
                        { text: '🔍 Check Deposit', callback_data: 'check_deposit' },
                        { text: '🔙 Back', callback_data: 'menu' }
                    ]
                ]
            }
        };

        await ctx.replyWithPhoto(
            IMAGES.deposit,
            { 
                caption: caption, 
                parse_mode: 'HTML', 
                reply_markup: keyboard.reply_markup 
            }
        );

    } catch (error) {
        logger.error('Deposit menu failed', { userId, error: error.message, stack: error.stack });
        await ctx.answerCbQuery('❌ Error loading deposit').catch(() => {});
        
        try {
            const user = await User.findOne({ userId });
            const fa = user?.depositAddress || masterAddress || 'N/A';
            const ta = user?.depositTrackingAmount || '?';
            const ra = user?.depositRequestedAmount || ta;
            
            await ctx.reply(
                `💰 <b>Deposit to Fund Your Balance</b>\n\n` +
                `📬 Send Exactly: <code>${ta}</code> USDT\n` +
                `📬 To Address: <code>${fa}</code>\n\n` +
                `⚠️ Must be BSC (BEP-20) Network Only!\n\n` +
                `💵 Amount Credited: <code>$${ra}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            logger.error('Fallback failed', { userId, error: e.message });
        }
    }
}

async handleShareAddress(ctx) {
    const address = ctx.match[1];
    await ctx.answerCbQuery('📤 Address ready!');
    await ctx.reply(
        '📤 <b>Deposit Address</b>\n\n<code>' + address + '</code>\n\n' +
        'Tap and hold to copy, then paste in your wallet app.',
        { parse_mode: 'HTML' }
    );
}

async handleCopyAddress(ctx) {
    const address = ctx.match[1];
    await ctx.answerCbQuery('📋 Address: ' + address.substring(0, 10) + '...');
    await ctx.reply(
        '📋 <b>Copy this address:</b>\n\n<code>' + address + '</code>\n\n' +
        'Tap the address above to copy it.',
        { parse_mode: 'HTML' }
    );
}

async handleCheckDeposit(ctx) {
    const userId = ctx.from.id.toString();
    try {
        await ctx.answerCbQuery('🔍 Checking...');

        const result = await this.walletService.checkDeposit(userId);

        if (result.found && (result.status === 'COMPLETED' || result.status === 'CREDITED')) {
            return ctx.answerCbQuery('✅ Deposit confirmed! Check /balance.');
        }

        if (result.found && result.status === 'CONFIRMING') {
            const message =
                '⏳ <b>Deposit Confirming</b>\n\n' +
                '💵 Amount: <code>' + formatCurrency(result.amount) + '</code>\n' +
                '🔢 Confirmations: <code>' + (result.confirmations || 0) + '/' + (config.blockchain?.blockConfirmations || 12) + '</code>\n\n' +
                '⏱ Please wait for full confirmation.';

            return this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, null, 'HTML');
        }

        const user = await User.findOne({ userId });
        const trackingAmount = user?.depositTrackingAmount;

        let masterAddress = '';
        try {
            if (this.walletService?.getMasterAddress) {
                masterAddress = await this.walletService.getMasterAddress();
            }
        } catch (e) {}

        const message =
            '🔍 <b>No deposit found yet.</b>\n\n' +
            'Make sure you:\n' +
            '1️⃣ Sent to: <code>' + masterAddress + '</code>\n' +
            '2️⃣ Sent exactly <code>' + (trackingAmount || 'the shown') + '</code> USDT\n' +
            '3️⃣ Used BSC (BEP-20) network\n\n' +
            '⏱ Check again in 1 minute.';

        await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Check Again', 'check_deposit')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]), 'HTML');

    } catch (error) {
        logger.error('Check deposit failed', { userId, error: error.message });
        await ctx.answerCbQuery('❌ Check failed');
        await ctx.reply('❌ Error checking deposit. Try again later.');
    }
}

// ═══════════════════════════════════════════════════════════
//  NAIRA DEPOSIT FLOW — NEW
// ═══════════════════════════════════════════════════════════
async handleNairaDepositStart(ctx) {
    try {
        await ctx.answerCbQuery('🇳🇬 Naira Deposit');
        
        const message =
            '🇳🇬 <b>Naira Deposit</b>\n\n' +
            'Enter the amount you want to deposit in Naira.\n\n' +
            `Minimum deposit: <code>₦${NAIRA_CONFIG.minDeposit.toLocaleString()}</code>\n\n` +
            '<i>Send the amount as a number (e.g., 5000, 10000, 50000)</i>';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel', 'naira_cancel')]
        ]);

        ctx.session = ctx.session || {};
        ctx.session.awaitingNairaAmount = true;

        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        });
    } catch (error) {
        logger.error('Naira deposit start error', { error: error.message });
        await ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}

async handleNairaAmountInput(ctx) {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text.trim().replace(/[^0-9]/g, '');
    const amountNgn = parseInt(text);

    if (isNaN(amountNgn) || amountNgn <= 0) {
        return ctx.reply(
            '❌ <b>Invalid amount.</b>\n\nPlease enter a valid number.\n\n' +
            `Minimum: <code>₦${NAIRA_CONFIG.minDeposit.toLocaleString()}</code>`,
            { parse_mode: 'HTML' }
        );
    }

    if (amountNgn < NAIRA_CONFIG.minDeposit) {
        return ctx.reply(
            `❌ <b>Amount too low.</b>\n\n` +
            `Minimum deposit is <code>₦${NAIRA_CONFIG.minDeposit.toLocaleString()}</code>.\n\n` +
            'Please enter a higher amount.',
            { parse_mode: 'HTML' }
        );
    }

    try {
        const { amountUsd, rate } = await exchangeRateService.ngnToUsd(amountNgn);

        ctx.session.nairaDepositAmount = amountNgn;
        ctx.session.nairaDepositUsd = amountUsd;
        ctx.session.nairaExchangeRate = rate;

        const message =
            '🇳🇬 <b>Naira Deposit</b>\n\n' +
            `Amount: <code>₦${amountNgn.toLocaleString()}</code>\n` +
            `You will receive approximately: <code>$${amountUsd.toFixed(2)}</code>\n\n` +
            `Exchange rate: <code>₦${rate.toLocaleString()} = $1</code>\n\n` +
            '<i>The rate is locked for this transaction.</i>';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💳 Continue Payment', 'naira_confirm_amount')],
            [Markup.button.callback('❌ Cancel', 'naira_cancel')]
        ]);

        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        });

    } catch (error) {
        logger.error('Amount calculation error', { userId, error: error.message });
        await ctx.reply(
            '❌ <b>Error calculating exchange rate.</b>\n\nPlease try again later.',
            { parse_mode: 'HTML' }
        );
    }
}

async handleNairaConfirmAmount(ctx) {
    const userId = ctx.from.id.toString();
    const amountNgn = ctx.session?.nairaDepositAmount;

    if (!amountNgn) {
        await ctx.answerCbQuery('Session expired. Please start again.');
        return this.handleNairaDepositStart(ctx);
    }

    try {
        await ctx.answerCbQuery('Initializing payment...');

        const user = await User.findOne({ userId }).lean();
        const email = user?.email || `${userId}@swiftsms.user`;

        const result = await paymentService.createNairaDeposit(userId, amountNgn, email);

        ctx.session.nairaPaymentReference = result.reference;

        const message =
            '💳 <b>Payment Created</b>\n\n' +
            `Amount: <code>₦${amountNgn.toLocaleString()}</code>\n` +
            `Expected credit: <code>$${result.payment.amountUsd.toFixed(2)}</code>\n` +
            `Reference: <code>${result.reference}</code>\n\n` +
            'Complete your payment using the button below.';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('💳 Pay Now', result.authorizationUrl)],
            [Markup.button.callback('🔄 Check Payment Status', 'naira_check_status')],
            [Markup.button.callback('❌ Cancel', 'naira_cancel')]
        ]);

        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        });

    } catch (error) {
        logger.error('Payment initialization error', { userId, error: error.message });
        
        let errorMsg = '❌ <b>Payment initialization failed.</b>';
        if (error.message.includes('MINIMUM_DEPOSIT')) {
            errorMsg += '\n\nAmount is below the minimum deposit.';
        } else if (error.message.includes('PAYSTACK_ERROR')) {
            errorMsg += '\n\nPayment provider error. Please try again.';
        }

        await ctx.editMessageText(errorMsg, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Try Again', 'deposit_naira')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]).reply_markup
        });
    }
}

async handleNairaCheckStatus(ctx) {
    const userId = ctx.from.id.toString();
    const reference = ctx.session?.nairaPaymentReference;

    if (!reference) {
        await ctx.answerCbQuery('No active payment found.');
        return ctx.reply(
            '❌ <b>No active payment found.</b>\n\nStart a new deposit.',
            { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🇳🇬 New Naira Deposit', 'deposit_naira')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]).reply_markup }
        );
    }

    try {
        await ctx.answerCbQuery('Checking status...');

        const result = await paymentService.checkPaymentStatus(reference);

        if (result.status === 'SUCCESS') {
            const message =
                '✅ <b>Payment Successful!</b>\n\n' +
                `Amount paid: <code>₦${result.payment.amountNaira.toLocaleString()}</code>\n` +
                `Credited: <code>$${result.payment.amountUsd.toFixed(2)}</code>\n` +
                `Reference: <code>${reference}</code>\n\n` +
                'Your balance has been updated.';

            delete ctx.session.nairaPaymentReference;
            delete ctx.session.nairaDepositAmount;
            delete ctx.session.nairaDepositUsd;

            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('💰 Check Balance', 'balance')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]).reply_markup
            });

        } else if (result.status === 'PENDING') {
            const message =
                '⏳ <b>Payment Pending</b>\n\n' +
                `Reference: <code>${reference}</code>\n\n` +
                'Your payment is still being processed.\n' +
                'Please complete the payment or check again in a few minutes.';

            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Check Again', 'naira_check_status')],
                    [Markup.button.callback('❌ Cancel', 'naira_cancel')]
                ]).reply_markup
            });

        } else if (result.status === 'FAILED') {
            const message =
                '❌ <b>Payment Failed</b>\n\n' +
                `Reference: <code>${reference}</code>\n\n` +
                'The payment could not be completed.\n' +
                'Please try again with a different method.';

            delete ctx.session.nairaPaymentReference;

            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Try Again', 'deposit_naira')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]).reply_markup
            });
        }

    } catch (error) {
        logger.error('Status check error', { userId, reference, error: error.message });
        await ctx.answerCbQuery('Check failed');
        await ctx.reply(
            '❌ <b>Error checking payment status.</b>\n\nPlease try again later.',
            { parse_mode: 'HTML' }
        );
    }
}

async handleNairaCancel(ctx) {
    const reference = ctx.session?.nairaPaymentReference;
    
    delete ctx.session.awaitingNairaAmount;
    delete ctx.session.nairaDepositAmount;
    delete ctx.session.nairaDepositUsd;
    delete ctx.session.nairaExchangeRate;
    delete ctx.session.nairaPaymentReference;

    try {
        await ctx.answerCbQuery('Cancelled');
        await ctx.editMessageText(
            '❌ <b>Deposit Cancelled</b>\n\nYour deposit has been cancelled.',
            {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]).reply_markup
            }
        );
    } catch (error) {
        logger.error('Cancel deposit error', { error: error.message });
    }
}

// ═══════════════════════════════════════════════════════════
//  HANDLE HISTORY
// ═══════════════════════════════════════════════════════════
async handleHistory(ctx) {
    const userId = ctx.from.id.toString();
    const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(15).lean();

    let message = '📜 <b>Recent Transactions</b>\n\n';
    if (!transactions.length) {
        message += '<i>No transactions yet. Deposit to get started!</i>';
    } else {
        transactions.forEach((tx, index) => {
            const icon = tx.type === TX_TYPES.DEPOSIT ? '💳' :
                tx.type === TX_TYPES.NAIRA_DEPOSIT ? '🇳🇬' :
                tx.type === TX_TYPES.BUNDLE_PURCHASE ? '📦' :
                    tx.type === TX_TYPES.VIP_SUBSCRIPTION ? '👑' :
                        tx.type === TX_TYPES.REFERRAL_REWARD ? '🎁' :
                            tx.amount >= 0 ? '➕' : '➖';
            const type = (tx.type || 'Unknown').replace(/_/g, ' ');
            const amountPrefix = tx.amount >= 0 ? '+' : '';

            let extraInfo = '';
            if (tx.type === TX_TYPES.DEPOSIT && tx.metadata?.trackingFee > 0) {
                extraInfo = ' (fee: ' + formatCurrency(tx.metadata.trackingFee) + ')';
            }
            if (tx.type === TX_TYPES.NAIRA_DEPOSIT && tx.metadata?.amountNaira) {
                extraInfo = ` (₦${tx.metadata.amountNaira.toLocaleString()})`;
            }

            message += icon + ' <b>' + type + '</b>\n';
            message += '   ' + amountPrefix + formatCurrency(Math.abs(tx.amount || 0)) + extraInfo + ' | ' + tx.status + '\n';
            message += '   🕐 ' + (tx.createdAt ? new Date(tx.createdAt).toLocaleDateString() : 'Unknown') + '\n\n';
        });
    }

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📥 Export CSV', 'export_history')],
        [Markup.button.callback('🔙 Back', 'menu')]
    ]);

    await this.sendPhotoWithCaption(ctx, IMAGES.history, message, keyboard, 'HTML');
}

// ═══════════════════════════════════════════════════════════
//  HANDLE EXPORT HISTORY
// ═══════════════════════════════════════════════════════════
async handleExportHistory(ctx) {
    const userId = ctx.from.id.toString();
    try {
        await ctx.answerCbQuery('📥 Generating CSV...');
        const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 }).lean();

        if (!transactions.length) {
            return ctx.reply('📭 No transactions to export.');
        }

        let csv = 'Date,Type,Amount,Status,TrackingFee,PaymentReference,TX Hash\n';
        for (const tx of transactions) {
            const date = tx.createdAt ? new Date(tx.createdAt).toISOString().split('T')[0] : 'N/A';
            const trackingFee = tx.metadata?.trackingFee || 0;
            const paymentRef = tx.metadata?.paymentReference || 'N/A';
            csv += date + ',' + (tx.type || 'Unknown') + ',' + (tx.amount || 0) + ',' + (tx.status || 'Unknown') + ',' + trackingFee + ',' + paymentRef + ',' + (tx.txHash || 'N/A') + '\n';
        }

        await ctx.replyWithDocument(
            { source: Buffer.from(csv), filename: 'history_' + userId + '_' + Date.now() + '.csv' },
            { caption: '📥 Your transaction history export.' }
        );
    } catch (error) {
        logger.error('Export history failed', { userId, error: error.message });
        await ctx.reply('❌ Failed to export history.');
    }
}

// ═══════════════════════════════════════════════════════════
//  HANDLE REFERRAL
// ═══════════════════════════════════════════════════════════
async handleReferral(ctx) {
    const user = await User.findOne({ userId: ctx.from.id.toString() }).lean();
    const botUsername = ctx.botInfo?.username || 'SwiftOTPBot';
    const referralLink = 'https://t.me/' + botUsername + '?start=' + user.referralCode;

    const message =
        '🎁 <b>Referral Program</b>\n\n' +
        '🔗 <b>Your Code:</b> <code>' + user.referralCode + '</code>\n\n' +
        '💰 Earn <code>' + (((config.referral?.percentage || 0.05) * 100).toFixed(0)) + '%</code> of your referrals\' first deposits!\n\n' +
        '📊 <b>Your Stats:</b>\n' +
        '• Referrals: <code>' + (user.referralCount || 0) + '</code>\n' +
        '• Total Earnings: <code>' + formatCurrency(user.referralEarnings || 0) + '</code>\n' +
        '• Pending Approval: <code>' + formatCurrency(user.referralRewardsPending || 0) + '</code>\n\n' +
        '🔗 <b>Your Link:</b>\n<code>' + referralLink + '</code>';

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📤 Share Link', 'share_' + user.referralCode)],
        [Markup.button.callback('🔙 Back', 'menu')]
    ]);

    await this.sendPhotoWithCaption(ctx, IMAGES.referral, message, keyboard, 'HTML');
}

async handleShareReferral(ctx) {
    const referralCode = ctx.match[1];
    const botUsername = ctx.botInfo?.username || 'SwiftOTPBot';
    const referralLink = 'https://t.me/' + botUsername + '?start=' + referralCode;

    await ctx.answerCbQuery('📤 Link ready!');
    await ctx.reply(
        '📤 <b>Share Your Referral Link</b>\n\n' +
        '<code>' + referralLink + '</code>\n\n' +
        'Tap and hold to copy, then share with friends!',
        { parse_mode: 'HTML' }
    );
}

// ═══════════════════════════════════════════════════════════
//  HANDLE STATS
// ═══════════════════════════════════════════════════════════
async handleStats(ctx) {
    const userId = ctx.from.id.toString();
    const user = await User.findOne({ userId }).lean();
    const sessions = await Session.find({ userId }).lean();

    const totalRequests = sessions.length;
    const successful = sessions.filter(s => s.status === 'RECEIVED').length;
    const failed = sessions.filter(s => s.status === 'TIMEOUT' || s.status === 'FAILED').length;
    const successRate = totalRequests > 0 ? ((successful / totalRequests) * 100).toFixed(1) : 0;

    const completedSessions = sessions.filter(s => s.endTime && s.startTime && s.status === 'RECEIVED');
    const avgWaitTime = completedSessions.length > 0
        ? (completedSessions.reduce((acc, s) => acc + (new Date(s.endTime) - new Date(s.startTime)), 0) / completedSessions.length / 1000)
        : 0;

    const isVip = this._isVipActive(user);
    const freeRemaining = this._freeRemaining(user);
    const vipRemaining = isVip ? this._vipRemaining(user) : 0;

    const message =
        '📊 <b>Your Statistics</b>\n\n' +
        '🔢 <b>OTP Requests:</b>\n' +
        '• Total: <code>' + totalRequests + '</code>\n' +
        '• Successful: <code>' + successful + '</code>\n' +
        '• Failed: <code>' + failed + '</code>\n' +
        '• Success Rate: <code>' + successRate + '%</code>\n\n' +
        '⚡ <b>Performance:</b>\n' +
        '• Avg Wait: <code>' + avgWaitTime.toFixed(1) + 's</code>\n\n' +
        '💰 <b>Financial:</b>\n' +
        '• Deposited: <code>' + formatCurrency(user?.totalDeposited || 0) + '</code>\n' +
        '• Spent: <code>' + formatCurrency(user?.totalSpent || 0) + '</code>\n' +
        '• Balance: <code>' + formatCurrency(this._getAvailableBalance(user)) + '</code>\n\n' +
        '🎮 <b>Usage:</b>\n' +
        '• Free: <code>' + (3 - freeRemaining) + '/3</code>\n' +
        '• Bundle: <code>' + (user?.bundleRemaining || 0) + '</code>\n' +
        (isVip ? '• VIP: <code>' + (50 - vipRemaining) + '/50</code>\n' : '') +
        '\n📅 Member Since: ' + (user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Unknown');

    await this.sendPhotoWithCaption(ctx, IMAGES.stats, message, Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back', 'menu')]
    ]), 'HTML');
}

// ═══════════════════════════════════════════════════════════
//  HANDLE SETTINGS
// ═══════════════════════════════════════════════════════════
async handleSettings(ctx) {
    const user = await User.findOne({ userId: ctx.from.id.toString() }).lean();

    const message =
        '⚙️ <b>Settings</b>\n\n' +
        '🔒 Privacy: <code>' + (user.privacyEnabled ? 'Masked OTPs' : 'Full OTPs') + '</code>\n' +
        '🔔 Notifications: <code>' + (user.notificationsEnabled ? 'On' : 'Off') + '</code>\n' +
        '🌍 Country: <code>' + (user.preferredCountry || 'US') + '</code>\n\n' +
        'Toggle settings below:';

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(user.privacyEnabled ? '👁 Show Full OTPs' : '🔒 Mask OTPs', 'toggle_privacy')],
        [Markup.button.callback(user.notificationsEnabled ? '🔕 Disable Notifications' : '🔔 Enable Notifications', 'toggle_notifications')],
        [Markup.button.callback('🌍 Change Country', 'change_country')],
        [Markup.button.callback('🔙 Back', 'menu')]
    ]);

    await this.sendPhotoWithCaption(ctx, IMAGES.default, message, keyboard, 'HTML');
}

async handleTogglePrivacy(ctx) {
    const userId = ctx.from.id.toString();
    const user = await User.findOne({ userId });
    const newValue = !user.privacyEnabled;
    await User.updateOne({ userId }, { $set: { privacyEnabled: newValue } });
    await ctx.answerCbQuery(newValue ? '🔒 Privacy ON' : '👁 Privacy OFF');
    await this.handleSettings(ctx);
}

async handleToggleNotifications(ctx) {
    const userId = ctx.from.id.toString();
    const user = await User.findOne({ userId });
    const newValue = !user.notificationsEnabled;
    await User.updateOne({ userId }, { $set: { notificationsEnabled: newValue } });
    await ctx.answerCbQuery(newValue ? '🔔 Notifications ON' : '🔕 Notifications OFF');
    await this.handleSettings(ctx);
}

