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

// ─── Transaction type constants (local mirror for audit logging) ───
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
        this.bot.command('otp', this.handleRequestOTP.bind(this));
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
        this.bot.action('request_otp', this.handleRequestOTP.bind(this));
        this.bot.action('help', this.handleHelp.bind(this));

        // Mode buttons
        this.bot.action('mode_free', this.handleFreeMode.bind(this));
        this.bot.action('mode_cheap', this.handleCheapMode.bind(this));
        this.bot.action('mode_vip', this.handleVIPMode.bind(this));
        this.bot.action('mode_bundle', this.handleBuyBundle.bind(this));

        // Purchase confirmations
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

        // Service selection (placeholder — wired for future OTPCommands integration)
        this.bot.action(/service_(.+)/, this.handleServiceSelected.bind(this));

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

    // ─── Helper: ensure user document exists and counters are fresh ───
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

    // ─── Safe counter helpers ───
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
            '🆓 Free Today: <code>' + freeRemaining + '/3</code>\n\n' +
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
            '🆓 Free Today: <code>' + freeRemaining + '/3</code>\n' +
            (isVip ? '👑 VIP: <code>' + vipRemaining + '/50</code> left\n' : '') +
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

    async handleRequestOTP(ctx) {
        try { await ctx.answerCbQuery('Opening OTP...'); } catch (e) {}

        const user = await this._ensureUserFresh(ctx);
        const freeRemaining = this._freeRemaining(user);
        const isVip = this._isVipActive(user);
        const vipRemaining = isVip ? this._vipRemaining(user) : 0;

        const message =
            '🔢 <b>Request OTP</b>\n\n' +
            '🆓 Free: <code>' + freeRemaining + '/3</code> left\n' +
            '💵 Cheap: <code>' + formatCurrency(config.prices?.cheapOtp || 0.05) + '</code> per OTP\n' +
            '📦 Bundle: <code>' + (user.bundleRemaining || 0) + '</code> OTPs left\n' +
            (isVip ? '👑 VIP: <code>' + vipRemaining + '/50</code> left today\n' : '👑 VIP: <i>Inactive</i>\n') +
            '\nSelect your preferred mode:';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆓 FREE', 'mode_free'), Markup.button.callback('💵 CHEAP', 'mode_cheap')],
            [Markup.button.callback('📦 BUNDLE', 'mode_bundle'), Markup.button.callback('👑 VIP', 'mode_vip')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.welcome, message, keyboard, 'HTML');
    }

    async handleFreeMode(ctx) {
        try { await ctx.answerCbQuery('Loading FREE...'); } catch (e) {}
        const user = await this._ensureUserFresh(ctx);

        if (!this._canUseFree(user)) {
            const message =
                '🚫 <b>Free Limit Reached</b>\n\n' +
                'You have used all 3 free OTPs today.\n\n' +
                '💵 <b>Cheap:</b> <code>' + formatCurrency(config.prices?.cheapOtp || 0.05) + '</code> per OTP\n' +
                '📦 <b>Bundle:</b> <code>' + formatCurrency(config.prices?.bundlePrice || 5.00) + '</code> for 100 OTPs\n' +
                '👑 <b>VIP:</b> <code>' + formatCurrency(config.prices?.vipSubscription || 5.00) + '</code>/month';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.default, message, keyboard, 'HTML');
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'FREE';
        await this.showServiceSelection(ctx, 'FREE');
    }

    async handleCheapMode(ctx) {
        try { await ctx.answerCbQuery('Loading CHEAP...'); } catch (e) {}
        const user = await this._ensureUserFresh(ctx);
        const cheapPrice = config.prices?.cheapOtp || 0.05;

        if (this._getAvailableBalance(user) < cheapPrice) {
            const message =
                '❌ <b>Insufficient Balance</b>\n\n' +
                'Required: <code>' + formatCurrency(cheapPrice) + '</code>\n' +
                'Available: <code>' + formatCurrency(this._getAvailableBalance(user)) + '</code>\n\n' +
                'Please deposit first.';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard, 'HTML');
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'CHEAP';
        await this.showServiceSelection(ctx, 'CHEAP');
    }

    async handleVIPMode(ctx) {
        try { await ctx.answerCbQuery('Loading VIP...'); } catch (e) {}
        const user = await this._ensureUserFresh(ctx);

        if (!this._isVipActive(user)) {
            const message =
                '👑 <b>VIP Required</b>\n\n' +
                'You need an active VIP subscription.\n\n' +
                'Price: <code>' + formatCurrency(config.prices?.vipSubscription || 5.00) + '/month</code>\n' +
                'Includes: 50 OTPs/day, priority routing, fastest delivery\n\n' +
                'Upgrade now?';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Upgrade VIP', 'buy_vip')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.default, message, keyboard, 'HTML');
        }

        if (!this._canUseVip(user)) {
            const message =
                '⏰ <b>VIP Daily Limit Reached</b>\n\n' +
                'You have used <code>50/50</code> VIP OTPs today.\n' +
                'Resets at midnight UTC.\n\n' +
                'You can still use:\n' +
                '🆓 Free: <code>' + this._freeRemaining(user) + '/3</code>\n' +
                '💵 Cheap: <code>' + formatCurrency(config.prices?.cheapOtp || 0.05) + '</code>';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.default, message, keyboard, 'HTML');
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        await this.showServiceSelection(ctx, 'VIP');
    }

    async showServiceSelection(ctx, mode) {
        ctx.session = ctx.session || {};
        ctx.session.otpMode = mode;

        const message = '✅ <b>' + mode + ' Mode Selected</b>\n\nChoose the service you need an OTP for:';

        const buttons = [];
        for (let i = 0; i < SERVICES.length; i += 3) {
            const row = SERVICES.slice(i, i + 3).map(service =>
                Markup.button.callback('📱 ' + service, 'service_' + service)
            );
            buttons.push(row);
        }
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, Markup.inlineKeyboard(buttons), 'HTML');
    }

    async handleServiceSelected(ctx) {
        const service = ctx.match[1];
        const mode = ctx.session?.otpMode || 'FREE';
        try { await ctx.answerCbQuery(service + ' selected'); } catch (e) {}

        const message =
            '📱 <b>' + service + '</b>\n' +
            '🎮 Mode: <code>' + mode + '</code>\n\n' +
            '<i>Service selection confirmed. The OTP request system will process this.</i>';

        await this.sendPhotoWithCaption(
            ctx,
            IMAGES.default,
            message,
            Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Back', 'menu')]
            ]),
            'HTML'
        );
    }

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
            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, null, 'HTML');
        } catch (error) {
            logger.error('Custom deposit error', { userId, error: error.message });
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

    // ═══════════════════════════════════════════════════════════
    //  DEPOSIT DETAILS — CORE FIX: track requestedAmount separately
    //  from trackingAmount so user gets credited the REQUESTED amount
    //  not the blockchain tracking amount
    // ═══════════════════════════════════════════════════════════

    async showDepositDetails(ctx, userId, requestedAmount) {
        try {
            // requestedAmount = what user WANTS to deposit (e.g., $1.00)
            // trackingAmount = what they MUST send on blockchain (e.g., $1.0680)
            // The difference is the system tracking fee — invisible to user balance
            const depositInfo = await this.walletService.getDepositInfo(userId, requestedAmount);
            
            // The amount user must send (with tracking suffix)
            const trackingAmount = depositInfo.amount || depositInfo.trackingAmount || depositInfo.baseAmount || requestedAmount;
            
            // The amount user actually wants (what gets credited to balance)
            const actualAmount = depositInfo.baseAmount || requestedAmount;

            // Store BOTH values: requested for credit, tracking for blockchain identification
            await User.updateOne(
                { userId },
                { 
                    $set: { 
                        depositTrackingAmount: trackingAmount,
                        depositRequestedAmount: actualAmount
                    }
                }
            );

            let depositAddress = depositInfo.address;
            if (!depositAddress && this.walletService?.getMasterAddress) {
                depositAddress = await this.walletService.getMasterAddress();
            }

            const message =
                '💳 <b>Deposit $' + actualAmount + '</b>\n\n' +
                'Send <b>exactly</b> this amount of <b>USDT (BEP-20)</b>:\n\n' +
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
                [Markup.button.callback('📱 Show QR Code', 'deposit_qr')],
                [Markup.button.callback('🔍 Check Deposit', 'check_deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);

            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard, 'HTML');

        } catch (error) {
            logger.error('Show deposit details error', { userId, error: error.message });
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
                return ctx.answerCbQuery('⚠️ Click Deposit first');
            }

            let masterAddress = '';
            try {
                if (this.walletService?.getMasterAddress) {
                    masterAddress = await this.walletService.getMasterAddress();
                }
            } catch (e) {
                return ctx.answerCbQuery('❌ Address unavailable');
            }

            await ctx.answerCbQuery('📱 Generating QR...');

            const qrBuffer = await QRCode.toBuffer(masterAddress, {
                width: 280,
                margin: 2,
                color: { dark: '#00BCD4', light: '#FFFFFF' }
            });

            const caption =
                '📱 <b>Scan to Deposit</b>\n\n' +
                '💵 You receive: <code>$' + requestedAmount + '</code>\n' +
                '📬 Send exactly: <code>' + trackingAmount + '</code> USDT\n' +
                '📬 Address: <code>' + masterAddress + '</code>\n\n' +
                '⚠️ Send EXACTLY <code>' + trackingAmount + '</code> USDT on BSC (BEP-20)\n' +
                '💰 <code>$' + requestedAmount + '</code> will be credited to your balance.';

            const walletUrl = 'https://bscscan.com/address/' + masterAddress;

            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔗 View on BSCScan', url: walletUrl }],
                        [{ text: '📋 Copy Address', callback_data: 'copy_address_' + masterAddress }],
                        [{ text: '🔍 Check Deposit', callback_data: 'check_deposit' }],
                        [{ text: '🔙 Back', callback_data: 'menu' }]
                    ]
                }
            };

            await ctx.replyWithPhoto(
                { source: qrBuffer },
                { caption: caption, parse_mode: 'HTML', reply_markup: keyboard.reply_markup }
            );

        } catch (error) {
            logger.error('QR generation failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Failed to generate QR');
        }
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

                // ═══════════════════════════════════════════════════════════
    //  CHECK DEPOSIT — CORE FIX: credit requestedAmount, not trackingAmount
    //  The blockchain may show $1.0680 but user only gets $1.00 credited
    //  The $0.0680 difference is the system tracking fee
    // ═══════════════════════════════════════════════════════════

    async handleCheckDeposit(ctx) {
        const userId = ctx.from.id.toString();
        try {
            await ctx.answerCbQuery('🔍 Checking...');
            
            // Get the user's pending deposit info BEFORE calling wallet service
            const user = await User.findOne({ userId });
            const requestedAmount = user?.depositRequestedAmount;
            const trackingAmount = user?.depositTrackingAmount;

            // Call wallet service to check blockchain for the tracking amount
            const result = await this.walletService.checkDeposit(userId);

            if (result.found && result.status === 'CONFIRMED') {
                // CRITICAL FIX: Use requestedAmount for balance credit, NOT result.amount
                // result.amount may be $1.0680 (tracking amount with suffix)
                // requestedAmount is $1.00 (what user actually wanted)
                const creditAmount = requestedAmount || result.baseAmount || result.amount;
                
                // Calculate tracking fee (what user sent minus what they get)
                const trackingFee = parseFloat((result.amount - creditAmount).toFixed(4));

                if (creditAmount && creditAmount > 0) {
                    // Credit ONLY the requested amount to user balance
                    await User.updateOne(
                        { userId },
                        {
                            $inc: { balance: creditAmount, totalDeposited: creditAmount },
                            $set: { 
                                depositTrackingAmount: null,
                                depositRequestedAmount: null
                            }
                        }
                    );

                    // Mark transaction as completed with BOTH amounts recorded
                    await Transaction.updateOne(
                        { userId, type: TX_TYPES.DEPOSIT, status: 'PENDING' },
                        {
                            $set: {
                                status: 'COMPLETED',
                                amount: creditAmount,                    // What user gets
                                metadata: {
                                    requestedAmount: creditAmount,         // User requested
                                    trackingAmount: result.amount,        // What was sent on chain
                                    trackingFee: trackingFee,             // System fee
                                    txHash: result.txHash,
                                    depositAddress: result.address,
                                    confirmedAt: new Date()
                                }
                            }
                        }
                    );

                    // Process referral bonus (first deposit only) — based on CREDIT amount
                    const refreshedUser = await User.findOne({ userId });
                    if (refreshedUser?.referredBy && !refreshedUser?.referralBonusReceived) {
                        const bonusPercent = config.referral?.percentage || 0.05;
                        const bonusAmount = parseFloat((creditAmount * bonusPercent).toFixed(2));

                        if (bonusAmount > 0) {
                            // Credit bonus to new user
                            await User.updateOne(
                                { userId },
                                {
                                    $inc: { balance: bonusAmount },
                                    $set: { referralBonusReceived: true }
                                }
                            );

                            // Create bonus transaction for new user
                            await Transaction.create({
                                txId: 'REFBONUS_' + Date.now() + '_' + userId,
                                userId,
                                type: TX_TYPES.REFERRAL_REWARD,
                                amount: bonusAmount,
                                status: 'COMPLETED',
                                metadata: {
                                    source: 'first_deposit_bonus',
                                    referrerCode: refreshedUser.referredBy,
                                    depositAmount: creditAmount,
                                    percentage: bonusPercent
                                },
                                createdAt: new Date()
                            });

                            // Credit referrer
                            const referrer = await User.findOne({ referralCode: refreshedUser.referredBy });
                            if (referrer) {
                                await User.updateOne(
                                    { userId: referrer.userId },
                                    { $inc: { referralEarnings: bonusAmount, referralRewardsPending: bonusAmount } }
                                );

                                // Create referrer transaction
                                await Transaction.create({
                                    txId: 'REFERRAL_' + Date.now() + '_' + referrer.userId,
                                    userId: referrer.userId,
                                    type: TX_TYPES.REFERRAL_REWARD,
                                    amount: bonusAmount,
                                    status: 'PENDING',
                                    metadata: {
                                        source: 'referral_first_deposit',
                                        referredUserId: userId,
                                        depositAmount: creditAmount,
                                        percentage: bonusPercent
                                    },
                                    createdAt: new Date()
                                });

                                try {
                                    await ctx.telegram.sendMessage(
                                        referrer.userId,
                                        '🎉 <b>Referral Bonus!</b>\n\n' +
                                        'Your referral ' + (ctx.from.username || userId) + ' made their first deposit!\n\n' +
                                        '💰 You earned: <code>' + formatCurrency(bonusAmount) + '</code>\n' +
                                        '⏳ Status: <i>Pending admin approval</i>',
                                        { parse_mode: 'HTML' }
                                    );
                                } catch (e) {
                                    logger.warn('Failed to notify referrer', { referrerId: referrer.userId });
                                }
                            }

                            // Notify user of bonus
                            await ctx.telegram.sendMessage(
                                userId,
                                '🎁 <b>Deposit Bonus!</b>\n\n' +
                                'You received a <code>' + formatCurrency(bonusAmount) + '</code> bonus from your referral!\n\n' +
                                '💰 New Balance: <code>' + formatCurrency((refreshedUser.balance || 0) + creditAmount + bonusAmount) + '</code>',
                                { parse_mode: 'HTML' }
                            ).catch(() => {});
                        }
                    }
                }

                const message =
                    '✅ <b>Deposit Confirmed!</b>\n\n' +
                    '💵 Credited: <code>' + formatCurrency(creditAmount) + '</code>\n' +
                    (trackingFee > 0 ? '🔧 Tracking Fee: <code>' + formatCurrency(trackingFee) + '</code>\n' : '') +
                    '✅ Status: <code>' + result.status + '</code>\n' +
                    '🔗 TX: <code>' + (result.txHash || 'N/A') + '</code>\n\n' +
                    '💰 Your balance has been updated.';

                return this.sendPhotoWithCaption(ctx, IMAGES.depositConfirmed, message, null, 'HTML');
            }

            if (result.found && result.status === 'CONFIRMING') {
                const message =
                    '⏳ <b>Deposit Confirming</b>\n\n' +
                    '💵 Amount: <code>' + formatCurrency(requestedAmount || result.amount) + '</code>\n' +
                    '🔢 Confirmations: <code>' + (result.confirmations || 0) + '/' + (config.blockchain?.blockConfirmations || 12) + '</code>\n\n' +
                    '⏱ Please wait for full confirmation.';

                return this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, null, 'HTML');
            }

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

    async handleHistory(ctx) {
        const userId = ctx.from.id.toString();
        const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(15).lean();

        let message = '📜 <b>Recent Transactions</b>\n\n';
        if (!transactions.length) {
            message += '<i>No transactions yet. Deposit to get started!</i>';
        } else {
            transactions.forEach((tx, index) => {
                const icon = tx.type === TX_TYPES.DEPOSIT ? '💳' :
                    tx.type === TX_TYPES.BUNDLE_PURCHASE ? '📦' :
                        tx.type === TX_TYPES.VIP_SUBSCRIPTION ? '👑' :
                            tx.type === TX_TYPES.REFERRAL_REWARD ? '🎁' :
                                tx.amount >= 0 ? '➕' : '➖';
                const type = (tx.type || 'Unknown').replace(/_/g, ' ');
                const amountPrefix = tx.amount >= 0 ? '+' : '';
                
                // Show tracking fee info for deposits
                let extraInfo = '';
                if (tx.type === TX_TYPES.DEPOSIT && tx.metadata?.trackingFee > 0) {
                    extraInfo = ' (fee: ' + formatCurrency(tx.metadata.trackingFee) + ')';
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

    async handleExportHistory(ctx) {
        const userId = ctx.from.id.toString();
        try {
            await ctx.answerCbQuery('📥 Generating CSV...');
            const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 }).lean();

            if (!transactions.length) {
                return ctx.reply('📭 No transactions to export.');
            }

            let csv = 'Date,Type,Amount,Status,TrackingFee,TX Hash\n';
            for (const tx of transactions) {
                const date = tx.createdAt ? new Date(tx.createdAt).toISOString().split('T')[0] : 'N/A';
                const trackingFee = tx.metadata?.trackingFee || 0;
                csv += date + ',' + (tx.type || 'Unknown') + ',' + (tx.amount || 0) + ',' + (tx.status || 'Unknown') + ',' + trackingFee + ',' + (tx.txHash || 'N/A') + '\n';
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
            '• Balance: <code>' + formatCurrency(user?.balance || 0) + '</code>\n\n' +
            '🎮 <b>Usage:</b>\n' +
            '• Free: <code>' + freeRemaining + '/3</code>\n' +
            '• Bundle: <code>' + (user?.bundleRemaining || 0) + '</code>\n' +
            (isVip ? '• VIP: <code>' + vipRemaining + '/50</code>\n' : '') +
            '\n📅 Member Since: ' + (user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Unknown');

        await this.sendPhotoWithCaption(ctx, IMAGES.stats, message, Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'menu')]
        ]), 'HTML');
    }

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

    
    async handleChangeCountry(ctx) {
        ctx.session = ctx.session || {};
        ctx.session.awaitingCustomCountry = false;

        const countries = [
            { code: 'US', name: '🇺🇸 United States', flag: '🇺🇸' },
            { code: 'UK', name: '🇬🇧 United Kingdom', flag: '🇬🇧' },
            { code: 'CA', name: '🇨🇦 Canada', flag: '🇨🇦' },
            { code: 'AU', name: '🇦🇺 Australia', flag: '🇦🇺' },
            { code: 'DE', name: '🇩🇪 Germany', flag: '🇩🇪' },
            { code: 'FR', name: '🇫🇷 France', flag: '🇫🇷' },
            { code: 'IN', name: '🇮🇳 India', flag: '🇮🇳' },
            { code: 'NG', name: '🇳🇬 Nigeria', flag: '🇳🇬' }
        ];

        const buttons = countries.map(c => [
            Markup.button.callback(c.flag + ' ' + c.name, 'setcountry_' + c.code)
        ]);
        buttons.push([Markup.button.callback('✏️ Custom', 'custom_country')]);
        buttons.push([Markup.button.callback('🔙 Back', 'settings')]);

        const message = '🌍 <b>Select Your Preferred Country</b>\n\nChoose a country for your OTP numbers:';
        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, Markup.inlineKeyboard(buttons), 'HTML');
    }

    async handleSetCountry(ctx) {
        const countryCode = ctx.match[1];
        const userId = ctx.from.id.toString();
        await User.updateOne({ userId }, { $set: { preferredCountry: countryCode } });
        await ctx.answerCbQuery('🌍 Country set to ' + countryCode);
        await this.handleSettings(ctx);
    }

    async handleCustomCountryInput(ctx) {
        const countryCode = ctx.message.text.trim().toUpperCase().substring(0, 2);
        const userId = ctx.from.id.toString();
        await User.updateOne({ userId }, { $set: { preferredCountry: countryCode } });
        await ctx.reply('🌍 Country set to <code>' + countryCode + '</code>', { parse_mode: 'HTML' });
        await this.handleSettings(ctx);
    }

    async handleSupport(ctx) {
        try {
            const message =
                '🎧 <b>SwiftSupport</b> — Customer Service\n\n' +
                'Need help? Our support team is here for you!\n\n' +
                '💬 Contact: <code>@swiftsmssupport</code>\n' +
                '⏱ Response Time: Usually within 5 minutes\n\n' +
                '❓ <b>Common Issues:</b>\n' +
                '• Deposit not showing? → Use <code>/deposit</code> then Check Deposit\n' +
                '• OTP not received? → Cancel and retry\n' +
                '• Wrong amount sent? → Contact support with TX hash\n\n' +
                '⚠️ Please include your <b>User ID</b> when contacting support.';

            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💬 Chat Support', url: 'https://t.me/swiftsmssupport' }],
                        [{ text: '🔙 Back', callback_data: 'menu' }]
                    ]
                }
            };

            await this.sendPhotoWithCaption(ctx, IMAGES.support, message, keyboard, 'HTML');
        } catch (error) {
            logger.error('Support handler error', { error: error.message, userId: ctx.from?.id });
            try {
                await ctx.reply(
                    '🎧 Customer Service\n\nContact @swiftsmssupport for help.',
                    {
                        reply_markup: {
                            inline_keyboard: [[{ text: '💬 Chat Support', url: 'https://t.me/swiftsmssupport' }]]
                        }
                    }
                );
            } catch (e) {
                logger.error('Support fallback failed', { error: e.message });
            }
        }
    }

    async handleHelp(ctx) {
        const message =
            '❓ <b>Help & FAQ</b>\n\n' +
            '<b>How to request OTP:</b>\n' +
            '1️⃣ Tap Request OTP or use /otp\n' +
            '2️⃣ Select mode (FREE, CHEAP, VIP, or Bundle)\n' +
            '3️⃣ Choose service (WhatsApp, Telegram, etc.)\n' +
            '4️⃣ Select country\n' +
            '5️⃣ Wait for OTP to arrive\n\n' +
            '<b>How to deposit:</b>\n' +
            '1️⃣ Tap Deposit or use /deposit\n' +
            '2️⃣ Select amount\n' +
            '3️⃣ Send USDT (BEP-20) to shown address\n' +
            '4️⃣ Tap Check Deposit or wait 1-2 minutes\n\n' +
            '👑 <b>VIP Benefits:</b>\n' +
            '• 50 OTPs/day\n' +
            '• Priority routing\n' +
            '• Fastest delivery\n' +
            '• $5/month\n\n' +
            '📦 <b>Bundle:</b>\n' +
            '• 100 OTPs for $5\n' +
            '• Never expires\n\n' +
            '<b>Commands:</b>\n' +
            '/start — Welcome screen\n' +
            '/menu — Main menu\n' +
            '/balance — Check balance\n' +
            '/deposit — Add funds\n' +
            '/history — Transactions\n' +
            '/referral — Earn rewards\n' +
            '/stats — Your statistics\n' +
            '/settings — Preferences\n' +
            '/support — Customer service\n' +
            '/otp — Request OTP\n' +
            '/buybundle — Buy 100 OTPs\n' +
            '/buyvip — Upgrade to VIP';

        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'menu')]
        ]), 'HTML');
    }

    async handleBuyBundle(ctx) {
        const user = await this._ensureUserFresh(ctx);
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;

        if (this._getAvailableBalance(user) < bundlePrice) {
            const message =
                '❌ <b>Insufficient Balance</b>\n\n' +
                'Required: <code>' + formatCurrency(bundlePrice) + '</code>\n' +
                'Available: <code>' + formatCurrency(this._getAvailableBalance(user)) + '</code>\n\n' +
                'Deposit first with /deposit';

            return this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]), 'HTML');
        }

        await User.updateOne(
            { userId: user.userId },
            {
                $inc: {
                    balance: -bundlePrice,
                    bundleRemaining: bundleCount,
                    totalSpent: bundlePrice
                }
            }
        );

        await Transaction.create({
            txId: 'BUNDLE_' + Date.now() + '_' + user.userId,
            userId: user.userId,
            type: TX_TYPES.BUNDLE_PURCHASE,
            amount: -bundlePrice,
            status: 'COMPLETED',
            metadata: {
                bundleCount,
                pricePerOtp: bundlePrice / bundleCount
            },
            createdAt: new Date()
        });

        const message =
            '📦 <b>Bundle Purchased!</b>\n\n' +
            '✅ <code>' + bundleCount + '</code> OTPs added\n' +
            '💵 <code>' + formatCurrency(bundlePrice) + '</code> deducted\n' +
            '📦 Total Available: <code>' + ((user.bundleRemaining || 0) + bundleCount) + '</code> OTPs\n\n' +
            'Use /otp to start requesting.';

        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, Markup.inlineKeyboard([
            [Markup.button.callback('🔢 Request OTP', 'request_otp')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]), 'HTML');
    }

    async handleBuyVIP(ctx) {
        const user = await this._ensureUserFresh(ctx);
        const vipPrice = config.prices?.vipSubscription || 5.00;

        if (this._getAvailableBalance(user) < vipPrice) {
            const message =
                '❌ <b>Insufficient Balance</b>\n\n' +
                'Required: <code>' + formatCurrency(vipPrice) + '</code>\n' +
                'Available: <code>' + formatCurrency(this._getAvailableBalance(user)) + '</code>\n\n' +
                'Deposit first with /deposit';

            return this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]), 'HTML');
        }

        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + 1);

        await User.updateOne(
            { userId: user.userId },
            {
                $inc: { balance: -vipPrice, totalSpent: vipPrice },
                $set: {
                    mode: 'VIP',
                    vipExpiry: expiryDate,
                    vipDailyUsed: 0,
                    vipDailyReset: new Date()
                }
            }
        );

        await Transaction.create({
            txId: 'VIP_' + Date.now() + '_' + user.userId,
            userId: user.userId,
            type: TX_TYPES.VIP_SUBSCRIPTION,
            amount: -vipPrice,
            status: 'COMPLETED',
            metadata: {
                duration: '1 month',
                expiryDate,
                vipDailyLimit: config.limits?.vipDaily || 50
            },
            createdAt: new Date()
        });

        const message =
            '👑 <b>VIP Activated!</b>\n\n' +
            '✅ Valid until: <code>' + expiryDate.toLocaleDateString() + '</code>\n' +
            '🔢 50 OTPs/day\n' +
            '⚡ Priority delivery enabled\n\n' +
            '🎉 Enjoy premium service!';

        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, Markup.inlineKeyboard([
            [Markup.button.callback('🔢 Request OTP', 'request_otp')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]), 'HTML');
    }
}

export default UserCommands;
