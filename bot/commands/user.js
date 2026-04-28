import { Markup } from 'telegraf';
import QRCode from 'qrcode';
import { User, Session, Transaction } from '../../models/index.js';
import { COUNTRIES, SERVICES } from '../../utils/constants.js';
import { formatCurrency, generateReferralCode, isNewDay } from '../../utils/helpers.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

const IMAGES = {
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
};

const TX_TYPES = Object.freeze({
    DEPOSIT: 'DEPOSIT',
    BUNDLE_PURCHASE: 'BUNDLE_PURCHASE',
    VIP_SUBSCRIPTION: 'VIP_SUBSCRIPTION',
    CHEAP_OTP: 'CHEAP_OTP',
    REFERRAL_REWARD: 'REFERRAL_REWARD'
});

class UserCommands {
    constructor(bot, walletService) {
        this.bot = bot;
        this.walletService = walletService;
        this.registerCommands();
    }

    registerCommands() {
        this.bot.start(this.handleStart.bind(this));
        this.bot.command('menu', this.handleMenu.bind(this));
        this.bot.command('balance', this.handleBalance.bind(this));
        this.bot.command('deposit', this.handleDeposit.bind(this));
        this.bot.command('history', this.handleHistory.bind(this));
        this.bot.command('referral', this.handleReferral.bind(this));
        this.bot.command('stats', this.handleStats.bind(this));
        this.bot.command('settings', this.handleSettings.bind(this));
        this.bot.command('support', this.handleSupport.bind(this));
        
        // FIX: /otp command now delegates to OTPCommands — DO NOT register here
        // The OTPCommands class handles /otp, mode_free, mode_cheap, mode_vip, mode_bundle
        // and service_/country_ selections. UserCommands only handles the menu navigation.
        
        this.bot.command('buybundle', this.handleBuyBundle.bind(this));
        this.bot.command('buyvip', this.handleBuyVIP.bind(this));

        // Callback handlers
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
        
        // FIX: request_otp now just shows the mode selection — OTPCommands handles the rest
        this.bot.action('request_otp', this.handleRequestOTP.bind(this));
        
        this.bot.action('help', this.handleHelp.bind(this));

        // FIX: Removed mode_free, mode_cheap, mode_vip, mode_bundle, buy_bundle, buy_vip
        // from UserCommands — they are handled by OTPCommands to avoid conflicts
        
        // FIX: Removed service_(.+) handler — OTPCommands handles it

        // Purchase confirmations (these can stay as menu shortcuts)
        this.bot.action('buy_bundle', this.handleBuyBundle.bind(this));
        this.bot.action('buy_vip', this.handleBuyVIP.bind(this));

        // Settings toggles
        this.bot.action('toggle_privacy', this.handleTogglePrivacy.bind(this));
        this.bot.action('toggle_notifications', this.handleToggleNotifications.bind(this));
        this.bot.action('change_country', this.handleChangeCountry.bind(this));

        // History export
        this.bot.action('export_history', this.handleExportHistory.bind(this));

        // Preset amount handlers
        this.bot.action('deposit_5', (ctx) => this.handlePresetDeposit(ctx, 5));
        this.bot.action('deposit_10', (ctx) => this.handlePresetDeposit(ctx, 10));
        this.bot.action('deposit_20', (ctx) => this.handlePresetDeposit(ctx, 20));
        this.bot.action('deposit_50', (ctx) => this.handlePresetDeposit(ctx, 50));
        this.bot.action('deposit_100', (ctx) => this.handlePresetDeposit(ctx, 100));
        this.bot.action('deposit_custom', this.handleCustomDeposit.bind(this));

        // Referral share
        this.bot.action(/share_(.+)/, this.handleShareReferral.bind(this));

        // Country selection for settings
        this.bot.action(/setcountry_(.+)/, this.handleSetCountry.bind(this));

        // Copy address handler
        this.bot.action(/copy_address_(.+)/, this.handleCopyAddress.bind(this));

        // Text handler for custom amount
        this.bot.on('text', async (ctx, next) => {
            if (ctx.session?.awaitingDepositAmount) {
                delete ctx.session.awaitingDepositAmount;
                return this.handleDepositAmountInput(ctx);
            }
            if (ctx.session?.awaitingCustomCountry) {
                delete ctx.session.awaitingCustomCountry;
                return this.handleCustomCountryInput(ctx);
            }
            return next();
        });
    }

