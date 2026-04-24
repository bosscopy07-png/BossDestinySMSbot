import { Markup } from 'telegraf';
import { User, Session, Transaction, AdminLog } from '../../models/index.js';
import { generateId, formatCurrency } from '../../utils/helpers.js';
import walletService from '../../services/wallet/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class AdminCommands {
    constructor(bot) {
        this.bot = bot;
        this.registerCommands();
    }

    registerCommands() {
        this.bot.command('admin', this.requireAdmin, this.handleAdmin.bind(this));
        this.bot.command('users', this.requireAdmin, this.handleUsers.bind(this));
        this.bot.command('user', this.requireAdmin, this.handleUserDetail.bind(this));
        this.bot.command('profits', this.requireAdmin, this.handleProfits.bind(this));
        this.bot.command('addbalance', this.requireAdmin, this.handleAddBalance.bind(this));
        this.bot.command('deductbalance', this.requireAdmin, this.handleDeductBalance.bind(this));
        this.bot.command('blacklist', this.requireAdmin, this.handleBlacklist.bind(this));
        this.bot.command('whitelist', this.requireAdmin, this.handleWhitelist.bind(this));
        this.bot.command('broadcast', this.requireAdmin, this.handleBroadcast.bind(this));
        this.bot.command('system', this.requireAdmin, this.handleSystem.bind(this));
        this.bot.command('logs', this.requireAdmin, this.handleLogs.bind(this));
        this.bot.command('approve_referral', this.requireAdmin, this.handleApproveReferral.bind(this));
        this.bot.command('master_balance', this.requireAdmin, this.handleMasterBalance.bind(this));
        this.bot.command('withdraw_profits', this.requireAdmin, this.handleWithdrawProfits.bind(this));

        // Callback handlers
        this.bot.action('admin_users', this.requireAdmin, this.handleUsers.bind(this));
        this.bot.action('admin_profits', this.requireAdmin, this.handleProfits.bind(this));
        this.bot.action('admin_system', this.requireAdmin, this.handleSystem.bind(this));
        this.bot.action('admin_logs', this.requireAdmin, this.handleLogs.bind(this));
        this.bot.action('admin_broadcast', this.requireAdmin, this.handleBroadcastMenu.bind(this));
        this.bot.action('admin_settings', this.requireAdmin, this.handleSettings.bind(this));
    }

    get requireAdmin() {
        return async (ctx, next) => {
            const adminIds = config.bot.adminId.split(',');
            if (!adminIds.includes(ctx.from.id.toString())) {
                return ctx.reply('🚫 Admin access required.');
            }
            ctx.state.isAdmin = true;
            return next();
        };
    }

    async logAdminAction(adminId, action, targetUserId = null, details = {}) {
        await AdminLog.create({
            logId: generateId(),
            type: 'ADMIN_ACTION',
            adminId,
            targetUserId,
            action,
            details,
            timestamp: new Date(),
            ipAddress: ctx?.ip || 'unknown'
        });
    }

    async handleAdmin(ctx) {
        const stats = await this.getSystemStats();

        const message = `
🔐 Admin Dashboard

📊 Revenue (24h): ${formatCurrency(stats.revenue24h)}
📊 Revenue (7d): ${formatCurrency(stats.revenue7d)}
📊 Revenue (30d): ${formatCurrency(stats.revenue30d)}

👥 Users: ${stats.totalUsers}
💳 Paying: ${stats.payingUsers}
👑 VIP: ${stats.vipUsers}
🆓 Active Today: ${stats.activeToday}

📈 OTP Stats (24h):
• Requests: ${stats.otpRequests24h}
• Success: ${stats.otpSuccess24h} (${stats.successRate24h}%)
• Failed: ${stats.otpFailed24h}

⚡ System:
• Master Balance: ${formatCurrency(stats.masterBalance)}
• Uptime: ${stats.uptime}
        `;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('👥 Users', 'admin_users'),
                Markup.button.callback('💰 Profits', 'admin_profits')
            ],
            [
                Markup.button.callback('⚙️ System', 'admin_system'),
                Markup.button.callback('📋 Logs', 'admin_logs')
            ],
            [
                Markup.button.callback('📢 Broadcast', 'admin_broadcast'),
                Markup.button.callback('🔧 Settings', 'admin_settings')
            ]
        ]);

        await ctx.reply(message, keyboard);
    }

    async handleUsers(ctx) {
        const page = ctx.match ? parseInt(ctx.match[1]) || 1 : 1;
        const perPage = 10;

        const users = await User.find()
            .sort({ lastActive: -1 })
            .skip((page - 1) * perPage)
            .limit(perPage);

        let message = `👥 Users (Page ${page})\n\n`;

        for (const user of users) {
            const status = user.isBlacklisted ? '🔴' :
                          user.isVipActive() ? '👑' :
                          user.balance > 0 ? '💰' : '🆓';

            message += `
${status} ${user.username || user.firstName || 'Unknown'}
ID: \`${user.userId}\`
Balance: ${formatCurrency(user.balance)}
Mode: ${user.mode}
Last Active: ${user.lastActive?.toLocaleDateString() || 'Never'}
            `;
        }

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('⬅️ Prev', `admin_users_${page - 1}`),
                Markup.button.callback('➡️ Next', `admin_users_${page + 1}`)
            ],
            [Markup.button.callback('🔙 Back to Admin', 'admin')]
        ]);

        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }

    async handleUserDetail(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return ctx.reply('Usage: /user <user_id>');
        }

        const targetId = args[1];
        const user = await User.findOne({ userId: targetId });

        if (!user) {
            return ctx.reply('❌ User not found.');
        }

        const sessions = await Session.find({ userId: targetId })
            .sort({ startTime: -1 })
            .limit(5);

        const transactions = await Transaction.find({ userId: targetId })
            .sort({ createdAt: -1 })
            .limit(5);

        const message = `
👤 User Details

🆔 ID: \`${user.userId}\`
👤 Name: ${user.firstName || ''} ${user.lastName || ''}
📱 Username: @${user.username || 'N/A'}
💰 Balance: ${formatCurrency(user.balance)}
📦 Bundle: ${user.bundleRemaining} OTPs
👑 VIP: ${user.isVipActive() ? `Until ${user.vipExpiry.toLocaleDateString()}` : 'Inactive'}
🆓 Free Used Today: ${user.freeUsedToday}/3
📊 Mode: ${user.mode}

🚫 Status: ${user.isBlacklisted ? `BLACKLISTED (${user.blacklistReason})` : 'Active'}
📅 Joined: ${user.createdAt.toLocaleDateString()}

Recent Sessions: ${sessions.length}
Recent Transactions: ${transactions.length}
        `;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('➕ Add Balance', `addbal_${targetId}`),
                Markup.button.callback('➖ Deduct Balance', `dedbal_${targetId}`)
            ],
            [
                Markup.button.callback('🔴 Blacklist', `bl_${targetId}`),
                Markup.button.callback('🟢 Whitelist', `wl_${targetId}`)
            ],
            [Markup.button.callback('🔙 Back', 'admin_users')]
        ]);

        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }

    async handleProfits(ctx) {
        const now = new Date();
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        const [dayRevenue, weekRevenue, monthRevenue] = await Promise.all([
            this.calculateRevenue(dayAgo),
            this.calculateRevenue(weekAgo),
            this.calculateRevenue(monthAgo)
        ]);

        const masterBalance = await walletService.getMasterBalance();

        const message = `
💰 Profit Analytics

📅 Revenue:
• 24h: ${formatCurrency(dayRevenue)}
• 7d: ${formatCurrency(weekRevenue)}
• 30d: ${formatCurrency(monthRevenue)}

💎 Master Wallet:
• USDT: ${masterBalance.usdt}
• BNB: ${masterBalance.bnb}

📊 By Mode (30d):
${await this.getRevenueByMode(monthAgo)}

📊 By Service (30d):
${await this.getRevenueByService(monthAgo)}
        `;

        await ctx.reply(message, Markup.inlineKeyboard([
            [Markup.button.callback('📥 Export CSV', 'export_profits')],
            [Markup.button.callback('💸 Withdraw', 'withdraw_profits')],
            [Markup.button.callback('🔙 Back', 'admin')]
        ]));
    }

    async handleAddBalance(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return ctx.reply('Usage: /addbalance <user_id> <amount> [reason]');
        }

        const targetId = args[1];
        const amount = parseFloat(args[2]);
        const reason = args.slice(3).join(' ') || 'Admin credit';

        if (isNaN(amount) || amount <= 0) {
            return ctx.reply('❌ Invalid amount.');
        }

        try {
            await walletService.addBalance(targetId, amount, ctx.from.id.toString(), reason);
            
            await this.logAdminAction(
                ctx.from.id.toString(),
                'ADD_BALANCE',
                targetId,
                { amount, reason }
            );

            await ctx.reply(`✅ Added ${formatCurrency(amount)} to user ${targetId}`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
🎁 Balance Added!

Amount: +${formatCurrency(amount)}
Reason: ${reason}

Your new balance has been updated.
            `);

        } catch (error) {
            await ctx.reply(`❌ Error: ${error.message}`);
        }
    }

    async handleDeductBalance(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return ctx.reply('Usage: /deductbalance <user_id> <amount> [reason]');
        }

        const targetId = args[1];
        const amount = parseFloat(args[2]);
        const reason = args.slice(3).join(' ') || 'Admin deduction';

        if (isNaN(amount) || amount <= 0) {
            return ctx.reply('❌ Invalid amount.');
        }

        try {
            await walletService.deductBalance(targetId, amount, ctx.from.id.toString(), reason);
            
            await this.logAdminAction(
                ctx.from.id.toString(),
                'DEDUCT_BALANCE',
                targetId,
                { amount, reason }
            );

            await ctx.reply(`✅ Deducted ${formatCurrency(amount)} from user ${targetId}`);

        } catch (error) {
            await ctx.reply(`❌ Error: ${error.message}`);
        }
    }

    async handleBlacklist(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return ctx.reply('Usage: /blacklist <user_id> [reason]');
        }

        const targetId = args[1];
        const reason = args.slice(2).join(' ') || 'Manual blacklist';

        await User.updateOne(
            { userId: targetId },
            {
                $set: {
                    isBlacklisted: true,
                    blacklistReason: reason,
                    blacklistDate: new Date()
                }
            }
        );

        // Cancel active sessions
        await Session.updateMany(
            { userId: targetId, status: { $in: ['WAITING', 'CHECKING'] } },
            { $set: { status: 'CANCELLED' } }
        );

        await this.logAdminAction(
            ctx.from.id.toString(),
            'BLACKLIST',
            targetId,
            { reason }
        );

        await ctx.reply(`🚫 User ${targetId} blacklisted.\nReason: ${reason}`);
    }

    async handleWhitelist(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return ctx.reply('Usage: /whitelist <user_id>');
        }

        const targetId = args[1];

        await User.updateOne(
            { userId: targetId },
            {
                $set: {
                    isBlacklisted: false,
                    blacklistReason: null,
                    blacklistDate: null
                }
            }
        );

        await this.logAdminAction(
            ctx.from.id.toString(),
            'WHITELIST',
            targetId,
            {}
        );

        await ctx.reply(`✅ User ${targetId} whitelisted.`);
    }

    async handleBroadcast(ctx) {
        const args = ctx.message.text.split(' ').slice(1);
        const message = args.join(' ');

        if (!message) {
            return ctx.reply('Usage: /broadcast <message>');
        }

        const users = await User.find({ isBlacklisted: false });
        let sent = 0;
        let failed = 0;

        for (const user of users) {
            try {
                await ctx.telegram.sendMessage(user.userId, `
📢 Announcement

${message}

---
OTP Bot Team
                `);
                sent++;
            } catch (error) {
                failed++;
            }
        }

        await ctx.reply(`📢 Broadcast complete.\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
    }

    async handleSystem(ctx) {
        const masterBalance = await walletService.getMasterBalance();

        const message = `
⚙️ System Status

🖥 Server: Online
💾 Database: Connected
⏱ Uptime: ${process.uptime()}s

💎 Master Wallet:
• Address: \`${walletService.getMasterAddress()}\`
• USDT: ${masterBalance.usdt}
• BNB: ${master.bnb}

📊 Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB
        `;

        await ctx.reply(message, { parse_mode: 'Markdown' });
    }

    async handleLogs(ctx) {
        const logs = await AdminLog.find()
            .sort({ timestamp: -1 })
            .limit(20);

        let message = '📋 Admin Logs (Last 20)\n\n';

        for (const log of logs) {
            message += `
[${log.timestamp.toLocaleString()}]
👤 ${log.adminId} → ${log.action}
🎯 ${log.targetUserId || 'N/A'}
📄 ${JSON.stringify(log.details).substring(0, 100)}
            `;
        }

        await ctx.reply(message);
    }

    async handleApproveReferral(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return ctx.reply('Usage: /approve_referral <tx_id>');
        }

        const txId = args[1];
        const tx = await Transaction.findOne({ txId, type: 'REFERRAL_REWARD', status: 'PENDING' });

        if (!tx) {
            return ctx.reply('❌ Referral transaction not found or already processed.');
        }

        // Credit referrer
        await User.updateOne(
            { userId: tx.userId },
            { $inc: { balance: tx.amount } }
        );

        await Transaction.updateOne(
            { txId },
            {
                $set: {
                    status: 'COMPLETED',
                    approvedBy: ctx.from.id.toString(),
                    approvedAt: new Date()
                }
            }
        );

        await ctx.reply(`✅ Referral reward ${formatCurrency(tx.amount)} approved for user ${tx.userId}`);

        // Notify referrer
        await ctx.telegram.sendMessage(tx.userId, `
🎁 Referral Reward Approved!

Amount: ${formatCurrency(tx.amount)}
Status: Credited to your balance

Thank you for referring users!
        `);
    }

    async handleMasterBalance(ctx) {
        const balance = await walletService.getMasterBalance();
        
        await ctx.reply(`
💎 Master Wallet Balance

Address: \`${walletService.getMasterAddress()}\`

USDT: ${balance.usdt}
BNB: ${balance.bnb}

This is your revenue wallet.
        `, { parse_mode: 'Markdown' });
    }

    async handleWithdrawProfits(ctx) {
        await ctx.reply(`
💸 Withdraw Profits

To withdraw, send USDT from your master wallet manually or use your wallet app.

Master Address: \`${walletService.getMasterAddress()}\`

⚠️ Always keep some BNB for gas fees.
        `, { parse_mode: 'Markdown' });
    }

    // Helper methods
    async getSystemStats() {
        const now = new Date();
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

        const [
            totalUsers,
            payingUsers,
            vipUsers,
            activeToday,
            otpStats,
            masterBalance
        ] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ balance: { $gt: 0 } }),
            User.countDocuments({ vipExpiry: { $gt: now } }),
            User.countDocuments({ lastActive: { $gte: dayAgo } }),
            Session.aggregate([
                { $match: { startTime: { $gte: dayAgo } } },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        success: { $sum: { $cond: [{ $eq: ['$status', 'RECEIVED'] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ['$status', 'TIMEOUT'] }, 1, 0] } }
                    }
                }
            ]),
            walletService.getMasterBalance().catch(() => ({ usdt: '0', bnb: '0' }))
        ]);

        const stats = otpStats[0] || { total: 0, success: 0, failed: 0 };

        return {
            totalUsers,
            payingUsers,
            vipUsers,
            activeToday,
            otpRequests24h: stats.total,
            otpSuccess24h: stats.success,
            otpFailed24h: stats.failed,
            successRate24h: stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : 0,
            revenue24h: await this.calculateRevenue(dayAgo),
            revenue7d: await this.calculateRevenue(new Date(now - 7 * 24 * 60 * 60 * 1000)),
            revenue30d: await this.calculateRevenue(new Date(now - 30 * 24 * 60 * 60 * 1000)),
            masterBalance: parseFloat(masterBalance.usdt),
            uptime: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`
        };
    }

    async calculateRevenue(since) {
        const result = await Transaction.aggregate([
            {
                $match: {
                    type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'] },
                    status: 'COMPLETED',
                    createdAt: { $gte: since }
                }
            },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        return Math.abs(result[0]?.total || 0);
    }

    async getRevenueByMode(since) {
        const results = await Transaction.aggregate([
            {
                $match: {
                    type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'] },
                    status: 'COMPLETED',
                    createdAt: { $gte: since }
                }
            },
            {
                $group: {
                    _id: '$type',
                    total: { $sum: { $abs: '$amount' } }
                }
            }
        ]);

        return results.map(r => `• ${r._id}: ${formatCurrency(r.total)}`).join('\n') || 'No data';
    }

    async getRevenueByService(since) {
        const results = await Session.aggregate([
            {
                $match: {
                    status: 'RECEIVED',
                    startTime: { $gte: since }
                }
            },
            {
                $group: {
                    _id: '$service',
                    count: { $sum: 1 },
                    revenue: { $sum: '$cost' }
                }
            },
            { $sort: { revenue: -1 } },
            { $limit: 5 }
        ]);

        return results.map(r => `• ${r._id}: ${formatCurrency(r.revenue)} (${r.count} OTPs)`).join('\n') || 'No data';
    }
}

export default AdminCommands;
 
