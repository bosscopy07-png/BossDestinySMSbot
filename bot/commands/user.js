import { Markup } from 'telegraf';
import QRCode from 'qrcode';
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
        this.bot.action('check_deposit', this.handleCheckDeposit.bind(this));
        this.bot.action('deposit_qr', this.handleDepositQR.bind(this));
        this.bot.action(/copy_(.+)/, this.handleCopyAddress.bind(this));
    }

    async handleStart(ctx) {
        const userId = ctx.from.id.toString();
        let user = ctx.state.user;

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
                
                // Refresh user data
                user = await User.findOne({ userId });
            }
        }

        // Reset daily counters if new day
        if (isNewDay(user.freeResetDate)) {
            await User.updateOne(
                { userId },
                { $set: { freeUsedToday: 0, freeResetDate: new Date() } }
            );
            user.freeUsedToday = 0;
        }

        const welcomeMessage = `
👋 Welcome to OTP Bot, ${ctx.from.first_name || 'there'}!

Get verification codes instantly for any service.

${user.isVipActive?.() ? '👑 VIP Active\n' : ''}
💰 Balance: ${formatCurrency(user.balance || 0)}
📦 Bundle: ${user.bundleRemaining || 0} OTPs
🆓 Free Today: ${Math.max(0, 3 - (user.freeUsedToday || 0))}/3

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
        const user = ctx.state.user || await User.findOne({ userId: ctx.from.id.toString() });

        const menuText = `
📱 Main Menu