    async _ensureUserFresh(ctx) {
        const userId = ctx.from.id.toString();
        let user = await User.findOne({ userId }).lean();

        if (!user) {
            user = {
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
            };
            await User.create(user);
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
            user = { ...user, ...updates };
        }

        await User.updateOne({ userId }, { $set: { lastActive: now } }).catch(() => {});

        return user;
    }

    _canUseFree(user) {
        if (user.isBlacklisted) return false;
        const limit = config.limits?.freeDaily || 3;
        return (user.freeUsedToday || 0) < limit;
    }

    _freeRemaining(user) {
        const limit = config.limits?.freeDaily || 3;
        return Math.max(0, limit - (user.freeUsedToday || 0));
    }

    _canUseVip(user) {
        if (!user.vipExpiry || new Date(user.vipExpiry) <= new Date()) return false;
        const limit = config.limits?.vipDaily || 50;
        return (user.vipDailyUsed || 0) < limit;
    }

    _vipRemaining(user) {
        const limit = config.limits?.vipDaily || 50;
        return Math.max(0, limit - (user.vipDailyUsed || 0));
    }

    _isVipActive(user) {
        return user.vipExpiry && new Date(user.vipExpiry) > new Date();
    }

    _getAvailableBalance(user) {
        return (user.balance || 0) - (user.lockedBalance || 0);
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

    async handleStart(ctx) {
        const userId = ctx.from.id.toString();
        let user = await this._ensureUserFresh(ctx);

        const startPayload = ctx.startPayload;
        if (startPayload && !user.referredBy) {
            const referrerCode = startPayload.toUpperCase();
            const referrer = await User.findOne({ referralCode: referrerCode });

            if (referrer && referrer.userId !== userId) {
                await User.updateOne({ userId }, { $set: { referredBy: referrerCode } });
                await User.updateOne(
                    { userId: referrer.userId },
                    { $inc: { referralCount: 1 } }
                );

                await this.sendPhotoWithCaption(
                    ctx,
                    IMAGES.referral,
                    '🎉 <b>You were referred!</b>\n\nYou were invited by ' + (referrer.username || 'a friend') + '!\n\nYou will receive a <b>bonus</b> on your first deposit.'
                );
                user = await User.findOne({ userId }).lean();
            }
        }

        const freeRemaining = this._freeRemaining(user);
        const isVip = this._isVipActive(user);
        const vipRemaining = isVip ? this._vipRemaining(user) : 0;

        const welcomeMessage =
            '👋 <b>Welcome to SwiftOTP</b>, ' + (ctx.from.first_name || 'there') + '!\n\n' +
            '🔐 Get verification codes instantly for any service.\n\n' +
            (isVip ? '👑 <b>VIP Active</b> — ' + vipRemaining + ' left today\n' : '') +
            '💰 Balance: <code>' + formatCurrency(user.balance || 0) + '</code>\n' +
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

        await this.sendPhotoWithCaption(ctx, IMAGES.welcome, welcomeMessage, keyboard, 'HTML');
    }

    async handleMenu(ctx) {
        const user = await this._ensureUserFresh(ctx);

        const freeRemaining = this._freeRemaining(user);
        const isVip = this._isVipActive(user);
        const vipRemaining = isVip ? this._vipRemaining(user) : 0;

        const menuText =
            '📋 <b>Main Menu</b>\n\n' +
            '💰 Balance: <code>' + formatCurrency(user.balance || 0) + '</code>\n' +
            '📦 Bundle: <code>' + (user.bundleRemaining || 0) + '</code> OTPs\n' +
            '🆓 Free Today: <code>' + (3 - freeRemaining) + '/3</code> used\n\n' +
            (isVip ? '👑 VIP: <code>' + (50 - vipRemaining) + '/50</code> used\n' : '') +
            '\nWhat would you like to do?';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔢 Request OTP', 'request_otp'), Markup.button.callback('💳 Deposit', 'deposit')],
            [Markup.button.callback('📜 History', 'history'), Markup.button.callback('📊 Stats', 'stats')],
            [Markup.button.callback('🎁 Referral', 'referral'), Markup.button.callback('⚙️ Settings', 'settings')],
            [Markup.button.callback('💰 Balance', 'balance'), Markup.button.callback('🎧 Support', 'support')],
            [Markup.button.callback('❓ Help', 'help')]
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

    // FIX: request_otp now shows mode selection — OTPCommands handles the actual flow
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

    // FIX: Removed handleFreeMode, handleCheapMode, handleVIPMode, handleBundleMode
    // These are now handled by OTPCommands to avoid duplicate/conflicting handlers

    // FIX: Removed showServiceSelection — OTPCommands handles it

    // FIX: Removed handleServiceSelected placeholder — was breaking OTP flow

    async handleBalance(ctx) {
        const userId = ctx.from.id.toString();
        const user = await this._ensureUserFresh(ctx);

        const pendingDeposit = await Transaction.findOne({
            userId: user.userId,
            type: TX_TYPES.DEPOSIT,
            status: { $in: ['PENDING', 'CONFIRMING'] }
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

        const message =
            '💰 <b>Your Balance</b>\n\n' +
            '💵 Available: <code>' + formatCurrency(this._getAvailableBalance(user)) + '</code>\n' +
            '🔒 Locked: <code>' + formatCurrency(user.lockedBalance || 0) + '</code>\n' +
            '💳 Total Deposited: <code>' + formatCurrency(user.totalDeposited || 0) + '</code>\n' +
            '📉 Total Spent: <code>' + formatCurrency(user.totalSpent || 0) + '</code>\n\n' +
            '📦 Bundle OTPs: <code>' + (user.bundleRemaining || 0) + '</code>\n' +
            '🆓 Free Today: <code>' + freeRemaining + '/3</code>\n' +
            (isVip ? '👑 VIP: <code>' + vipRemaining + '/50</code> left\n' : '👑 VIP: <i>Inactive</i>\n') +
            '\n' +
            (pendingDeposit ? '⏳ Pending Deposit: <code>' + formatCurrency(pendingDeposit.metadata?.requestedAmount || pendingDeposit.amount) + '</code>\n\n' : '') +
            '💎 <b>Deposit Address:</b>\n<code>' + masterAddress + '</code>';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💳 Deposit', 'deposit')],
            [Markup.button.callback('📜 Transaction History', 'history')],
            [Markup.button.callback('🔙 Back to Menu', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.balance, message, keyboard, 'HTML');
    }

    async handleDeposit(ctx) {
        const userId = ctx.from.id.toString();
        try {
            const message =
                '💳 <b>Select Deposit Amount</b>\n\n' +
                'Choose how much <b>USDT (BEP-20)</b> you want to deposit:';

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('💵 $5', 'deposit_5'),
                    Markup.button.callback('💵 $10', 'deposit_10'),
                    Markup.button.callback('💵 $20', 'deposit_20')
                ],
                [
                    Markup.button.callback('💵 $50', 'deposit_50'),
                    Markup.button.callback('💵 $100', 'deposit_100')
                ],
                [Markup.button.callback('✏️ Custom Amount', 'deposit_custom')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);

            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard, 'HTML');
        } catch (error) {
            logger.error('Deposit handler error', { userId, error: error.message });
            await ctx.reply('❌ Error. Please try /deposit again.');
        }
    }

    async handlePresetDeposit(ctx, amount) {
        const userId = ctx.from.id.toString();
        try {
            await ctx.answerCbQuery('Generating $' + amount + ' deposit...');
            await this.showDepositDetails(ctx, userId, amount);
        } catch (error) {
            logger.error('Preset deposit error', { userId, amount, error: error.message });
            await ctx.answerCbQuery('❌ Error');
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
            await this.sendPhotoWithCaption(ctx, 
