import { Markup } from 'telegraf';
import { Session, User } from '../../models/index.js';
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
    depositConfirmed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235826/file_000000001c0c720aa51ae407e6741ca5_steie1.png'
};

class OTPCommands {
    constructor(bot, walletService) {
        this.bot = bot;
        this.walletService = walletService;
        this.registerCommands();
    }

    registerCommands() {
        this.bot.command('otp', this.handleOTPCommand.bind(this));
        this.bot.command('cancel', this.handleCancel.bind(this));
        this.bot.action('mode_free', this.handleFreeMode.bind(this));
        this.bot.action('mode_cheap', this.handleCheapMode.bind(this));
        this.bot.action('mode_vip', this.handleVIPMode.bind(this));
        this.bot.action('mode_bundle', this.handleBuyBundle.bind(this));
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

    async handleOTPCommand(ctx) {
        const message = '📱 Request OTP\n\nSelect your preferred mode:';
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆓 FREE', 'mode_free'), Markup.button.callback('💰 CHEAP', 'mode_cheap')],
            [Markup.button.callback('📦 Bundle', 'mode_bundle'), Markup.button.callback('👑 VIP', 'mode_vip')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);
        await this.sendPhotoWithCaption(ctx, IMAGES.otpMenu, message, keyboard);
    }

    async handleFreeMode(ctx) {
        const user = ctx.state.user;
        if (!user.canUseFree()) {
            const message = '❌ Free Limit Reached\n\nYou\'ve used all 3 free OTPs today.\n\n💰 Deposit to continue:\n• CHEAP: $0.05 per OTP\n• Bundle: $5 for 100 OTPs';
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.freeMode, message, keyboard);
        }
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'FREE';
        await this.showServiceSelection(ctx, 'FREE', IMAGES.freeMode);
    }

