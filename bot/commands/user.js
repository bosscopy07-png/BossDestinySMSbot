import { Markup } from 'telegraf';
import QRCode from 'qrcode';
import { User, Session, Transaction } from '../../models/index.js';
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
        
        // FIXED: Wire all mode buttons to actual handlers
        this.bot.action('mode_free', this.handleFreeMode.bind(this));
        this.bot.action('mode_cheap', this.handleCheapMode.bind(this));
        this.bot.action('mode_vip', this.handleVIPMode.bind(this));
        this.bot.action('mode_bundle', this.handleBuyBundle.bind(this));
        
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
        
        // Text handler for custom amount
        this.bot.on('text', async (ctx, next) => {
            if (ctx.session?.awaitingDepositAmount) {
                ctx.session.awaitingDepositAmount = false;
                return this.handleDepositAmountInput(ctx);
            }
            if (ctx.session?.awaitingCustomCountry) {
                ctx.session.awaitingCustomCountry = false;
                return this.handleCustomCountryInput(ctx);
            }
            return next();
        });
    }

    async sendPhotoWithCaption(ctx, imageUrl, caption, keyboard = null, parseMode = null) {
        try {
            const payload = { caption: caption.trim() };
            if (parseMode) payload.parse_mode = parseMode;
            if (keyboard) payload.reply_markup = keyboard.reply_markup;
            return await ctx.replyWithPhoto(imageUrl, payload);
        } catch (error) {
            logger.error('Photo send failed', { error: error.message, url: imageUrl });
            if (keyboard) {
                return await ctx.reply(caption, keyboard);
            }
            return await ctx.reply(caption);
        }
    }

    async handleStart(ctx) {
        const userId = ctx.from.id.toString();
        let user = ctx.state.user;

        const startPayload = ctx.startPayload;
        if (startPayload && !user.referredBy) {
            const referrerCode = startPayload.toUpperCase();
            const referrer = await User.findOne({ referralCode: referrerCode });
            
            if (referrer && referrer.userId !== userId) {
                await User.updateOne({ userId }, { $set: { referredBy: referrerCode } });
                await User.updateOne(
                    { userId: referrer.userId },
                    { $inc: { referralCount: 1 }, $push: { referrals: userId } }
                );
                
                await this.sendPhotoWithCaption(ctx, IMAGES.referral, 'You were referred by ' + (referrer.username || 'a friend') + '!\n\nYou will get a bonus on your first deposit.');
                user = await User.findOne({ userId });
            }
        }

        if (isNewDay(user.freeResetDate)) {
            await User.updateOne({ userId }, { $set: { freeUsedToday: 0, freeResetDate: new Date() } });
            user.freeUsedToday = 0;
        }

        const welcomeMessage = 'Welcome to SwiftOTP, ' + (ctx.from.first_name || 'there') + '!\n\nGet verification codes instantly for any service.\n\n' +
            (user.isVipActive?.() ? 'VIP Active\n' : '') +
            'Balance: ' + formatCurrency(user.balance || 0) + '\n' +
            'Bundle: ' + (user.bundleRemaining || 0) + ' OTPs\n' +
            'Free Today: ' + Math.max(0, 3 - (user.freeUsedToday || 0)) + '/3\n\n' +
            'Choose your mode or deposit to get started:';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('FREE OTP', 'mode_free'), Markup.button.callback('CHEAP OTP', 'mode_cheap')],
            [Markup.button.callback('Buy Bundle', 'mode_bundle'), Markup.button.callback('Upgrade VIP', 'mode_vip')],
            [Markup.button.callback('Deposit', 'deposit'), Markup.button.callback('My Stats', 'stats')],
            [Markup.button.callback('Referral', 'referral'), Markup.button.callback('Settings', 'settings')],
            [Markup.button.callback('Check Balance', 'balance'), Markup.button.callback('Customer Service', 'support')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.welcome, welcomeMessage, keyboard);
    }

    async handleMenu(ctx) {
        const user = ctx.state.user || await User.findOne({ userId: ctx.from.id.toString() });

        const menuText = 'Main Menu\n\n' +
            'Balance: ' + formatCurrency(user.balance || 0) + '\n' +
            'Bundle: ' + (user.bundleRemaining || 0) + ' OTPs\n' +
            'Free Today: ' + Math.max(0, 3 - (user.freeUsedToday || 0)) + '/3\n' +
            (user.isVipActive?.() ? 'VIP Until: ' + user.vipExpiry?.toLocaleDateString() + '\n' : '') +
            '\nWhat would you like to do?';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('Request OTP', 'request_otp'), Markup.button.callback('Deposit', 'deposit')],
            [Markup.button.callback('History', 'history'), Markup.button.callback('Stats', 'stats')],
            [Markup.button.callback('Referral', 'referral'), Markup.button.callback('Settings', 'settings')],
            [Markup.button.callback('Check Balance', 'balance'), Markup.button.callback('Customer Service', 'support')],
            [Markup.button.callback('Help', 'help')]
        ]);

        try {
            await ctx.editMessageText(menuText, keyboard);
        } catch {
            await this.sendPhotoWithCaption(ctx, IMAGES.mainMenu, menuText, keyboard);
        }
    }

    // FIXED: Actually routes to OTP - shows mode selection that WORKS
    async handleRequestOTP(ctx) {
        try { await ctx.answerCbQuery('Opening OTP...'); } catch (e) {}
        
        const message = 'Request OTP\n\nSelect your preferred mode:';
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('FREE', 'mode_free'), Markup.button.callback('CHEAP', 'mode_cheap')],
            [Markup.button.callback('BUNDLE', 'mode_bundle'), Markup.button.callback('VIP', 'mode_vip')],
            [Markup.button.callback('Back', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.welcome, message, keyboard);
    }

    // FIXED: These now actually DO something instead of showing a menu
    async handleFreeMode(ctx) {
        try { await ctx.answerCbQuery('Loading FREE...'); } catch (e) {}
        const user = ctx.state.user || await User.findOne({ userId: ctx.from.id.toString() });
        
        if (!user.canUseFree || !user.canUseFree()) {
            const message = 'Free Limit Reached\n\nYou have used all 3 free OTPs today.\n\nDeposit to continue:\n- CHEAP: $0.05 per OTP\n- Bundle: $5 for 100 OTPs';
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('Deposit', 'deposit')],
                [Markup.button.callback('Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.default, message, keyboard);
        }
        
        // Store mode and redirect to service selection (would be handled by OTPCommands or next step)
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'FREE';
        await ctx.reply('FREE mode selected. Use /otp to choose service and country.');
    }

    async handleCheapMode(ctx) {
        try { await ctx.answerCbQuery('Loading CHEAP...'); } catch (e) {}
        const user = ctx.state.user || await User.findOne({ userId: ctx.from.id.toString() });
        const cheapPrice = config.prices?.cheapOtp || 0.05;
        
        if (user.getAvailableBalance && user.getAvailableBalance() < cheapPrice) {
            const message = 'Insufficient Balance\n\nRequired: ' + formatCurrency(cheapPrice) + '\nAvailable: ' + formatCurrency(user.getAvailableBalance()) + '\n\nPlease deposit first.';
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('Deposit', 'deposit')],
                [Markup.button.callback('Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard);
        }
        
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'CHEAP';
        await ctx.reply('CHEAP mode selected. Use /otp to choose service and country.');
    }

    async handleVIPMode(ctx) {
        try { await ctx.answerCbQuery('Loading VIP...'); } catch (e) {}
        const user = ctx.state.user || await User.findOne({ userId: ctx.from.id.toString() });
        
        if (!user.isVipActive || !user.isVipActive()) {
            const message = 'VIP Required\n\nYou need an active VIP subscription.\n\nPrice: ' + formatCurrency(config.prices?.vipSubscription || 5.00) + '/month\nIncludes: Unlimited OTPs (50/day max)\n\nUpgrade now?';
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('Upgrade VIP', 'buy_vip')],
                [Markup.button.callback('Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.default, message, keyboard);
        }
        
        if (!user.canUseVip || !user.canUseVip()) {
            const message = 'VIP Daily Limit Reached\n\nYou have used 50/50 VIP OTPs today.\nResets at midnight UTC.';
            return this.sendPhotoWithCaption(ctx, IMAGES.default, message);
        }
        
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        await ctx.reply('VIP mode selected. Use /otp to choose service and country.');
    }

    async handleBalance(ctx) {
        const userId = ctx.from.id.toString();
        const user = await User.findOne({ userId });
        const pendingDeposit = await Transaction.findOne({
            userId: user.userId,
            type: 'DEPOSIT',
            status: { $in: ['PENDING', 'CONFIRMING'] }
        });

        const message = 'Your Balance\n\n' +
            'Available: ' + formatCurrency((user.balance || 0) - (user.lockedBalance || 0)) + '\n' +
            'Locked: ' + formatCurrency(user.lockedBalance || 0) + '\n' +
            'Total Deposited: ' + formatCurrency(user.totalDeposited || 0) + '\n' +
            'Total Spent: ' + formatCurrency(user.totalSpent || 0) + '\n\n' +
            'Bundle OTPs: ' + (user.bundleRemaining || 0) + '\n' +
            (user.isVipActive?.() ? 'VIP Until: ' + user.vipExpiry?.toLocaleDateString() : 'VIP: Inactive') + '\n\n' +
            (pendingDeposit ? 'Pending Deposit: ' + formatCurrency(pendingDeposit.amount) + '\n\n' : '') +
            'Deposit to:\n' + this.walletService.getMasterAddress();

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('Deposit', 'deposit')],
            [Markup.button.callback('Transaction History', 'history')],
            [Markup.button.callback('Back to Menu', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.balance, message, keyboard);
    }

    async handleDeposit(ctx) {
        const userId = ctx.from.id.toString();
        try {
            const message = 'Select Deposit Amount\n\nChoose how much USDT you want to deposit:';
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('$5', 'deposit_5'), Markup.button.callback('$10', 'deposit_10'), Markup.button.callback('$20', 'deposit_20')],
                [Markup.button.callback('$50', 'deposit_50'), Markup.button.callback('$100', 'deposit_100')],
                [Markup.button.callback('Custom Amount', 'deposit_custom')],
                [Markup.button.callback('Back', 'menu')]
            ]);
            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard);
        } catch (error) {
            logger.error('Deposit handler error', { userId, error: error.message });
            await ctx.reply('Error. Please try /deposit again.');
        }
    }

    async handlePresetDeposit(ctx, amount) {
        const userId = ctx.from.id.toString();
        try {
            await ctx.answerCbQuery('Generating $' + amount + ' deposit...');
            await this.showDepositDetails(ctx, userId, amount);
        } catch (error) {
            logger.error('Preset deposit error', { userId, amount, error: error.message });
            await ctx.answerCbQuery('Error');
        }
    }

    async handleCustomDeposit(ctx) {
        const userId = ctx.from.id.toString();
        try {
            ctx.session = ctx.session || {};
            ctx.session.awaitingDepositAmount = true;
            await ctx.answerCbQuery('Enter custom amount');
            const message = 'Custom Deposit\n\nSend the amount you want to deposit (in USD):\n\nExamples:\n- 5 (for $5)\n- 10.50 (for $10.50)\n- 25 (for $25)\n\nMinimum: $0.50';
            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message);
        } catch (error) {
            logger.error('Custom deposit error', { userId, error: error.message });
        }
    }

    async handleDepositAmountInput(ctx) {
        const userId = ctx.from.id.toString();
        const text = ctx.message.text.trim().replace(/[^0-9.]/g, '');
        const amount = parseFloat(text);
        if (isNaN(amount) || amount < 0.50) {
            return this.sendPhotoWithCaption(ctx, IMAGES.deposit, 'Invalid amount. Minimum is $0.50. Try /deposit again.');
        }
        await this.showDepositDetails(ctx, userId, amount);
    }

    async showDepositDetails(ctx, userId, amount) {
        try {
            const depositInfo = await this.walletService.getDepositInfo(userId, amount);
            const displayAmount = depositInfo.amount || depositInfo.baseAmount || amount;
            await User.updateOne({ userId }, { $set: { depositTrackingAmount: displayAmount } });

            const message = 'Deposit $' + displayAmount + '\n\nSend exactly this amount of USDT (BEP-20):\n\n' +
                'Amount: $' + displayAmount + '\n' +
                'Address: ' + (depositInfo.address || this.walletService.getMasterAddress()) + '\n' +
                'Network: ' + (depositInfo.network || 'BSC (BEP-20)') + '\n\n' +
                'IMPORTANT:\n' +
                '- Send ONLY USDT on BSC (BEP-20)\n' +
                '- Send EXACTLY $' + displayAmount + '\n' +
                '- This exact amount identifies your deposit\n\n' +
                'Funds credited automatically in 1-2 minutes.';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('Show QR Code', 'deposit_qr')],
                [Markup.button.callback('Check Deposit', 'check_deposit')],
                [Markup.button.callback('Back', 'menu')]
            ]);

            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard);

        } catch (error) {
            logger.error('Show deposit details error', { userId, error: error.message });
            await ctx.reply('Error generating deposit. Please try again.');
        }
    }

    // FIXED: Use https:// link instead of ethereum: scheme for button URL
    async handleDepositQR(ctx) {
        const userId = ctx.from.id.toString();
        try {
            const user = await User.findOne({ userId });
            const trackingAmount = user?.depositTrackingAmount;
            
            if (!trackingAmount) {
                return ctx.answerCbQuery('Click Deposit first');
            }

            const masterAddress = this.walletService.getMasterAddress();
            
            // FIXED: Use BSCScan or a web wallet URL instead of ethereum: scheme
            // Telegram rejects ethereum: URLs in buttons. Use a web-based wallet opener.
            const walletUrl = 'https://metamask.app.link/send/' + masterAddress + '?value=0&asset=c60_t0x55d398326f99059fF775485246999027B3197955';
            
            await ctx.answerCbQuery('Generating QR...');
            
            const qrBuffer = await QRCode.toBuffer(masterAddress, {
                width: 400,
        
