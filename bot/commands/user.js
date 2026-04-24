import { Markup } from 'telegraf';
import { User, Session, Transaction } from '../../models/index.js';
import { formatCurrency, generateReferralCode, isNewDay } from '../../utils/helpers.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

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
        
        // Callback handlers
        this.bot.action('menu', this.handleMenu.bind(this));
        this.bot.action('deposit', this.handleDeposit.bind(this));
        this.bot.action('balance', this.handleBalance.bind(this));
        this.bot.action('history', this.handleHistory.bind(this));
        this.bot.action('referral', this.handleReferral.bind(this));
        this.bot.action('stats', this.handleStats.bind(this));
        this.bot.action('settings', this.handleSettings.bind(this));
    }

    async handleStart(ctx) {
        const userId = ctx.from.id.toString();
        const user = ctx.state.user;

        // Handle referral
        const startPayload = ctx.startPayload;
        if (startPayload && !user.referredBy) {
            const referrer = await User.findOne({ referralCode: startPayload.toUpperCase() });
            if (referrer && referrer.userId !== userId) {
                await User.updateOne(
                    { userId },
                    { $set: { referredBy: startPayload.toUpperCase() } }
                );
                
                await ctx.reply(`
🎁 You were referred by ${referrer.username || 'a friend'}!

You'll get a bonus on your first deposit.
                `);
            }
        }

        // Reset daily counters if new day
        if (isNewDay(user.freeResetDate)) {
            await User.updateOne(
                { userId },
                { $set: { freeUsedToday: 0, freeResetDate: new Date() } }
            );
        }

        const welcomeMessage = `
👋 Welcome to OTP Bot, ${ctx.from.first_name || 'there'}!

Get verification codes instantly for any service.

${user.isVipActive() ? '👑 VIP Active\n' : ''}
💰 Balance: ${formatCurrency(user.balance)}
📦 Bundle: ${user.bundleRemaining} OTPs
🆓 Free Today: ${3 - (user.freeUsedToday || 0)}/3

Choose your mode or deposit to get started:
        `;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('🆓 FREE OTP', 'mode_free'),
                Markup.button.callback('💰 CHEAP OTP', 'mode_cheap')
            ],
            [
                Markup.button.callback('📦 Buy Bundle', 'buy_bundle'),
                Markup.button.callback('👑 Upgrade VIP', 'buy_vip')
            ],
            [
                Markup.button.callback('💳 Deposit', 'deposit'),
                Markup.button.callback('📊 My Stats', 'stats')
            ],
            [
                Markup.button.callback('🎁 Referral', 'referral'),
                Markup.button.callback('⚙️ Settings', 'settings')
            ]
        ]);

        await ctx.reply(welcomeMessage, keyboard);
    }

    async handleMenu(ctx) {
        const user = ctx.state.user;

        const menuText = `
📱 Main Menu

💰 Balance: ${formatCurrency(user.balance)}
📦 Bundle: ${user.bundleRemaining} OTPs
🆓 Free Today: ${3 - (user.freeUsedToday || 0)}/3
${user.isVipActive() ? `👑 VIP Until: ${user.vipExpiry.toLocaleDateString()}\n` : ''}

What would you like to do?
        `;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('📱 Request OTP', 'request_otp'),
                Markup.button.callback('💳 Deposit', 'deposit')
            ],
            [
                Markup.button.callback('📜 History', 'history'),
                Markup.button.callback('📊 Stats', 'stats')
            ],
            [
                Markup.button.callback('🎁 Referral', 'referral'),
                Markup.button.callback('⚙️ Settings', 'settings')
            ],
            [Markup.button.callback('❓ Help', 'help')]
        ]);

        await ctx.editMessageText(menuText, keyboard).catch(() => {
            ctx.reply(menuText, keyboard);
        });
    }

    async handleBalance(ctx) {
        const user = ctx.state.user;

        // Get pending deposits
        const pendingDeposit = await Transaction.findOne({
            userId: user.userId,
            type: { $in: ['DEPOSIT', 'DEPOSIT_CONFIRMING'] },
            status: { $in: ['PENDING', 'CONFIRMING'] }
        });

        const message = `
💰 Your Balance

Available: ${formatCurrency(user.getAvailableBalance())}
Locked: ${formatCurrency(user.lockedBalance)}
Total Deposited: ${formatCurrency(user.totalDeposited)}
Total Spent: ${formatCurrency(user.totalSpent)}

📦 Bundle OTPs: ${user.bundleRemaining}
${user.isVipActive() ? `👑 VIP Until: ${user.vipExpiry.toLocaleDateString()}` : '👑 VIP: Inactive'}

${pendingDeposit ? `⏳ Pending Deposit: ${formatCurrency(pendingDeposit.amount)}` : ''}

💳 Deposit Address:
\`${user.depositAddress || 'Generate one with /deposit'}\`
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💳 Deposit', 'deposit')],
            [Markup.button.callback('📜 Transaction History', 'history')],
            [Markup.button.callback('🔙 Back to Menu', 'menu')]
        ]);

        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }

    async handleDeposit(ctx) {
        const userId = ctx.from.id.toString();

        try {
            // Generate or get deposit address
            const address = await this.walletService.getDepositAddress(userId);

            const message = `
💳 Deposit Funds

Send USDT (BEP-20) to your unique address:

\`${address}\`

⚠️ Important:
• Only send USDT on BSC (BEP-20)
• Minimum deposit: $0.50
• Requires ${config.blockchain.blockConfirmations} confirmations
• Funds are non-refundable

Your deposit will be credited automatically once confirmed.
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📋 Copy Address', `copy_${address}`)],
                [Markup.button.callback('🔄 Check Deposit', 'check_deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);

            await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });

        } catch (error) {
            logger.error('Deposit handler error', { userId, error: error.message });
            await ctx.reply('❌ Error generating deposit address. Please try again.');
        }
    }

    async handleHistory(ctx) {
        const userId = ctx.from.id.toString();

        const transactions = await Transaction.find({ userId })
            .sort({ createdAt: -1 })
            .limit(10);

        let message = '📜 Recent Transactions\n\n';

        if (transactions.length === 0) {
            message += 'No transactions yet.';
        } else {
            transactions.forEach((tx, index) => {
                const icon = tx.amount > 0 ? '➕' : '➖';
                const type = tx.type.replace(/_/g, ' ');
                message += `${index + 1}. ${icon} ${type}\n`;
                message += `   Amount: ${formatCurrency(Math.abs(tx.amount))}\n`;
                message += `   Status: ${tx.status}\n`;
                message += `   Date: ${tx.createdAt.toLocaleDateString()}\n\n`;
            });
        }

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📥 Export CSV', 'export_history')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await ctx.reply(message, keyboard);
    }

    async handleReferral(ctx) {
        const user = ctx.state.user;
        const botUsername = ctx.botInfo.username;

        const referralLink = `https://t.me/${botUsername}?start=${user.referralCode}`;

        const message = `
🎁 Referral Program

Your Code: \`${user.referralCode}\`

Share your link and earn ${(config.referral.percentage * 100).toFixed(0)}% of your referrals' deposits!

📊 Your Stats:
• Referrals: ${user.referralCount}
• Total Earnings: ${formatCurrency(user.referralEarnings)}
• Pending Approval: ${formatCurrency(user.referralRewardsPending || 0)}

🔗 Your Link:
\`${referralLink}\`
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📤 Share Link', `share_${referralLink}`)],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }

    async handleStats(ctx) {
        const userId = ctx.from.id.toString();

        const sessions = await Session.find({ userId });
        
        const totalRequests = sessions.length;
        const successful = sessions.filter(s => s.status === 'RECEIVED').length;
        const failed = sessions.filter(s => s.status === 'TIMEOUT').length;
        const successRate = totalRequests > 0 
            ? ((successful / totalRequests) * 100).toFixed(1) 
            : 0;

        const avgWaitTime = sessions
            .filter(s => s.endTime && s.startTime)
            .reduce((acc, s) => acc + (s.endTime - s.startTime), 0) / (successful || 1);

        const message = `
📊 Your Statistics

📈 OTP Requests:
• Total: ${totalRequests}
• Successful: ${successful}
• Failed: ${failed}
• Success Rate: ${successRate}%

⏱ Performance:
• Avg Wait Time: ${(avgWaitTime / 1000).toFixed(1)}s

💰 Financial:
• Total Deposited: ${formatCurrency(ctx.state.user.totalDeposited)}
• Total Spent: ${formatCurrency(ctx.state.user.totalSpent)}
• Current Balance: ${formatCurrency(ctx.state.user.balance)}

📅 Member Since: ${ctx.state.user.createdAt.toLocaleDateString()}
        `;

        await ctx.reply(message, Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'menu')]
        ]));
    }

    async handleSettings(ctx) {
        const user = ctx.state.user;

        const message = `
⚙️ Settings

🔐 Privacy: ${user.privacyEnabled ? '✅ Masked OTPs' : '❌ Full OTPs'}
🔔 Notifications: ${user.notificationsEnabled ? '✅ On' : '❌ Off'}
🌍 Country: ${user.preferredCountry || 'US'}

Toggle settings below:
        `;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    user.privacyEnabled ? '👁 Show Full OTPs' : '🔒 Mask OTPs',
                    'toggle_privacy'
                )
            ],
            [
                Markup.button.callback(
                    user.notificationsEnabled ? '🔕 Disable Notifications' : '🔔 Enable Notifications',
                    'toggle_notifications'
                )
            ],
            [
                Markup.button.callback('🌍 Change Country', 'change_country')
            ],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await ctx.reply(message, keyboard);
    }
}

export default UserCommands;

 