    async handleCheapMode(ctx) {
        const user = ctx.state.user;
        const cheapPrice = config.prices?.cheapOtp || 0.05;
        if (user.getAvailableBalance() < cheapPrice) {
            const message = `💰 Insufficient Balance\n\nRequired: ${formatCurrency(cheapPrice)}\nAvailable: ${formatCurrency(user.getAvailableBalance())}\n\nPlease deposit first.`;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.cheapMode, message, keyboard);
        }
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'CHEAP';
        await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode);
    }

    async handleVIPMode(ctx) {
        const user = ctx.state.user;
        if (!user.isVipActive()) {
            const message = `👑 VIP Required\n\nYou need an active VIP subscription.\n\nPrice: ${formatCurrency(config.prices?.vipSubscription || 5.00)}/month\nIncludes: Unlimited OTPs (50/day max)\n\nUpgrade now?`;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            return this.sendPhotoWithCaption(ctx, IMAGES.vipFirst, message, keyboard);
        }
        if (!user.canUseVip()) {
            const message = '⚠️ VIP Daily Limit Reached\n\nYou\'ve used 50/50 VIP OTPs today.\nResets at midnight UTC.';
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message);
        }
        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        await this.showServiceSelection(ctx, 'VIP', IMAGES.vipOther);
    }

    async showServiceSelection(ctx, mode, imageUrl) {
        const message = `📱 ${mode} Mode\n\nChoose the service you need OTP for:`;
        const buttons = [];
        for (let i = 0; i < SERVICES.length; i += 3) {
            const row = SERVICES.slice(i, i + 3).map(s => Markup.button.callback(s, `service_${s}`));
            buttons.push(row);
        }
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, imageUrl, message, Markup.inlineKeyboard(buttons));
    }

    async handleServiceSelect(ctx) {
        const service = ctx.match[1];
        ctx.session = ctx.session || {};
        ctx.session.otpService = service;
        const message = `🌍 Select Country\n\nChoose number country for ${service}:`;
        const buttons = COUNTRIES.map(c => [
            Markup.button.callback(`${c.flag} ${c.name}${c.priceModifier > 0 ? ` (+$${c.priceModifier})` : ''}`, `country_${c.code}`)
        ]);
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, IMAGES.countrySelect, message, Markup.inlineKeyboard(buttons));
    }

    async handleCountrySelect(ctx) {
        const country = ctx.match[1];
        const userId = ctx.from.id.toString();
        const mode = ctx.session?.otpMode;
        const service = ctx.session?.otpService;
        if (!mode || !service) {
            return this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ Session expired. Please start over with /otp');
        }
        try {
            const loadingMsg = await ctx.reply('⏳ Assigning number...');
            const session = await sessionManager.createSession(userId, mode, service, country);
            await ctx.deleteMessage(loadingMsg.message_id);
            const costText = mode === 'FREE' ? 'FREE' : formatCurrency(session.cost);
            const message = `📱 OTP Request Started\n\n🌍 Mode: ${mode}\n📱 Number: \`${session.number}\`\n🎯 Service: ${service}\n⏳ Status: Waiting for OTP...\n💰 Cost: ${costText}\n⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n⚠️ ${mode === 'FREE' ? 'Shared number. OTP not guaranteed.' : 'Funds locked. Will be deducted on delivery.'}`;
            const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_otp')]]);
            await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard);
        } catch (error) {
            logger.error('OTP session creation failed', { userId, mode, service, error: error.message });
            const errorMessages = {
                ACTIVE_SESSION_EXISTS: '⏳ You already have an active session. Use /cancel first.',
                INSUFFICIENT_BALANCE: '💰 Insufficient balance. Deposit first with /deposit',
                FREE_LIMIT_REACHED: '🆓 Free limit reached for today.',
                USER_BLACKLISTED: '🚫 Your account is suspended.',
                VIP_EXPIRED: '👑 VIP expired. Renew your subscription.',
                VIP_DAILY_LIMIT_REACHED: '⚠️ VIP daily limit (50) reached.'
            };
            await this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, errorMessages[error.message] || `❌ Error: ${error.message}`);
        }
    }

    async handleCancel(ctx) {
        const userId = ctx.from.id.toString();
        try {
            const activeSession = await Session.findOne({ userId, status: { $in: ['WAITING', 'CHECKING'] } });
            if (!activeSession) {
                return this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ No active session to cancel.');
            }
            await sessionManager.cancelSession(activeSession.sessionId, userId);
            const message = `✅ Session Cancelled\n\n📱 Number: ${activeSession.number}\n${activeSession.cost > 0 ? '💰 Funds returned to your balance.\n' : ''}You can start a new request now.`;
            await this.sendPhotoWithCaption(ctx, IMAGES.default, message);
        } catch (error) {
            logger.error('Cancel failed', { userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ Failed to cancel session. Please try again.');
        }
    }

    async handleBuyBundle(ctx) {
        const user = ctx.state.user;
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;
        const message = `📦 Buy OTP Bundle\n\n💰 Price: ${formatCurrency(bundlePrice)}\n📦 Includes: ${bundleCount} OTPs\n✅ Never expires\n💡 Best value for regular users\n\nYour Balance: ${formatCurrency(user.balance)}`;
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_bundle')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleFirst, message, keyboard);
    }

    async handleConfirmBundle(ctx) {
        const user = ctx.state.user;
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;
        if (user.balance < bundlePrice) {
            const message = `❌ Insufficient Balance\n\nRequired: ${formatCurrency(bundlePrice)}\nAvailable: ${formatCurrency(user.balance)}\n\nDeposit first with /deposit`;
            return this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message);
        }
        await User.updateOne({ userId: user.userId }, { $inc: { balance: -bundlePrice, bundleRemaining: bundleCount } });
        const message = `✅ Bundle Purchased!\n\n📦 ${bundleCount} OTPs added\n💰 ${formatCurrency(bundlePrice)} deducted\n📦 Total Available: ${user.bundleRemaining + bundleCount} OTPs\n\nUse /otp to start requesting.`;
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message);
    }

    async handleBuyVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        const message = `👑 Upgrade to VIP\n\n💰 Price: ${formatCurrency(vipPrice)}/month\n✅ Unlimited OTPs (50/day)\n⚡ Priority routing\n🚀 Fastest delivery\n\nYour Balance: ${formatCurrency(user.balance)}`;
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Upgrade', 'confirm_vip')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);
        await this.sendPhotoWithCaption(ctx, IMAGES.vipFirst, message, keyboard);
    }

    async handleConfirmVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        if (user.balance < vipPrice) {
            const message = `❌ Insufficient Balance\n\nRequired: ${formatCurrency(vipPrice)}\nAvailable: ${formatCurrency(user.balance)}\n\nDeposit first with /deposit`;
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message);
        }
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + 1);
        await User.updateOne({ userId: user.userId }, {
            $inc: { balance: -vipPrice },
            $set: { mode: 'VIP', vipExpiry: expiryDate, vipDailyUsed: 0, vipDailyReset: new Date() }
        });
        const message = `👑 VIP Activated!\n\n⏰ Valid until: ${expiryDate.toLocaleDateString()}\n✅ Unlimited OTPs (50/day)\n⚡ Priority delivery enabled\n\nEnjoy premium service!`;
        await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message);
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
            const message = `🔓 Full OTP Revealed\n\n📱 Number: ${session.number}\n🔢 OTP: \`${session.otpCode}\`\n🕐 Delivered: ${session.endTime.toLocaleTimeString()}\n\n⚠️ Do not share this code with anyone.`;
            await this.sendPhotoWithCaption(ctx, IMAGES.otpReceived, message, null, 'Markdown');
        } catch (error) {
            await ctx.answerCbQuery('❌ Error revealing OTP');
        }
    }

    async handleCheckDeposit(ctx) {
        const userId = ctx.from.id.toString();
        try {
            const result = await this.walletService.checkDeposit(userId);
            if (!result.found) {
                const message = '⏳ No Deposit Found\n\nYour deposit address hasn\'t received any confirmed deposits yet.\n\nSend USDT (BEP-20) to your address and check again.';
                return this.sendPhotoWithCaption(ctx, IMAGES.default, message);
            }
            if (result.status === 'CONFIRMING') {
                const message = `⏳ Deposit Confirming\n\nAmount: ${formatCurrency(result.amount)}\nConfirmations: ${result.confirmations || 0}/${config.blockchain?.blockConfirmations || 12}\n\nPlease wait for full confirmation.`;
                return this.sendPhotoWithCaption(ctx, IMAGES.default, message);
            }
            if (result.status === 'CONFIRMED') {
                const message = `✅ Deposit Confirmed!\n\nAmount: ${formatCurrency(result.amount)}\nTx Hash: \`${result.txHash}\`\n\nYour balance has been updated.`;
                return this.sendPhotoWithCaption(ctx, IMAGES.depositConfirmed, message, null, 'Markdown');
            }
        } catch (error) {
            logger.error('Check deposit failed', { userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ Error checking deposit. Please try again.');
        }
    }

    async handleDepositInfo(ctx) {
        const message = '💳 Deposit Information\n\nSend USDT (BEP-20) to your deposit address.\n\nYour deposit will be credited automatically after confirmation.\n\nUse /check_deposit to check status.';
        await this.sendPhotoWithCaption(ctx, IMAGES.default, message);
    }

    async handleMenu(ctx) {
        await ctx.reply('🏠 Main Menu');
    }
}

export default OTPCommands;
        
