 import { Markup } from 'telegraf';
import { Session, User } from '../../models/index.js';
import { COUNTRIES, SERVICES } from '../../utils/constants.js';
import { formatCurrency, maskOTP } from '../../utils/helpers.js';
import sessionManager from '../../services/otp/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class OTPCommands {
    constructor(bot) {
        this.bot = bot;
        this.registerCommands();
    }

    registerCommands() {
        this.bot.command('otp', this.handleOTPCommand.bind(this));
        this.bot.command('cancel', this.handleCancel.bind(this));
        
        // Mode selection callbacks
        this.bot.action('mode_free', this.handleFreeMode.bind(this));
        this.bot.action('mode_cheap', this.handleCheapMode.bind(this));
        this.bot.action('mode_vip', this.handleVIPMode.bind(this));
        
        // Service selection
        this.bot.action(/service_(.+)/, this.handleServiceSelect.bind(this));
        
        // Country selection
        this.bot.action(/country_(.+)/, this.handleCountrySelect.bind(this));
        
        // Bundle & VIP purchase
        this.bot.action('buy_bundle', this.handleBuyBundle.bind(this));
        this.bot.action('buy_vip', this.handleBuyVIP.bind(this));
        this.bot.action('confirm_bundle', this.handleConfirmBundle.bind(this));
        this.bot.action('confirm_vip', this.handleConfirmVIP.bind(this));
        
        // OTP reveal
        this.bot.action(/reveal_(.+)/, this.handleRevealOTP.bind(this));
        
        // Check deposit
        this.bot.action('check_deposit', this.handleCheckDeposit.bind(this));
    }

    async handleOTPCommand(ctx) {
        const user = ctx.state.user;

        const message = `
📱 Request OTP

Select your preferred mode:
        `;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('🆓 FREE', 'mode_free'),
                Markup.button.callback('💰 CHEAP ($0.05)', 'mode_cheap')
            ],
            [
                Markup.button.callback('📦 Use Bundle', 'mode_bundle'),
                Markup.button.callback('👑 VIP', 'mode_vip')
            ],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await ctx.reply(message, keyboard);
    }

    async handleFreeMode(ctx) {
        const user = ctx.state.user;

        if (!user.canUseFree()) {
            return ctx.reply(`
❌ Free Limit Reached

You've used all 3 free OTPs today.

💰 Deposit to continue:
• CHEAP: $0.05 per OTP
• Bundle: $5 for 100 OTPs
            `, Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]));
        }

        await this.showServiceSelection(ctx, 'FREE');
    }

    async handleCheapMode(ctx) {
        const user = ctx.state.user;

        if (user.getAvailableBalance() < config.pricing.cheapOtp) {
            return ctx.reply(`
💰 Insufficient Balance

Required: ${formatCurrency(config.pricing.cheapOtp)}
Available: ${formatCurrency(user.getAvailableBalance())}

Please deposit first.
            `, Markup.inlineKeyboard([
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]));
        }

        await this.showServiceSelection(ctx, 'CHEAP');
    }

    async handleVIPMode(ctx) {
        const user = ctx.state.user;

        if (!user.isVipActive()) {
            return ctx.reply(`
👑 VIP Required

You need an active VIP subscription.

Price: ${formatCurrency(config.pricing.vipMonthly)}/month
Includes: Unlimited OTPs (50/day max)

Upgrade now?
            `, Markup.inlineKeyboard([
                [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]));
        }

        if (!user.canUseVip()) {
            return ctx.reply(`
⚠️ VIP Daily Limit Reached

You've used 50/50 VIP OTPs today.
Resets at midnight UTC.
            `);
        }

        await this.showServiceSelection(ctx, 'VIP');
    }

    async showServiceSelection(ctx, mode) {
        ctx.session = ctx.session || {};
        ctx.session.otpMode = mode;

        const message = `
📱 ${mode} Mode Selected

Choose the service you need OTP for:
        `;

        // Create service buttons grid (3 per row)
        const buttons = [];
        for (let i = 0; i < SERVICES.length; i += 3) {
            const row = SERVICES.slice(i, i + 3).map(service => 
                Markup.button.callback(service, `service_${service}`)
            );
            buttons.push(row);
        }
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

        await ctx.reply(message, Markup.inlineKeyboard(buttons));
    }

    async handleServiceSelect(ctx) {
        const service = ctx.match[1];
        ctx.session = ctx.session || {};
        ctx.session.otpService = service;

        const message = `
🌍 Select Country

Choose number country:
        `;

        const buttons = COUNTRIES.map(c => [
            Markup.button.callback(
                `${c.flag} ${c.name} ${c.priceModifier > 0 ? `(+$${c.priceModifier})` : ''}`,
                `country_${c.code}`
            )
        ]);
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

        await ctx.reply(message, Markup.inlineKeyboard(buttons));
    }

    async handleCountrySelect(ctx) {
        const country = ctx.match[1];
        const userId = ctx.from.id.toString();
        const mode = ctx.session?.otpMode;
        const service = ctx.session?.otpService;

        if (!mode || !service) {
            return ctx.reply('❌ Session expired. Please start over with /otp');
        }

        try {
            // Show loading
            const loadingMsg = await ctx.reply('⏳ Assigning number...');

            // Create session
            const session = await sessionManager.createSession(
                userId,
                mode,
                service,
                country
            );

            // Delete loading message
            await ctx.deleteMessage(loadingMsg.message_id);

            // Show number and status
            const costText = mode === 'FREE' ? 'FREE' : formatCurrency(session.cost);
            
            const message = `
📱 OTP Request Started

🌍 Mode: ${mode}
📱 Number: \`${session.number}\`
🎯 Service: ${service}
⏳ Status: Waiting for OTP...
💰 Cost: ${costText}
⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s

⚠️ ${mode === 'FREE' ? 'Shared number. OTP not guaranteed.' : 'Funds locked. Will be deducted on delivery.'}
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', 'cancel_otp')]
            ]);

            await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });

        } catch (error) {
            logger.error('OTP session creation failed', {
                userId,
                mode,
                service,
                error: error.message
            });

            const errorMessages = {
                ACTIVE_SESSION_EXISTS: '⏳ You already have an active session. Use /cancel first.',
                INSUFFICIENT_BALANCE: '💰 Insufficient balance. Deposit first with /deposit',
                FREE_LIMIT_REACHED: '🆓 Free limit reached for today.',
                USER_BLACKLISTED: '🚫 Your account is suspended.',
                VIP_EXPIRED: '👑 VIP expired. Renew your subscription.',
                VIP_DAILY_LIMIT_REACHED: '⚠️ VIP daily limit (50) reached.'
            };

            await ctx.reply(errorMessages[error.message] || `❌ Error: ${error.message}`);
        }
    }

    async handleCancel(ctx) {
        const userId = ctx.from.id.toString();

        try {
            const activeSession = await Session.findOne({
                userId,
                status: { $in: ['WAITING', 'CHECKING'] }
            });

            if (!activeSession) {
                return ctx.reply('❌ No active session to cancel.');
            }

            await sessionManager.cancelSession(activeSession.sessionId, userId);

            await ctx.reply(`
✅ Session Cancelled

📱 Number: ${activeSession.number}
💰 ${activeSession.cost > 0 ? 'Funds returned to your balance.' : ''}

You can start a new request now.
            `);

        } catch (error) {
            logger.error('Cancel failed', { userId, error: error.message });
            await ctx.reply('❌ Failed to cancel session. Please try again.');
        }
    }

    async handleBuyBundle(ctx) {
        const user = ctx.state.user;

        const message = `
📦 Buy OTP Bundle

💰 Price: ${formatCurrency(config.pricing.bundlePrice)}
📦 Includes: ${config.pricing.bundleOtpCount} OTPs
✅ Never expires
💡 Best value for regular users

Your Balance: ${formatCurrency(user.balance)}
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_bundle')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);

        await ctx.reply(message, keyboard);
    }

    async handleConfirmBundle(ctx) {
        const user = ctx.state.user;

        if (user.balance < config.pricing.bundlePrice) {
            return ctx.reply(`
❌ Insufficient Balance

Required: ${formatCurrency(config.pricing.bundlePrice)}
Available: ${formatCurrency(user.balance)}

Deposit first with /deposit
            `);
        }

        // Deduct balance
        await User.updateOne(
            { userId: user.userId },
            {
                $inc: {
                    balance: -config.pricing.bundlePrice,
                    bundleRemaining: config.pricing.bundleOtpCount
                }
            }
        );

        await ctx.reply(`
✅ Bundle Purchased!

📦 ${config.pricing.bundleOtpCount} OTPs added
💰 ${formatCurrency(config.pricing.bundlePrice)} deducted
📦 Total Available: ${user.bundleRemaining + config.pricing.bundleOtpCount} OTPs

Use /otp to start requesting.
        `);
    }

    async handleBuyVIP(ctx) {
        const user = ctx.state.user;

        const message = `
👑 Upgrade to VIP

💰 Price: ${formatCurrency(config.pricing.vipMonthly)}/month
✅ Unlimited OTPs (50/day)
⚡ Priority routing
🚀 Fastest delivery

Your Balance: ${formatCurrency(user.balance)}
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Upgrade', 'confirm_vip')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);

        await ctx.reply(message, keyboard);
    }

    async handleConfirmVIP(ctx) {
        const user = ctx.state.user;

        if (user.balance < config.pricing.vipMonthly) {
            return ctx.reply(`
❌ Insufficient Balance

Required: ${formatCurrency(config.pricing.vipMonthly)}
Available: ${formatCurrency(user.balance)}

Deposit first with /deposit
            `);
        }

        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + 1);

        // Deduct balance and activate VIP
        await User.updateOne(
            { userId: user.userId },
            {
                $inc: { balance: -config.pricing.vipMonthly },
                $set: {
                    mode: 'VIP',
                    vipExpiry: expiryDate,
                    vipDailyUsed: 0,
                    vipDailyReset: new Date()
                }
            }
        );

        await ctx.reply(`
👑 VIP Activated!

⏰ Valid until: ${expiryDate.toLocaleDateString()}
✅ Unlimited OTPs (50/day)
⚡ Priority delivery enabled

Enjoy premium service!
        `);
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
            await ctx.reply(`
🔓 Full OTP Revealed

📱 Number: ${session.number}
🔢 OTP: \`${session.otpCode}\`
🕐 Delivered: ${session.endTime.toLocaleTimeString()}

⚠️ Do not share this code with anyone.
            `, { parse_mode: 'Markdown' });

        } catch (error) {
            await ctx.answerCbQuery('❌ Error revealing OTP');
        }
    }

    async handleCheckDeposit(ctx) {
        const userId = ctx.from.id.toString();

        try {
            const result = await this.walletService.checkDeposit(userId);

            if (!result.found) {
                return ctx.reply(`
⏳ No Deposit Found

Your deposit address hasn't received any confirmed deposits yet.

Send USDT (BEP-20) to your address and check again.
                `);
            }

            if (result.status === 'CONFIRMING') {
                return ctx.reply(`
⏳ Deposit Confirming

Amount: ${formatCurrency(result.amount)}
Confirmations: ${result.confirmations || 0}/${config.blockchain.blockConfirmations}

Please wait for full confirmation.
                `);
            }

            if (result.status === 'CONFIRMED') {
                return ctx.reply(`
✅ Deposit Confirmed!

Amount: ${formatCurrency(result.amount)}
Tx Hash: \`${result.txHash}\`

Your balance has been updated.
                `, { parse_mode: 'Markdown' });
            }

        } catch (error) {
            logger.error('Check deposit failed', { userId, error: error.message });
            await ctx.reply('❌ Error checking deposit. Please try again.');
        }
    }
}

export default OTPCommands;