💰 Balance: ${formatCurrency(user.balance || 0)}
📦 Bundle: ${user.bundleRemaining || 0} OTPs
🆓 Free Today: ${Math.max(0, 3 - (user.freeUsedToday || 0))}/3
${user.isVipActive?.() ? `👑 VIP Until: ${user.vipExpiry?.toLocaleDateString()}\n` : ''}

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

        try {
            await ctx.editMessageText(menuText, keyboard);
        } catch {
            await ctx.reply(menuText, keyboard);
        }
    }

    async handleBalance(ctx) {
        const userId = ctx.from.id.toString();
        const user = ctx.state.user || await User.findOne({ userId });

        // Get pending deposits
        const pendingDeposit = await Transaction.findOne({
            userId: user.userId,
            type: 'DEPOSIT',
            status: { $in: ['PENDING', 'CONFIRMING'] }
        });

        const message = `
💰 Your Balance

Available: ${formatCurrency((user.balance || 0) - (user.lockedBalance || 0))}
Locked: ${formatCurrency(user.lockedBalance || 0)}
Total Deposited: ${formatCurrency(user.totalDeposited || 0)}
Total Spent: ${formatCurrency(user.totalSpent || 0)}

📦 Bundle OTPs: ${user.bundleRemaining || 0}
${user.isVipActive?.() ? `👑 VIP Until: ${user.vipExpiry?.toLocaleDateString()}` : '👑 VIP: Inactive'}

${pendingDeposit ? `⏳ Pending Deposit: ${formatCurrency(pendingDeposit.amount)}` : ''}

💳 Deposit to:
\`${this.walletService.getMasterAddress()}\`
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
            // Generate deposit info with tracking amount
            const depositInfo = await this.walletService.getDepositInfo(userId);

            const message = `
💳 Deposit Funds

Send **exactly** this amount of USDT (BEP-20):

Amount: \`$${depositInfo.amount}\`
Address: \`${depositInfo.address}\`
Network: ${depositInfo.network}

⚠️ IMPORTANT:
• Send ONLY USDT on BSC (BEP-20)
• Send EXACTLY $${depositInfo.amount} — this identifies your deposit
• Minimum: $0.50
• Requires ${config.blockchain?.blockConfirmations || 12} confirmations

⏱ Funds credited automatically in 1-2 minutes.
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📱 Show QR Code', 'deposit_qr')],
                [Markup.button.callback('🔄 Check Deposit', 'check_deposit')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);

            await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });

        } catch (error) {
            logger.error('Deposit handler error', { userId, error: error.message });
            await ctx.reply('❌ Error generating deposit. Please try again later.');
        }
    }

    async handleDepositQR(ctx) {
        const userId = ctx.from.id.toString();

        try {
            const user = await User.findOne({ userId });
            if (!user || !user.depositTrackingAmount) {
                return ctx.answerCbQuery('Please click Deposit first');
            }

            const masterAddress = this.walletService.getMasterAddress();
            
            // Generate QR code with payment URI
            const paymentUri = `ethereum:${masterAddress}?amount=${user.depositTrackingAmount}&token=USDT`;
            const qrBuffer = await QRCode.toBuffer(paymentUri);

            await ctx.answerCbQuery('Generating QR...');
            
            await ctx.replyWithPhoto(
                { source: qrBuffer },
                {
                    caption: `📱 Scan to deposit $${user.depositTrackingAmount} USDT\n\nAddress: \`${masterAddress}\``,
                    parse_mode: 'Markdown'
                }
            );

        } catch (error) {
            logger.error('QR generation failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Failed to generate QR');
        }
    }

    async handleCheckDeposit(ctx) {
        const userId = ctx.from.id.toString();

        try {
            await ctx.answerCbQuery('Checking deposits...');

            const result = await this.walletService.checkDeposit(userId);

            if (result.found) {
                await ctx.reply(`
✅ Deposit Found!

Amount: ${formatCurrency(result.amount)}
Status: ${result.status}
TX: \`${result.txHash}\`

Your balance has been updated.
                `, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(`
⏳ No deposit found yet.

Make sure you:
1. Sent to: \`${this.walletService.getMasterAddress()}\`
2. Sent exactly the shown amount
3. Used BSC (BEP-20) network

Click 🔄 Check Deposit again in 1 minute.
                `, { parse_mode: 'Markdown' });
            }

        } catch (error) {
            logger.error('Check deposit failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Check failed');
            await ctx.reply('❌ Error checking deposit. Please try again.');
        }
    }

    async handleCopyAddress(ctx) {
        // Telegram handles copy automatically when user taps the code block
        // This just acknowledges the callback
        await ctx.answerCbQuery('Address copied! Paste it in your wallet.');
    }

    async handleHistory(ctx) {
        const userId = ctx.from.id.toString();

        const transactions = await Transaction.find({ userId })
            .sort({ createdAt: -1 })
            .limit(10);

        let message = '📜 Recent Transactions\n\n';

        if (transactions.length === 0) {
            message += 'No transactions yet. Deposit to get started!';
        } else {
            transactions.forEach((tx, index) => {
                const icon = tx.amount > 0 ? '➕' : '➖';
                const type = tx.type?.replace(/_/g, ' ') || 'Unknown';
                message += `${index + 1}. ${icon} ${type}\n`;
                message += `   Amount: ${formatCurrency(Math.abs(tx.amount || 0))}\n`;
                message += `   Status: ${tx.status}\n`;
                message += `   Date: ${tx.createdAt?.toLocaleDateString() || 'Unknown'}\n\n`;
            });
        }

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📥 Export CSV', 'export_history')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await ctx.reply(message, keyboard);
    }

    async handleReferral(ctx) {
        const user = ctx.state.user || await User.findOne({ userId: ctx.from.id.toString() });
        const botUsername = ctx.botInfo?.username || 'your_bot';

        const referralLink = `https://t.me/${botUsername}?start=${user.referralCode}`;

        const message = `
🎁 Referral Program

Your Code: \`${user.referralCode}\`

Share your link and earn ${((config.referral?.percentage || 0.05) * 100).toFixed(0)}% of your referrals' deposits!

📊 Your Stats:
• Referrals: ${user.referralCount || 0}
• Total Earnings: ${formatCurrency(user.referralEarnings || 0)}
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

        const completedSessions = sessions.filter(s => s.endTime && s.startTime);
        const avgWaitTime = completedSessions.length > 0
            ? completedSessions.reduce((acc, s) => acc + (s.endTime - s.startTime), 0) / completedSessions.length
            : 0;

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
• Total Deposited: ${formatCurrency(ctx.state.user?.totalDeposited || 0)}
• Total Spent: ${formatCurrency(ctx.state.user?.totalSpent || 0)}
• Current Balance: ${formatCurrency(ctx.state.user?.balance || 0)}

📅 Member Since: ${ctx.state.user?.createdAt?.toLocaleDateString() || 'Unknown'}
        `;

        await ctx.reply(message, Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'menu')]
        ]));
    }

    async handleSettings(ctx) {
        const user = ctx.state.user || await User.findOne({ userId: ctx.from.id.toString() });

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
                                                           
