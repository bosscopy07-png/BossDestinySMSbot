import { Markup } from 'telegraf';
import { User, Session, Transaction, AdminLog } from '../../models/index.js';
import { generateId, formatCurrency } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class AdminCommands {
    constructor(bot, walletService) {
        this.bot = bot;
        this.walletService = walletService;
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
        this.bot.command('broadcast', this.requireAdmin, this.handleBroadcastCommand.bind(this));
        this.bot.command('system', this.requireAdmin, this.handleSystem.bind(this));
        this.bot.command('logs', this.requireAdmin, this.handleLogs.bind(this));
        this.bot.command('approve_referral', this.requireAdmin, this.handleApproveReferral.bind(this));
        this.bot.command('master_balance', this.requireAdmin, this.handleMasterBalance.bind(this));
        this.bot.command('withdraw_profits', this.requireAdmin, this.handleWithdrawProfits.bind(this));
        this.bot.command('setprice', this.requireAdmin, this.handleSetPrice.bind(this));
        this.bot.command('setvip', this.requireAdmin, this.handleSetVip.bind(this));
        this.bot.command('setfree', this.requireAdmin, this.handleSetFree.bind(this));
        this.bot.command('toggleprovider', this.requireAdmin, this.handleToggleProvider.bind(this));

        this.bot.action('admin_users', this.requireAdmin, this.handleUsers.bind(this));
        this.bot.action('admin_profits', this.requireAdmin, this.handleProfits.bind(this));
        this.bot.action('admin_system', this.requireAdmin, this.handleSystem.bind(this));
        this.bot.action('admin_logs', this.requireAdmin, this.handleLogs.bind(this));
        this.bot.action('admin_broadcast', this.requireAdmin, this.handleBroadcastMenu.bind(this));
        this.bot.action('admin_settings', this.requireAdmin, this.handleSettings.bind(this));
        this.bot.action('admin', this.requireAdmin, this.handleAdmin.bind(this));

        this.bot.action('broadcast_all', this.requireAdmin, this.handleBroadcastAll.bind(this));
        this.bot.action('broadcast_vip', this.requireAdmin, this.handleBroadcastVip.bind(this));
        this.bot.action('broadcast_paying', this.requireAdmin, this.handleBroadcastPaying.bind(this));
        this.bot.action('broadcast_recent', this.requireAdmin, this.handleBroadcastRecent.bind(this));

        this.bot.action('settings_prices', this.requireAdmin, this.handleSettingsPrices.bind(this));
        this.bot.action('settings_vip', this.requireAdmin, this.handleSettingsVip.bind(this));
        this.bot.action('settings_free', this.requireAdmin, this.handleSettingsFree.bind(this));
        this.bot.action('settings_providers', this.requireAdmin, this.handleSettingsProviders.bind(this));
        this.bot.action('settings_maintenance', this.requireAdmin, this.handleSettingsMaintenance.bind(this));

        this.bot.action('export_profits', this.requireAdmin, this.handleExportProfits.bind(this));
        this.bot.action('withdraw_profits', this.requireAdmin, this.handleWithdrawProfits.bind(this));

        this.bot.action(/admin_users_(\d+)/, this.requireAdmin, this.handleUsers.bind(this));
        
        this.bot.action(/addbal_(.+)/, this.requireAdmin, this.handleAddBalanceAction.bind(this));
        this.bot.action(/dedbal_(.+)/, this.requireAdmin, this.handleDeductBalanceAction.bind(this));
        this.bot.action(/bl_(.+)/, this.requireAdmin, this.handleBlacklistAction.bind(this));
        this.bot.action(/wl_(.+)/, this.requireAdmin, this.handleWhitelistAction.bind(this));
    }

    get requireAdmin() {
        return async (ctx, next) => {
            const adminIds = (config.bot?.adminId || '').toString().split(',').map(id => id.trim()).filter(Boolean);
            if (!adminIds.includes(ctx.from.id.toString())) {
                return ctx.reply('🚫 Admin access required.');
            }
            ctx.state.isAdmin = true;
            return next();
        };
    }

    async logAdminAction(adminId, action, targetUserId = null, details = {}) {
        try {
            await AdminLog.create({
                logId: generateId(),
                type: 'ADMIN_ACTION',
                adminId,
                targetUserId,
                action,
                details,
                timestamp: new Date()
            });
        } catch (error) {
            logger.error('Failed to log admin action', { adminId, action, error: error.message });
        }
    }

    async handleAdmin(ctx) {
        try {
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
        } catch (error) {
            logger.error('Admin dashboard error', { error: error.message, stack: error.stack });
            await ctx.reply('❌ Failed to load admin dashboard. Check logs.');
        }
    }

    async handleUsers(ctx) {
        try {
            const match = ctx.match ? ctx.match[1] : null;
            let page = match ? parseInt(match) || 1 : 1;
            if (page < 1) page = 1;
            const perPage = 10;

            const [users, totalUsers] = await Promise.all([
                User.find()
                    .sort({ lastActive: -1 })
                    .skip((page - 1) * perPage)
                    .limit(perPage),
                User.countDocuments()
            ]);

            const totalPages = Math.ceil(totalUsers / perPage) || 1;

            let message = `👥 Users (Page ${page}/${totalPages})\n\n`;

            for (const user of users) {
                const status = user.isBlacklisted ? '🔴' :
                              user.isVipActive?.() ? '👑' :
                              user.balance > 0 ? '💰' : '🆓';

                message += `
${status} ${user.username || user.firstName || 'Unknown'}
ID: \`${user.userId}\`
Balance: ${formatCurrency(user.balance)}
Mode: ${user.mode}
Last Active: ${user.lastActive?.toLocaleDateString() || 'Never'}
                `;
            }

            const navButtons = [];
            if (page > 1) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_users_${page - 1}`));
            if (page < totalPages) navButtons.push(Markup.button.callback('➡️ Next', `admin_users_${page + 1}`));

            const keyboard = Markup.inlineKeyboard([
                navButtons,
                [Markup.button.callback('🔙 Back to Admin', 'admin')]
            ]);

            await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
        } catch (error) {
            logger.error('Users list error', { error: error.message });
            await ctx.reply('❌ Failed to load users.');
        }
    }

    async handleUserDetail(ctx) {
        try {
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                return ctx.reply('Usage: /user <user_id>');
            }

            const targetId = args[1];
            const user = await User.findOne({ userId: targetId });

            if (!user) {
                return ctx.reply('❌ User not found.');
            }

            const [sessions, transactions] = await Promise.all([
                Session.find({ userId: targetId }).sort({ startTime: -1 }).limit(5),
                Transaction.find({ userId: targetId }).sort({ createdAt: -1 }).limit(5)
            ]);

            const message = `
👤 User Details

🆔 ID: \`${user.userId}\`
👤 Name: ${(user.firstName || '') + ' ' + (user.lastName || '')}
📱 Username: @${user.username || 'N/A'}
💰 Balance: ${formatCurrency(user.balance)}
📦 Bundle: ${user.bundleRemaining || 0} OTPs
👑 VIP: ${user.isVipActive?.() ? `Until ${user.vipExpiry?.toLocaleDateString()}` : 'Inactive'}
🆓 Free Used Today: ${user.freeUsedToday || 0}/3
📊 Mode: ${user.mode}

🚫 Status: ${user.isBlacklisted ? `BLACKLISTED (${user.blacklistReason})` : 'Active'}
📅 Joined: ${user.createdAt?.toLocaleDateString() || 'Unknown'}

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
        } catch (error) {
            logger.error('User detail error', { error: error.message });
            await ctx.reply('❌ Failed to load user details.');
        }
    }

    async handleProfits(ctx) {
        try {
            const now = new Date();
            const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
            const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
            const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

            const [dayRevenue, weekRevenue, monthRevenue] = await Promise.all([
                this.calculateRevenue(dayAgo),
                this.calculateRevenue(weekAgo),
                this.calculateRevenue(monthAgo)
            ]);

            let masterBalance = { usdt: 'N/A', bnb: 'N/A' };
            try {
                masterBalance = await this.walletService.getMasterBalance();
            } catch (error) {
                logger.warn('Failed to get master balance for profits', { error: error.message });
            }

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
        } catch (error) {
            logger.error('Profits error', { error: error.message });
            await ctx.reply('❌ Failed to load profit data.');
        }
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
            await this.walletService.addBalance(targetId, amount, ctx.from.id.toString(), reason);
            
            await this.logAdminAction(
                ctx.from.id.toString(),
                'ADD_BALANCE',
                targetId,
                { amount, reason }
            );

            await ctx.reply(`✅ Added ${formatCurrency(amount)} to user ${targetId}`);

            await ctx.telegram.sendMessage(targetId, `
🎁 Balance Added!

Amount: +${formatCurrency(amount)}
Reason: ${reason}

Your new balance has been updated.
            `).catch(() => {});

        } catch (error) {
            logger.error('Add balance error', { targetId, amount, error: error.message });
            await ctx.reply(`❌ Error: ${error.message}`);
        }
    }

    async handleAddBalanceAction(ctx) {
        const targetId = ctx.match[1];
        ctx.session = ctx.session || {};
        ctx.session.awaitingAddBalance = targetId;
        await ctx.reply(`Send amount to add to user ${targetId}:`);
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
            await this.walletService.deductBalance(targetId, amount, ctx.from.id.toString(), reason);
            
            await this.logAdminAction(
                ctx.from.id.toString(),
                'DEDUCT_BALANCE',
                targetId,
                { amount, reason }
            );

            await ctx.reply(`✅ Deducted ${formatCurrency(amount)} from user ${targetId}`);

        } catch (error) {
            logger.error('Deduct balance error', { targetId, amount, error: error.message });
            await ctx.reply(`❌ Error: ${error.message}`);
        }
    }

    async handleDeductBalanceAction(ctx) {
        const targetId = ctx.match[1];
        ctx.session = ctx.session || {};
        ctx.session.awaitingDeductBalance = targetId;
        await ctx.reply(`Send amount to deduct from user ${targetId}:`);
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

    async handleBlacklistAction(ctx) {
        const targetId = ctx.match[1];
        ctx.session = ctx.session || {};
        ctx.session.awaitingBlacklistReason = targetId;
        await ctx.reply(`Send reason for blacklisting user ${targetId} (or send "skip" for default):`);
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

    async handleWhitelistAction(ctx) {
        const targetId = ctx.match[1];
        await User.updateOne(
            { userId: targetId },
            { $set: { isBlacklisted: false, blacklistReason: null, blacklistDate: null } }
        );
        await this.logAdminAction(ctx.from.id.toString(), 'WHITELIST', targetId, {});
        await ctx.reply(`✅ User ${targetId} whitelisted.`);
    }

    async handleBroadcastCommand(ctx) {
        const args = ctx.message.text.split(' ').slice(1);
        const message = args.join(' ');

        if (!message) {
            return this.handleBroadcastMenu(ctx);
        }

        await this.executeBroadcast(ctx, {}, 'All Users', message);
    }

    async handleBroadcastMenu(ctx) {
        try {
            const stats = await this.getBroadcastStats();

            await ctx.reply(`
📢 Broadcast Menu

👥 Total Users: ${stats.total}
👑 VIP Users: ${stats.vip}
💰 Paying Users: ${stats.paying}
🆕 Joined (7d): ${stats.recent}

Select target audience:
            `, Markup.inlineKeyboard([
                [Markup.button.callback('📨 All Users', 'broadcast_all')],
                [Markup.button.callback('👑 VIP Only', 'broadcast_vip')],
                [Markup.button.callback('💰 Paying Users', 'broadcast_paying')],
                [Markup.button.callback('🆕 Recent (7d)', 'broadcast_recent')],
                [Markup.button.callback('🔙 Back', 'admin')]
            ]));
        } catch (error) {
            logger.error('Broadcast menu error', { error: error.message });
            await ctx.reply('❌ Failed to load broadcast menu.');
        }
    }

    async getBroadcastStats() {
        const now = new Date();
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

        const [total, vip, paying, recent] = await Promise.all([
            User.countDocuments({ isBlacklisted: false }),
            User.countDocuments({ isBlacklisted: false, vipExpiry: { $gt: now } }),
            User.countDocuments({ isBlacklisted: false, balance: { $gt: 0 } }),
            User.countDocuments({ isBlacklisted: false, createdAt: { $gte: weekAgo } })
        ]);

        return { total, vip, paying, recent };
    }

    async executeBroadcast(ctx, filter, label, forcedMessage = null) {
        try {
            await ctx.answerCbQuery?.(`Broadcasting to ${label}...`);

            const users = await User.find({ isBlacklisted: false, ...filter });
            let sent = 0;
            let failed = 0;

            if (!forcedMessage && !ctx.session?.broadcastMessage) {
                ctx.session = ctx.session || {};
                ctx.session.broadcastTarget = label;
                ctx.session.broadcastFilter = filter;
                
