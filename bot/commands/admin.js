import { Markup } from 'telegraf';
import { User, Session, Transaction, AdminLog, Settings } from '../../models/index.js';
import { generateId, formatCurrency } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

// ─── Image URLs ───
const IMG_SUCCESS = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';
const IMG_ERROR = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png';

class AdminCommands {
    constructor(bot, walletService, referralService = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.referralService = referralService;
        this.admins = new Set();
        this._registerCommands();
        this._registerTextHandlers();
        this._loadSettings();
    }

    // ─── Load persisted settings on init ───
    async _loadSettings() {
        try {
            const settings = await Settings.findOne();
            if (settings) {
                Object.assign(config, settings.toObject());
                logger.info('Admin settings loaded from DB');
            }
        } catch (error) {
            logger.warn('Failed to load settings from DB', { error: error.message });
        }
    }

    
        // ─── Persist settings to DB (uses Settings.merge for nested updates) ───
    async _saveSettings() {
        try {
            await Settings.merge(config);
            logger.info('Admin settings saved to DB');
        } catch (error) {
            logger.error('Failed to save settings', { error: error.message });
            throw error; // Re-throw so caller knows it failed
        }
    }
    

    // ─── Image reply helpers ───
    async replySuccess(ctx, text, extra = {}) {
        try {
            return await ctx.replyWithPhoto(IMG_SUCCESS, {
                caption: text,
                parse_mode: 'HTML',
                ...extra
            });
        } catch (error) {
            // Fallback to text if image fails
            logger.warn('Image reply failed, falling back to text', { error: error.message });
            return ctx.reply(text, { parse_mode: 'HTML', ...extra });
        }
    }

    async replyError(ctx, text, extra = {}) {
        try {
            return await ctx.replyWithPhoto(IMG_ERROR, {
                caption: text,
                parse_mode: 'HTML',
                ...extra
            });
        } catch (error) {
            logger.warn('Error image reply failed, falling back to text', { error: error.message });
            return ctx.reply(text, { parse_mode: 'HTML', ...extra });
        }
    }

    async editCaption(ctx, text, extra = {}) {
        try {
            return await ctx.editMessageCaption(text, { parse_mode: 'HTML', ...extra });
        } catch (error) {
            // If we can't edit (e.g., message too old), send new
            return this.replySuccess(ctx, text, extra);
        }
    }

    // ─── Admin middleware ───
    get requireAdmin() {
        return async (ctx, next) => {
            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            if (!adminIds.includes(ctx.from.id.toString())) {
                return this.replyError(ctx, '🚫 <b>Admin access required.</b>\n\nYou do not have permission to use this command.');
            }

            ctx.state.isAdmin = true;
            this.admins.add(ctx.from.id.toString());
            return next();
        };
    }

    // ─── Maintenance middleware (blocks non-admins) ───
    get maintenanceGuard() {
        return async (ctx, next) => {
            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            const isAdmin = adminIds.includes(ctx.from.id.toString());

            if (config.maintenance && !isAdmin) {
                return this.replyError(ctx, `🔧 <b>Maintenance Mode</b>\n\nThe bot is currently under maintenance. Please try again later.\n\n<i>We apologize for any inconvenience.</i>`);
            }

            return next();
        };
    }

    // ─── Admin action logger ───
    async logAdminAction(adminId, action, targetUserId = null, details = {}) {
        try {
            await AdminLog.create({
                logId: generateId(),
                type: 'ADMIN_ACTION',
                adminId: adminId?.toString(),
                targetUserId: targetUserId?.toString(),
                action,
                details,
                timestamp: new Date()
            });
        } catch (error) {
            logger.error('Failed to log admin action', { adminId, action, error: error.message });
        }
    }
        _registerCommands() {
        // ─── Slash Commands ───
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
        this.bot.command('reject_referral', this.requireAdmin, this.handleRejectReferral.bind(this));
        this.bot.command('master_balance', this.requireAdmin, this.handleMasterBalance.bind(this));
        this.bot.command('withdraw_profits', this.requireAdmin, this.handleWithdrawProfits.bind(this));
        this.bot.command('setprice', this.requireAdmin, this.handleSetPrice.bind(this));
        this.bot.command('setvip', this.requireAdmin, this.handleSetVip.bind(this));
        this.bot.command('setfree', this.requireAdmin, this.handleSetFree.bind(this));
        this.bot.command('toggleprovider', this.requireAdmin, this.handleToggleProvider.bind(this));
        this.bot.command('export_users', this.requireAdmin, this.handleExportUsers.bind(this));
        this.bot.command('export_transactions', this.requireAdmin, this.handleExportTransactions.bind(this));
        this.bot.command('message_user', this.requireAdmin, this.handleMessageUser.bind(this));

        // ─── Callback Actions ───
        this.bot.action('admin_users', this.requireAdmin, this.handleUsers.bind(this));
        this.bot.action('admin_profits', this.requireAdmin, this.handleProfits.bind(this));
        this.bot.action('admin_system', this.requireAdmin, this.handleSystem.bind(this));
        this.bot.action('admin_logs', this.requireAdmin, this.handleLogs.bind(this));
        this.bot.action('admin_broadcast', this.requireAdmin, this.handleBroadcastMenu.bind(this));
        this.bot.action('admin_settings', this.requireAdmin, this.handleSettings.bind(this));
        this.bot.action('admin', this.requireAdmin, this.handleAdmin.bind(this));

        // Broadcast targets
        this.bot.action('broadcast_all', this.requireAdmin, this.handleBroadcastAll.bind(this));
        this.bot.action('broadcast_vip', this.requireAdmin, this.handleBroadcastVip.bind(this));
        this.bot.action('broadcast_paying', this.requireAdmin, this.handleBroadcastPaying.bind(this));
        this.bot.action('broadcast_recent', this.requireAdmin, this.handleBroadcastRecent.bind(this));
        this.bot.action('broadcast_cancel', this.requireAdmin, this.handleBroadcastCancel.bind(this));

        // Settings submenus
        this.bot.action('settings_prices', this.requireAdmin, this.handleSettingsPrices.bind(this));
        this.bot.action('settings_vip', this.requireAdmin, this.handleSettingsVip.bind(this));
        this.bot.action('settings_free', this.requireAdmin, this.handleSettingsFree.bind(this));
        this.bot.action('settings_providers', this.requireAdmin, this.handleSettingsProviders.bind(this));
        this.bot.action('settings_maintenance', this.requireAdmin, this.handleSettingsMaintenance.bind(this));

        // Profit actions
        this.bot.action('export_profits', this.requireAdmin, this.handleExportProfits.bind(this));
        this.bot.action('withdraw_profits', this.requireAdmin, this.handleWithdrawProfits.bind(this));

        // Pagination
        this.bot.action(/admin_users_(\d+)/, this.requireAdmin, (ctx) => {
            ctx.match = ctx.match || [null, ctx.callbackQuery.data.match(/admin_users_(\d+)/)?.[1]];
            return this.handleUsers(ctx);
        });

        // User detail actions
        this.bot.action(/user_detail_(.+)/, this.requireAdmin, (ctx) => {
            const userId = ctx.match[1];
            return this.showUserDetailInline(ctx, userId);
        });

        this.bot.action(/addbal_(.+)/, this.requireAdmin, this.handleAddBalanceAction.bind(this));
        this.bot.action(/dedbal_(.+)/, this.requireAdmin, this.handleDeductBalanceAction.bind(this));
        this.bot.action(/bl_(.+)/, this.requireAdmin, this.handleBlacklistAction.bind(this));
        this.bot.action(/wl_(.+)/, this.requireAdmin, this.handleWhitelistAction.bind(this));
        this.bot.action(/msg_(.+)/, this.requireAdmin, this.handleMessageUserAction.bind(this));
        this.bot.action(/ban_(.+)/, this.requireAdmin, this.handleBanAction.bind(this));
        this.bot.action(/unban_(.+)/, this.requireAdmin, this.handleUnbanAction.bind(this));
        this.bot.action(/viewtx_(.+)/, this.requireAdmin, this.handleViewUserTransactions.bind(this));
        this.bot.action(/viewsess_(.+)/, this.requireAdmin, this.handleViewUserSessions.bind(this));
        this.bot.action(/back_user_(.+)/, this.requireAdmin, (ctx) => {
            return this.showUserDetailInline(ctx, ctx.match[1]);
        });
        this.bot.action(/back_users_(\d+)/, this.requireAdmin, (ctx) => {
            ctx.match = [null, ctx.match[1]];
            return this.handleUsers(ctx);
        });
    }
            _registerTextHandlers() {
        // Handle admin replies for awaiting inputs
        this.bot.on('text', async (ctx, next) => {
            if (!ctx.session) ctx.session = {};
            
            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            if (!adminIds.includes(ctx.from.id.toString())) {
                return next(); // Not an admin, pass to next handler
            }

            // ─── Awaiting broadcast message ───
            if (ctx.session.awaitingBroadcast) {
                const { target, filter, label } = ctx.session.awaitingBroadcast;
                delete ctx.session.awaitingBroadcast;
                return this.executeBroadcast(ctx, filter, label, ctx.message.text);
            }

            // ─── Awaiting add balance amount ───
            if (ctx.session.awaitingAddBalance) {
                const targetId = ctx.session.awaitingAddBalance;
                delete ctx.session.awaitingAddBalance;
                const amount = parseFloat(ctx.message.text);
                if (isNaN(amount) || amount <= 0) {
                    return this.replyError(ctx, '❌ <b>Invalid amount.</b>\n\nPlease send a valid positive number.');
                }
                return this.processAddBalance(ctx, targetId, amount, 'Admin credit via inline');
            }

            // ─── Awaiting deduct balance amount ───
            if (ctx.session.awaitingDeductBalance) {
                const targetId = ctx.session.awaitingDeductBalance;
                delete ctx.session.awaitingDeductBalance;
                const amount = parseFloat(ctx.message.text);
                if (isNaN(amount) || amount <= 0) {
                    return this.replyError(ctx, '❌ <b>Invalid amount.</b>\n\nPlease send a valid positive number.');
                }
                return this.processDeductBalance(ctx, targetId, amount, 'Admin deduction via inline');
            }

            // ─── Awaiting blacklist reason ───
            if (ctx.session.awaitingBlacklistReason) {
                const targetId = ctx.session.awaitingBlacklistReason;
                delete ctx.session.awaitingBlacklistReason;
                const reason = ctx.message.text.trim().toLowerCase() === 'skip' 
                    ? 'Manual blacklist' 
                    : ctx.message.text.trim();
                return this.processBlacklist(ctx, targetId, reason);
            }

            // ─── Awaiting message to user ───
            if (ctx.session.awaitingMessageUser) {
                const targetId = ctx.session.awaitingMessageUser;
                delete ctx.session.awaitingMessageUser;
                return this.processMessageUser(ctx, targetId, ctx.message.text);
            }

            return next();
        });
                        }
                                  // ═══════════════════════════════════════════════════════════
    //  DASHBOARD
    // ═══════════════════════════════════════════════════════════

    async handleAdmin(ctx) {
        try {
            const stats = await this.getSystemStats();

            const message = `
<b>🔐 Admin Dashboard</b>

<b>📊 Revenue</b>
• 24h: <code>${formatCurrency(stats.revenue24h)}</code>
• 7d: <code>${formatCurrency(stats.revenue7d)}</code>
• 30d: <code>${formatCurrency(stats.revenue30d)}</code>

<b>👥 Users</b>
• Total: <code>${stats.totalUsers}</code>
• Paying: <code>${stats.payingUsers}</code>
• VIP: <code>${stats.vipUsers}</code>
• Active Today: <code>${stats.activeToday}</code>

<b>📈 OTP Stats (24h)</b>
• Requests: <code>${stats.otpRequests24h}</code>
• Success: <code>${stats.otpSuccess24h}</code> (${stats.successRate24h}%)
• Failed: <code>${stats.otpFailed24h}</code>

<b>⚡ System</b>
• Master Balance: <code>${formatCurrency(stats.masterBalance)}</code>
• Uptime: <code>${stats.uptime}</code>
• Maintenance: <code>${config.maintenance ? '🔴 ON' : '🟢 OFF'}</code>
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

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Admin dashboard error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load admin dashboard.</b>\n\nPlease check the logs for details.');
        }
    }

    async getSystemStats() {
        const now = new Date();
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        let masterBalance = { usdt: '0', bnb: '0' };
        try {
            if (this.walletService?.getMasterBalance) {
                masterBalance = await this.walletService.getMasterBalance();
            }
        } catch (error) {
            logger.warn('getSystemStats: master balance unavailable', { error: error.message });
        }

        const [
            totalUsers,
            payingUsers,
            vipUsers,
            activeToday,
            otpStats
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
            ])
        ]);

        const stats = otpStats[0] || { total: 0, success: 0, failed: 0 };

        const [revenue24h, revenue7d, revenue30d] = await Promise.all([
            this.calculateRevenue(dayAgo),
            this.calculateRevenue(weekAgo),
            this.calculateRevenue(monthAgo)
        ]);

        return {
            totalUsers,
            payingUsers,
            vipUsers,
            activeToday,
            otpRequests24h: stats.total,
            otpSuccess24h: stats.success,
            otpFailed24h: stats.failed,
            successRate24h: stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : '0.0',
            revenue24h,
            revenue7d,
            revenue30d,
            masterBalance: parseFloat(masterBalance.usdt) || 0,
            uptime: this.formatUptime(process.uptime())
        };
    }

    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (days > 0) return `${days}d ${hours}h ${mins}m`;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    }

    async calculateRevenue(since) {
        try {
            const result = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'] },
                        status: 'COMPLETED',
                        createdAt: { $gte: since }
                    }
                },
                { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
            ]);
            return Math.abs(result[0]?.total || 0);
        } catch (error) {
            logger.error('Revenue calculation failed', { error: error.message });
            return 0;
        }
                       }
                                               // ═══════════════════════════════════════════════════════════
    //  USERS LIST (with inline detail buttons)
    // ═══════════════════════════════════════════════════════════

    async handleUsers(ctx) {
        try {
            let page = 1;
            
            if (ctx.match && ctx.match[1]) {
                page = parseInt(ctx.match[1]) || 1;
            }
            
            if (page < 1) page = 1;
            const perPage = 10;

            const [users, totalUsers] = await Promise.all([
                User.find()
                    .sort({ lastActive: -1 })
                    .skip((page - 1) * perPage)
                    .limit(perPage)
                    .lean(),
                User.countDocuments()
            ]);

            const totalPages = Math.ceil(totalUsers / perPage) || 1;
            if (page > totalPages) page = totalPages;

            let message = `<b>👥 Users</b> (Page ${page}/${totalPages})\n<i>Total: ${totalUsers} users</i>\n\n`;

            const buttons = [];
            const userButtons = [];

            for (const user of users) {
                const status = user.isBlacklisted ? '🔴' :
                              (user.vipExpiry && new Date(user.vipExpiry) > new Date()) ? '👑' :
                              user.balance > 0 ? '💰' : '🆓';

                const displayName = user.username 
                    ? `@${user.username}` 
                    : (user.firstName || 'Unknown');

                // Add to message
                message += `${status} <b>${displayName}</b>\n`;
                message += `   ID: <code>${user.userId}</code> | Balance: <code>${formatCurrency(user.balance)}</code>\n\n`;

                // Inline button for this user
                userButtons.push(
                    Markup.button.callback(
                        `${status} ${displayName.substring(0, 20)}`,
                        `user_detail_${user.userId}`
                    )
                );
            }

            // Group user buttons in rows of 2
            for (let i = 0; i < userButtons.length; i += 2) {
                buttons.push(userButtons.slice(i, i + 2));
            }

            // Navigation
            const navButtons = [];
            if (page > 1) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_users_${page - 1}`));
            if (page < totalPages) navButtons.push(Markup.button.callback('➡️ Next', `admin_users_${page + 1}`));
            if (navButtons.length) buttons.push(navButtons);

            buttons.push([Markup.button.callback('🔙 Back to Admin', 'admin')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Users list error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load users.</b>\n\nPlease try again later.');
        }
                                                        }
                               
    // ═══════════════════════════════════════════════════════════
    //  USER DETAIL (inline) with Action Buttons
    // ═══════════════════════════════════════════════════════════
    async showUserDetailInline(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();

            if (!user) {
                return this.replyError(ctx, '❌ <b>User not found.</b>');
            }

            // Fetch display data (limited) + stats (aggregated) in parallel
            const [
                recentSessions,
                recentTransactions,
                referrals,
                sessionCounts,
                txStats
            ] = await Promise.all([
                Session.find({ userId })
                    .sort({ startTime: -1 })
                    .limit(10)
                    .lean(),
                Transaction.find({ userId })
                    .sort({ createdAt: -1 })
                    .limit(10)
                    .lean(),
                User.find({ referredBy: userId })
                    .select('userId username createdAt')
                    .lean(),
                Session.countDocuments({ userId }),
                Transaction.aggregate([
                    { $match: { userId, status: 'COMPLETED' } },
                    {
                        $group: {
                            _id: null,
                            totalSpent: {
                                $sum: {
                                    $cond: [
                                        { $in: ['$type', ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION']] },
                                        { $abs: '$amount' },
                                        0
                                    ]
                                }
                            },
                            totalDeposited: {
                                $sum: {
                                    $cond: [{ $eq: ['$type', 'DEPOSIT'] }, '$amount', 0]
                                }
                            },
                            totalRefEarnings: {
                                $sum: {
                                    $cond: [{ $eq: ['$type', 'REFERRAL_REWARD'] }, '$amount', 0]
                                }
                            }
                        }
                    }
                ])
            ]);

            const stats = txStats[0] || { totalSpent: 0, totalDeposited: 0, totalRefEarnings: 0 };
            const isVip = user.vipExpiry && new Date(user.vipExpiry) > new Date();
            const statusEmoji = user.isBlacklisted ? '🔴 BANNED' : isVip ? '👑 VIP' : '✅ Active';

            const message = `
<b>👤 User Details</b>

<b>🆔 ID:</b> <code>${user.userId}</code>
<b>👤 Name:</b> ${(user.firstName || '') + ' ' + (user.lastName || '')}
<b>📱 Username:</b> ${user.username ? '@' + user.username : 'N/A'}
<b>💰 Balance:</b> <code>${formatCurrency(user.balance)}</code>
<b>🔒 Locked:</b> <code>${formatCurrency(user.lockedBalance || 0)}</code>
<b>📦 Bundle:</b> <code>${user.bundleRemaining || 0}</code> OTPs
<b>👑 VIP:</b> ${isVip ? `Until ${new Date(user.vipExpiry).toLocaleDateString()}` : 'Inactive'}
<b>🆓 Free Used Today:</b> <code>${user.freeUsedToday || 0}</code>/3
<b>📊 Mode:</b> <code>${user.mode || 'N/A'}</code>

<b>🚫 Status:</b> ${statusEmoji}
${user.isBlacklisted ? `<b>Reason:</b> ${user.blacklistReason || 'N/A'}\n` : ''}
<b>📅 Joined:</b> ${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Unknown'}
<b>🕐 Last Active:</b> ${user.lastActive ? new Date(user.lastActive).toLocaleDateString() : 'Never'}

<b>📊 Stats</b>
• Total Spent: <code>${formatCurrency(stats.totalSpent)}</code>
• Total Deposited: <code>${formatCurrency(stats.totalDeposited)}</code>
• Ref Earnings: <code>${formatCurrency(stats.totalRefEarnings)}</code>
• Total Sessions: <code>${sessionCounts}</code>
• Referrals: <code>${referrals.length}</code>
• Net Balance: <code>${formatCurrency((user.balance || 0) - (user.lockedBalance || 0))}</code>
• Lifetime Value: <code>${formatCurrency(stats.totalSpent + (user.bundleRemaining || 0) * (config.prices?.cheapOtp || 0.05))}</code>

<b>📞 Recent Sessions:</b> <code>${recentSessions.length}</code> shown
<b>📜 Recent Transactions:</b> <code>${recentTransactions.length}</code> shown
            `;

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('➕ Add Balance', `addbal_${userId}`),
                    Markup.button.callback('➖ Deduct Balance', `dedbal_${userId}`)
                ],
                [
                    Markup.button.callback('📨 Message', `msg_${userId}`),
                    Markup.button.callback('📜 Transactions', `viewtx_${userId}`)
                ],
                [
                    Markup.button.callback('📞 Sessions', `viewsess_${userId}`),
                    user.isBlacklisted 
                        ? Markup.button.callback('🟢 Unban', `unban_${userId}`)
                        : Markup.button.callback('🔴 Ban', `ban_${userId}`)
                ],
                [
                    user.isBlacklisted
                        ? Markup.button.callback('🟢 Whitelist', `wl_${userId}`)
                        : Markup.button.callback('🔴 Blacklist', `bl_${userId}`)
                ],
                [Markup.button.callback('🔙 Back to Users', 'admin_users')]
            ]);

            await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('User detail inline error', { userId, error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load user details.</b>');
        }
    }
    
    
    async handleUserDetail(ctx) {
        try {
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                return this.replyError(ctx, '❌ <b>Usage:</b> <code>/user &lt;user_id&gt;</code>');
            }

            const targetId = args[1];
            await this.showUserDetailInline(ctx, targetId);
        } catch (error) {
            logger.error('User detail error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load user details.</b>');
        }
    }

    async handleViewUserTransactions(ctx) {
        try {
            const userId = ctx.match[1];
            const transactions = await Transaction.find({ userId })
                .sort({ createdAt: -1 })
                .limit(15)
                .lean();

            if (!transactions.length) {
                return this.editCaption(ctx, '<b>📜 No transactions found.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', `back_user_${userId}`)]
                    ]).reply_markup
                });
            }

            let message = `<b>📜 Recent Transactions</b> for <code>${userId}</code>\n\n`;
            for (const tx of transactions) {
                const emoji = tx.status === 'COMPLETED' ? '✅' : tx.status === 'PENDING' ? '⏳' : '❌';
                message += `${emoji} <b>${tx.type}</b> | <code>${formatCurrency(Math.abs(tx.amount || 0))}</code>\n`;
                message += `   Status: <code>${tx.status}</code> | ${tx.createdAt ? new Date(tx.createdAt).toLocaleDateString() : 'N/A'}\n\n`;
            }

            await this.editCaption(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back to User', `back_user_${userId}`)]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('View transactions error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load transactions.</b>');
        }
    }

    async handleViewUserSessions(ctx) {
        try {
            const userId = ctx.match[1];
            const sessions = await Session.find({ userId })
                .sort({ startTime: -1 })
                .limit(15)
                .lean();

            if (!sessions.length) {
                return this.editCaption(ctx, '<b>📞 No sessions found.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', `back_user_${userId}`)]
                    ]).reply_markup
                });
            }

            let message = `<b>📞 Recent Sessions</b> for <code>${userId}</code>\n\n`;
            for (const s of sessions) {
                const emoji = s.status === 'RECEIVED' ? '✅' : s.status === 'TIMEOUT' ? '⏰' : '❌';
                message += `${emoji} <b>${s.service || 'N/A'}</b> (${s.country || 'N/A'})\n`;
                message += `   Status: <code>${s.status}</code> | Cost: <code>${formatCurrency(s.cost || 0)}</code>\n`;
                message += `   ${s.startTime ? new Date(s.startTime).toLocaleString() : 'N/A'}\n\n`;
            }

            await this.editCaption(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back to User', `back_user_${userId}`)]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('View sessions error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load sessions.</b>');
        }
        }
        // ═══════════════════════════════════════════════════════════
    //  BALANCE OPERATIONS
    // ═══════════════════════════════════════════════════════════

    async handleAddBalance(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/addbalance &lt;user_id&gt; &lt;amount&gt; [reason]</code>');
        }

        const targetId = args[1];
        const amount = parseFloat(args[2]);
        const reason = args.slice(3).join(' ') || 'Admin credit';

        if (isNaN(amount) || amount <= 0) {
            return this.replyError(ctx, '❌ <b>Invalid amount.</b>\n\nAmount must be a positive number.');
        }

        await this.processAddBalance(ctx, targetId, amount, reason);
    }

    async processAddBalance(ctx, targetId, amount, reason) {
        try {
            let txId;
            if (this.walletService?.addBalance) {
                txId = await this.walletService.addBalance(targetId, amount, ctx.from.id.toString(), reason);
            } else {
                // Fallback: direct DB update
                await User.updateOne({ userId: targetId }, { $inc: { balance: amount } });
                txId = generateId();
                await Transaction.create({
                    txId,
                    userId: targetId,
                    type: 'ADMIN_ADD',
                    amount,
                    status: 'COMPLETED',
                    metadata: { adminId: ctx.from.id.toString(), reason },
                    createdAt: new Date()
                });
            }

            await this.logAdminAction(
                ctx.from.id.toString(),
                'ADD_BALANCE',
                targetId,
                { amount, reason, txId }
            );

            await this.replySuccess(ctx, `✅ <b>Balance Added!</b>\n\nUser: <code>${targetId}</code>\nAmount: <code>+${formatCurrency(amount)}</code>\nReason: <i>${reason}</i>\nTxID: <code>${txId}</code>`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
<b>🎁 Balance Added!</b>

Amount: <code>+${formatCurrency(amount)}</code>
Reason: <i>${reason}</i>

Your new balance has been updated.
            `, { parse_mode: 'HTML' }).catch(err => {
                logger.warn('Failed to notify user of balance addition', { userId: targetId, error: err.message });
            });

        } catch (error) {
            logger.error('Add balance error', { targetId, amount, error: error.message, stack: error.stack });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    }

    async handleAddBalanceAction(ctx) {
        const targetId = ctx.match[1];
        if (!ctx.session) ctx.session = {};
        ctx.session.awaitingAddBalance = targetId;
        await this.replySuccess(ctx, `💰 <b>Add Balance</b>\n\nSend the amount to add to user <code>${targetId}</code>:\n\n<i>Reply with a number (e.g., 10.50)</i>`);
    }

    async handleDeductBalance(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/deductbalance &lt;user_id&gt; &lt;amount&gt; [reason]</code>');
        }

        const targetId = args[1];
        const amount = parseFloat(args[2]);
        const reason = args.slice(3).join(' ') || 'Admin deduction';

        if (isNaN(amount) || amount <= 0) {
            return this.replyError(ctx, '❌ <b>Invalid amount.</b>\n\nAmount must be a positive number.');
        }

        await this.processDeductBalance(ctx, targetId, amount, reason);
    }

    async processDeductBalance(ctx, targetId, amount, reason) {
        try {
            const user = await User.findOne({ userId: targetId });
            if (!user) throw new Error('USER_NOT_FOUND');
            if ((user.balance || 0) < amount) throw new Error('INSUFFICIENT_BALANCE');

            let txId;
            if (this.walletService?.deductBalance) {
                txId = await this.walletService.deductBalance(targetId, amount, ctx.from.id.toString(), reason);
            } else {
                await User.updateOne({ userId: targetId }, { $inc: { balance: -amount } });
                txId = generateId();
                await Transaction.create({
                    txId,
                    userId: targetId,
                    type: 'ADMIN_DEDUCT',
                    amount: -amount,
                    status: 'COMPLETED',
                    metadata: { adminId: ctx.from.id.toString(), reason },
                    createdAt: new Date()
                });
            }

            await this.logAdminAction(
                ctx.from.id.toString(),
                'DEDUCT_BALANCE',
                targetId,
                { amount, reason, txId }
            );

            await this.replySuccess(ctx, `✅ <b>Balance Deducted!</b>\n\nUser: <code>${targetId}</code>\nAmount: <code>-${formatCurrency(amount)}</code>\nReason: <i>${reason}</i>\nTxID: <code>${txId}</code>`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
<b>⚠️ Balance Deducted</b>

Amount: <code>-${formatCurrency(amount)}</code>
Reason: <i>${reason}</i>

Your balance has been updated.
            `, { parse_mode: 'HTML' }).catch(err => {
                logger.warn('Failed to notify user of balance deduction', { userId: targetId, error: err.message });
            });

        } catch (error) {
            logger.error('Deduct balance error', { targetId, amount, error: error.message, stack: error.stack });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    }

    async handleDeductBalanceAction(ctx) {
        const targetId = ctx.match[1];
        if (!ctx.session) ctx.session = {};
        ctx.session.awaitingDeductBalance = targetId;
        await this.replySuccess(ctx, `💰 <b>Deduct Balance</b>\n\nSend the amount to deduct from user <code>${targetId}</code>:\n\n<i>Reply with a number (e.g., 5.00)</i>`);
    }
        // ═══════════════════════════════════════════════════════════
    //  BLACKLIST / BAN / WHITELIST / MESSAGE USER
    // ═══════════════════════════════════════════════════════════

    async handleBlacklist(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/blacklist &lt;user_id&gt; [reason]</code>');
        }

        const targetId = args[1];
        const reason = args.slice(2).join(' ') || 'Manual blacklist';
        await this.processBlacklist(ctx, targetId, reason);
    }

    async processBlacklist(ctx, targetId, reason) {
        try {
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
                { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
            );

            await this.logAdminAction(
                ctx.from.id.toString(),
                'BLACKLIST',
                targetId,
                { reason }
            );

            await this.replySuccess(ctx, `🚫 <b>User Blacklisted</b>\n\nUser: <code>${targetId}</code>\nReason: <i>${reason}</i>\n\nAll active sessions have been cancelled.`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
<b>🚫 Account Restricted</b>

Your account has been blacklisted.

<b>Reason:</b> <i>${reason}</i>

Contact support if you believe this is a mistake.
            `, { parse_mode: 'HTML' }).catch(() => {});

        } catch (error) {
            logger.error('Blacklist error', { targetId, error: error.message });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    }

    async handleBlacklistAction(ctx) {
        const targetId = ctx.match[1];
        if (!ctx.session) ctx.session = {};
        ctx.session.awaitingBlacklistReason = targetId;
        await this.replySuccess(ctx, `🔴 <b>Blacklist User</b>\n\nSend reason for blacklisting user <code>${targetId}</code>:\n\n<i>Reply with a reason or send "skip" for default reason.</i>`);
    }

    async handleWhitelist(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/whitelist &lt;user_id&gt;</code>');
        }

        const targetId = args[1];
        await this.processWhitelist(ctx, targetId);
    }

    async processWhitelist(ctx, targetId) {
        try {
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

            await this.replySuccess(ctx, `✅ <b>User Whitelisted</b>\n\nUser: <code>${targetId}</code>\n\nAll restrictions have been removed.`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
<b>✅ Account Restored</b>

Your account has been whitelisted. All restrictions have been removed.

You can now use the bot normally.
            `, { parse_mode: 'HTML' }).catch(() => {});

        } catch (error) {
            logger.error('Whitelist error', { targetId, error: error.message });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    }

    async handleWhitelistAction(ctx) {
        const targetId = ctx.match[1];
        await this.processWhitelist(ctx, targetId);
    }

    async handleBanAction(ctx) {
        const targetId = ctx.match[1];
        await this.processBlacklist(ctx, targetId, 'Banned by admin');
    }

    async handleUnbanAction(ctx) {
        const targetId = ctx.match[1];
        await this.processWhitelist(ctx, targetId);
    }

    async handleMessageUser(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/message_user &lt;user_id&gt; &lt;message&gt;</code>');
        }

        const targetId = args[1];
        const messageText = args.slice(2).join(' ');
        await this.processMessageUser(ctx, targetId, messageText);
    }

    async handleMessageUserAction(ctx) {
        const targetId = ctx.match[1];
        if (!ctx.session) ctx.session = {};
        ctx.session.awaitingMessageUser = targetId;
        await this.replySuccess(ctx, `📨 <b>Message User</b>\n\nSend the message to deliver to user <code>${targetId}</code>:\n\n<i>Type your message and send it.</i>`);
    }

    async processMessageUser(ctx, targetId, messageText) {
        try {
            const user = await User.findOne({ userId: targetId });
            if (!user) throw new Error('USER_NOT_FOUND');

            await ctx.telegram.sendMessage(targetId, `
<b>📨 Message from Admin</b>

<i>${messageText}</i>

---
<i>SWIFTSMS The fastest SMS Service if you need assistance contact us.</i>
            `, { parse_mode: 'HTML' });

            await this.logAdminAction(
                ctx.from.id.toString(),
                'MESSAGE_USER',
                targetId,
                { message: messageText.substring(0, 500) }
            );

            await this.replySuccess(ctx, `✅ <b>Message Sent!</b>\n\nTo: <code>${targetId}</code>\nMessage: <i>${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}</i>`);

        } catch (error) {
            logger.error('Message user error', { targetId, error: error.message });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
                }
            // ═══════════════════════════════════════════════════════════
    //  PROFITS
    // ═══════════════════════════════════════════════════════════

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

            let masterBalance = { usdt: 'N/A', bnb: 'N/A', address: 'N/A' };
            try {
                if (this.walletService?.getMasterBalance) {
                    masterBalance = await this.walletService.getMasterBalance();
                }
                if (this.walletService?.getMasterAddress) {
                    masterBalance.address = this.walletService.getMasterAddress();
                }
            } catch (error) {
                logger.warn('Failed to get master balance for profits', { error: error.message });
            }

            const message = `
<b>💰 Profit Analytics</b>

<b>📅 Revenue:</b>
• 24h: <code>${formatCurrency(dayRevenue)}</code>
• 7d: <code>${formatCurrency(weekRevenue)}</code>
• 30d: <code>${formatCurrency(monthRevenue)}</code>

<b>💎 Master Wallet:</b>
• Address: <code>${masterBalance.address}</code>
• USDT: <code>${masterBalance.usdt}</code>
• BNB: <code>${masterBalance.bnb}</code>

<b>📊 By Mode (30d):</b>
${await this.getRevenueByMode(monthAgo)}

<b>📊 By Service (30d):</b>
${await this.getRevenueByService(monthAgo)}
            `;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('📥 Export CSV', 'export_profits')],
                    [Markup.button.callback('💸 Withdraw', 'withdraw_profits')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Profits error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load profit data.</b>');
        }
    }

    async getRevenueByMode(since) {
        try {
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
            return results.map(r => `• ${r._id}: <code>${formatCurrency(r.total)}</code>`).join('\n') || '<i>No data</i>';
        } catch (error) {
            logger.error('Revenue by mode error', { error: error.message });
            return '<i>Error loading data</i>';
        }
    }

    async getRevenueByService(since) {
        try {
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
            return results.map(r => `• ${r._id}: <code>${formatCurrency(r.revenue)}</code> (${r.count} OTPs)`).join('\n') || '<i>No data</i>';
        } catch (error) {
            logger.error('Revenue by service error', { error: error.message });
            return '<i>Error loading data</i>';
        }
    }

    async handleExportProfits(ctx) {
        try {
            if (ctx.callbackQuery && ctx.answerCbQuery) {
    await ctx.answerCbQuery('Generating export...').catch(() => {});
            }
            
            const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const results = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'] },
                        status: 'COMPLETED',
                        createdAt: { $gte: monthAgo }
                    }
                },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        total: { $sum: { $abs: '$amount' } }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            if (results.length === 0) {
                return this.replyError(ctx, '<b>📥 No profit data to export.</b>');
            }

            let csv = 'Date,Revenue\n';
            for (const r of results) {
                csv += `${r._id},${r.total.toFixed(2)}\n`;
            }

            await this.replySuccess(ctx, `<b>📥 Profit Export (Last 30 Days)</b>\n\n<pre>${csv}</pre>`);
        } catch (error) {
            logger.error('Export profits error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to export profits.</b>');
        }
    }

    async handleWithdrawProfits(ctx) {
        let address = 'N/A';
        try {
            if (this.walletService?.getMasterAddress) {
                address = this.walletService.getMasterAddress();
            }
        } catch (error) {
            logger.warn('Failed to get master address', { error: error.message });
        }

        await this.replySuccess(ctx, `
<b>💸 Withdraw Profits</b>

To withdraw, send USDT from your master wallet manually or use your wallet app.

<b>Master Address:</b> <code>${address}</code>

⚠️ <i>Always keep some BNB for gas fees.</i>
        `, { parse_mode: 'HTML' });
    }

    // ═══════════════════════════════════════════════════════════
    //  SYSTEM STATUS
    // ═══════════════════════════════════════════════════════════

    async handleSystem(ctx) {
        try {
            let masterBalance = { usdt: 'N/A', bnb: 'N/A' };
            let address = 'N/A';
            try {
                if (this.walletService?.getMasterBalance) {
                    masterBalance = await this.walletService.getMasterBalance();
                }
                if (this.walletService?.getMasterAddress) {
                    address = this.walletService.getMasterAddress();
                }
            } catch (error) {
                logger.warn('Failed to get master data for system status', { error: error.message });
            }

            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const mins = Math.floor((uptime % 3600) / 60);

            const message = `
<b>⚙️ System Status</b>

🖥 <b>Server:</b> Online
💾 <b>Database:</b> Connected
⏱ <b>Uptime:</b> <code>${hours}h ${mins}m</code>

<b>💎 Master Wallet:</b>
• Address: <code>${address}</code>
• USDT: <code>${masterBalance.usdt}</code>
• BNB: <code>${masterBalance.bnb}</code>

<b>📊 Memory:</b>
• Used: <code>${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB</code>
• Total: <code>${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB</code>
• RSS: <code>${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB</code>

<b>🔧 Node.js:</b> <code>${process.version}</code>
            `;

            await this.replySuccess(ctx, message);
        } catch (error) {
            logger.error('System status error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load system status.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  ADMIN LOGS
    // ═══════════════════════════════════════════════════════════

    async handleLogs(ctx) {
        try {
            const logs = await AdminLog.find()
                .sort({ timestamp: -1 })
                .limit(20)
                .lean();

            let message = '<b>📋 Admin Logs</b> (Last 20)\n\n';

            if (logs.length === 0) {
                message += '<i>No logs yet.</i>';
            } else {
                for (const log of logs) {
                    const time = log.timestamp ? new Date(log.timestamp).toLocaleString() : 'N/A';
                    const details = JSON.stringify(log.details || {}).substring(0, 100);
                    message += `<b>[${time}]</b>\n`;
                    message += `👤 <code>${log.adminId}</code> → <b>${log.action}</b>\n`;
                    message += `🎯 ${log.targetUserId ? `<code>${log.targetUserId}</code>` : 'N/A'}\n`;
                    message += `📄 <code>${details}</code>\n\n`;
                }
            }

            await this.replySuccess(ctx, message);
        } catch (error) {
            logger.error('Logs error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load logs.</b>');
        }
                        }
                                   // ═══════════════════════════════════════════════════════════
    //  BROADCAST (Fixed Flow)
    // ═══════════════════════════════════════════════════════════

    async handleBroadcastCommand(ctx) {
        const args = ctx.message.text.split(' ').slice(1);
        const message = args.join(' ');

        if (!message) {
            return this.handleBroadcastMenu(ctx);
        }

        // Direct broadcast to all users
        await this.executeBroadcast(ctx, {}, 'All Users', message);
    }

    async handleBroadcastMenu(ctx) {
        try {
            const stats = await this.getBroadcastStats();

            await this.replySuccess(ctx, `
<b>📢 Broadcast Menu</b>

<b>👥 Audience Stats:</b>
• Total Users: <code>${stats.total}</code>
• VIP Users: <code>${stats.vip}</code>
• Paying Users: <code>${stats.paying}</code>
• Recent (7d): <code>${stats.recent}</code>

<i>Select target audience or type /broadcast &lt;message&gt; to send to all immediately.</i>
            `, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('📨 All Users', 'broadcast_all')],
                    [Markup.button.callback('👑 VIP Only', 'broadcast_vip')],
                    [Markup.button.callback('💰 Paying Users', 'broadcast_paying')],
                    [Markup.button.callback('🆕 Recent (7d)', 'broadcast_recent')],
                    [Markup.button.callback('❌ Cancel', 'broadcast_cancel')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Broadcast menu error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load broadcast menu.</b>');
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
            // If no message provided, ask admin to type it
            if (!forcedMessage) {
                if (!ctx.session) ctx.session = {};
                ctx.session.awaitingBroadcast = { target: label, filter, label };
                return this.replySuccess(ctx, `
<b>📢 Broadcast to ${label}</b>

Send the message you want to broadcast to <code>${label}</code>.

<i>Type your message and send it. It will be delivered to all matching users.</i>
                `);
            }

            // Acknowledge callback if present
            if (ctx.callbackQuery && ctx.answerCbQuery) {
    await ctx.answerCbQuery(`Broadcasting to ${label}...`).catch(() => {});
            }
            
            const query = { isBlacklisted: false, ...filter };
            const users = await User.find(query).select('userId').lean();
            const results = { sent: 0, failed: 0, total: users.length };
            const delay = 50; // ms between messages
            const batchSize = 30;

            logger.info('Broadcast started', { targetCount: users.length, label, filter });

            for (let i = 0; i < users.length; i += batchSize) {
                const batch = users.slice(i, i + batchSize);

                await Promise.all(batch.map(async (user) => {
                    try {
                        await ctx.telegram.sendMessage(user.userId, `
<b>📢 ${label}</b>

${forcedMessage}

---
<i>OTP Bot Team</i>
                        `, { parse_mode: 'HTML', disable_notification: false });
                        results.sent++;
                    } catch (error) {
                        results.failed++;
                        if (error.response?.error_code === 403) {
                            // User blocked bot
                            await User.updateOne({ userId: user.userId }, { $set: { blockedBot: true, isBlacklisted: true } }).catch(() => {});
                        }
                        logger.warn('Broadcast failed for user', { userId: user.userId, error: error.message });
                    }
                }));

                // Rate limit protection between batches
                if (i + batchSize < users.length) {
                    await new Promise(r => setTimeout(r, 1000));
                }

                // Progress update every 5 batches
                if ((i / batchSize) % 5 === 0 && i > 0) {
                    await ctx.reply(`⏳ Broadcast progress: ${results.sent}/${results.total} sent...`).catch(() => {});
                }
            }

            logger.info('Broadcast completed', results);

            await this.replySuccess(ctx, `
<b>📢 Broadcast Complete!</b>

<b>Target:</b> <code>${label}</code>
<b>Total:</b> <code>${results.total}</code>
<b>✅ Sent:</b> <code>${results.sent}</code>
<b>❌ Failed:</b> <code>${results.failed}</code>
<b>Success Rate:</b> <code>${results.total > 0 ? ((results.sent / results.total) * 100).toFixed(1) : 0}%</code>
            `);

        } catch (error) {
            logger.error('Broadcast execution error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Broadcast failed.</b>\n\nPlease check the logs.');
        }
    }

    async handleBroadcastAll(ctx) {
        await this.executeBroadcast(ctx, {}, 'All Users');
    }

    async handleBroadcastVip(ctx) {
        const now = new Date();
        await this.executeBroadcast(ctx, { vipExpiry: { $gt: now } }, 'VIP Users');
    }

    async handleBroadcastPaying(ctx) {
        await this.executeBroadcast(ctx, { balance: { $gt: 0 } }, 'Paying Users');
    }

    async handleBroadcastRecent(ctx) {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await this.executeBroadcast(ctx, { createdAt: { $gte: weekAgo } }, 'Recent Users');
    }

    async handleBroadcastCancel(ctx) {
        if (ctx.session) {
            delete ctx.session.awaitingBroadcast;
        }
        if (ctx.answerCbQuery) await ctx.answerCbQuery('Cancelled').catch(() => {});
        await this.replySuccess(ctx, '❌ <b>Broadcast cancelled.</b>');
                                                  }
            
    // ═══════════════════════════════════════════════════════════
    //  REFERRAL MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    async handleApproveReferral(ctx) {
        try {
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                return this.replyError(ctx, '❌ <b>Usage:</b> <code>/approve_referral &lt;tx_id&gt;</code>');
            }

            const txId = args[1];
            const tx = await Transaction.findOne({ txId, type: 'REFERRAL_REWARD', status: 'PENDING' });

            if (!tx) {
                return this.replyError(ctx, '❌ <b>Referral transaction not found or already processed.</b>');
            }

            await User.updateOne(
                { userId: tx.userId },
                { $inc: { balance: tx.amount, referralRewardsPending: -tx.amount } }
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

            await this.replySuccess(ctx, `✅ <b>Referral Reward Approved!</b>\n\nAmount: <code>${formatCurrency(tx.amount)}</code>\nUser: <code>${tx.userId}</code>`);

            // Notify user
            await ctx.telegram.sendMessage(tx.userId, `
<b>🎁 Referral Reward Approved!</b>

Amount: <code>${formatCurrency(tx.amount)}</code>
Status: <b>Credited to your balance</b>

Thank you for referring users!
            `, { parse_mode: 'HTML' }).catch(() => {});

            await this.logAdminAction(ctx.from.id.toString(), 'APPROVE_REFERRAL', tx.userId, { txId, amount: tx.amount });

        } catch (error) {
            logger.error('Approve referral error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to approve referral.</b>');
        }
    }

    async handleRejectReferral(ctx) {
        try {
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                return this.replyError(ctx, '❌ <b>Usage:</b> <code>/reject_referral &lt;tx_id&gt; [reason]</code>');
            }

            const txId = args[1];
            const reason = args.slice(2).join(' ') || 'Rejected by admin';

            const tx = await Transaction.findOne({ txId, type: 'REFERRAL_REWARD', status: 'PENDING' });
            if (!tx) {
                return this.replyError(ctx, '❌ <b>Referral transaction not found or already processed.</b>');
            }

            await Transaction.updateOne(
                { txId },
                {
                    $set: {
                        status: 'REJECTED',
                        rejectedBy: ctx.from.id.toString(),
                        rejectedAt: new Date(),
                        rejectionReason: reason
                    }
                }
            );

            await User.updateOne(
                { userId: tx.userId },
                { $inc: { referralRewardsPending: -tx.amount } }
            );

            await this.replySuccess(ctx, `❌ <b>Referral Reward Rejected</b>\n\nTxID: <code>${txId}</code>\nReason: <i>${reason}</i>`);

            // Notify user
            await ctx.telegram.sendMessage(tx.userId, `
<b>❌ Referral Reward Rejected</b>

Amount: <code>${formatCurrency(tx.amount)}</code>
Reason: <i>${reason}</i>

Contact support if you have questions.
            `, { parse_mode: 'HTML' }).catch(() => {});

            await this.logAdminAction(ctx.from.id.toString(), 'REJECT_REFERRAL', tx.userId, { txId, reason });

        } catch (error) {
            logger.error('Reject referral error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to reject referral.</b>');
        }
    }
            // ═══════════════════════════════════════════════════════════
    //  MASTER BALANCE
    // ═══════════════════════════════════════════════════════════

    async handleMasterBalance(ctx) {
        try {
            let balance = { usdt: 'N/A', bnb: 'N/A' };
            let address = 'N/A';

            try {
                if (this.walletService?.getMasterBalance) {
                    balance = await this.walletService.getMasterBalance();
                }
                if (this.walletService?.getMasterAddress) {
                    address = this.walletService.getMasterAddress();
                }
            } catch (error) {
                logger.warn('Failed to get master balance', { error: error.message });
            }

            await this.replySuccess(ctx, `
<b>💎 Master Wallet Balance</b>

<b>Address:</b> <code>${address}</code>

<b>USDT:</b> <code>${balance.usdt}</code>
<b>BNB:</b> <code>${balance.bnb}</code>

<i>This is your revenue wallet.</i>
            `);
        } catch (error) {
            logger.error('Master balance error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to get master balance.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SETTINGS (with DB Persistence)
    // ═══════════════════════════════════════════════════════════

    async handleSettings(ctx) {
        try {
            const settings = await this.getCurrentSettings();

            const message = `
<b>🔧 Admin Settings</b>

<b>💰 OTP Prices:</b>
• Cheap OTP: <code>${formatCurrency(settings.cheapOtpPrice)}</code>
• VIP OTP: <code>${formatCurrency(settings.vipOtpPrice)}</code>

<b>👑 VIP Subscription:</b>
• Price: <code>${formatCurrency(settings.vipPrice)}</code>
• Duration: <code>${settings.vipDuration}</code> days

<b>🆓 Free Limits:</b>
• Daily: <code>${settings.freeDaily}</code> OTPs
• Per Number: <code>${settings.freePerNumber}</code>

<b>⚡ Providers:</b>
• Twilio: ${settings.twilioEnabled ? '✅' : '❌'}
• Telnyx: ${settings.telnyxEnabled ? '✅' : '❌'}
• Cheap Panel: ${settings.cheapPanelEnabled ? '✅' : '❌'}
• Free Public: ${settings.freePublicEnabled ? '✅' : '❌'}

<b>🛠 Maintenance:</b> ${settings.maintenanceMode ? '🔴 ON' : '🟢 OFF'}
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💰 OTP Prices', 'settings_prices')],
                [Markup.button.callback('👑 VIP Config', 'settings_vip')],
                [Markup.button.callback('🆓 Free Limits', 'settings_free')],
                [Markup.button.callback('⚡ Providers', 'settings_providers')],
                [Markup.button.callback('🛠 Maintenance', 'settings_maintenance')],
                [Markup.button.callback('🔙 Back', 'admin')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Settings error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load settings.</b>');
        }
    }

    async getCurrentSettings() {
        return {
            cheapOtpPrice: config.prices?.cheapOtp || 0.50,
            vipOtpPrice: config.prices?.vipOtp || 0.30,
            vipPrice: config.prices?.vipSubscription || 5.00,
            vipDuration: config.prices?.vipDuration || 30,
            freeDaily: config.limits?.freeDaily || 3,
            freePerNumber: config.limits?.freePerNumber || 1,
            twilioEnabled: config.providers?.twilio !== false,
            telnyxEnabled: config.providers?.telnyx !== false,
            cheapPanelEnabled: config.providers?.cheapPanel !== false,
            freePublicEnabled: config.providers?.freePublic !== false,
            maintenanceMode: config.maintenance || false
        };
    }

    // ─── Settings Submenus ───

    async handleSettingsPrices(ctx) {
        const currentCheap = formatCurrency(config.prices?.cheapOtp || 0.50);
        const currentVip = formatCurrency(config.prices?.vipOtp || 0.30);

        const message = `
<b>💰 Update OTP Prices</b>

<b>Current:</b>
• Cheap OTP: <code>${currentCheap}</code>
• VIP OTP: <code>${currentVip}</code>

<b>To update, use:</b>
<code>/setprice cheap &lt;amount&gt;</code>
<code>/setprice vip &lt;amount&gt;</code>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async handleSettingsVip(ctx) {
        const currentPrice = formatCurrency(config.prices?.vipSubscription || 5.00);
        const currentDuration = config.prices?.vipDuration || 30;

        const message = `
<b>👑 VIP Configuration</b>

<b>Current:</b>
• Price: <code>${currentPrice}</code>
• Duration: <code>${currentDuration}</code> days

<b>To update, use:</b>
<code>/setvip price &lt;amount&gt;</code>
<code>/setvip days &lt;number&gt;</code>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async handleSettingsFree(ctx) {
        const currentDaily = config.limits?.freeDaily || 3;
        const currentPerNumber = config.limits?.freePerNumber || 1;

        const message = `
<b>🆓 Free OTP Limits</b>

<b>Current:</b>
• Daily per user: <code>${currentDaily}</code>
• Per number: <code>${currentPerNumber}</code>

<b>To update, use:</b>
<code>/setfree daily &lt;number&gt;</code>
<code>/setfree pernumber &lt;number&gt;</code>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async handleSettingsProviders(ctx) {
        const twilio = config.providers?.twilio !== false ? '✅' : '❌';
        const telnyx = config.providers?.telnyx !== false ? '✅' : '❌';
        const cheapPanel = config.providers?.cheapPanel !== false ? '✅' : '❌';
        const freePublic = config.providers?.freePublic !== false ? '✅' : '❌';

        const message = `
<b>⚡ Provider Settings</b>

<b>Current Status:</b>
• Twilio: ${twilio}
• Telnyx: ${telnyx}
• Cheap Panel: ${cheapPanel}
• Free Public: ${freePublic}

<b>Toggle providers on/off:</b>
<code>/toggleprovider twilio</code>
<code>/toggleprovider telnyx</code>
<code>/toggleprovider cheappanel</code>
<code>/toggleprovider freepublic</code>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async handleSettingsMaintenance(ctx) {
        try {
            const current = config.maintenance || false;
            config.maintenance = !current;

            // Persist to DB immediately
            await this._saveSettings();

            // Notify other admins about the change
            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            for (const adminId of adminIds) {
                if (adminId === ctx.from.id.toString()) continue;
                await ctx.telegram.sendMessage(adminId, `
<b>🛠 Maintenance Mode ${!current ? 'ENABLED' : 'DISABLED'}</b>

Changed by admin: <code>${ctx.from.id}</code>

Users will ${!current ? 'see a maintenance message' : 'have normal access'}.
                `, { parse_mode: 'HTML' }).catch(() => {});
            }

            const message = `
<b>🛠 Maintenance Mode ${!current ? 'ENABLED' : 'DISABLED'}</b>

Users will ${!current ? 'see a maintenance message' : 'have normal access'}.

<i>Setting has been saved to database.</i>
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Back', 'admin_settings')]
            ]);

            await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });

            logger.info('Maintenance mode toggled', {
                admin: ctx.from.id,
                enabled: !current
            });
        } catch (error) {
            logger.error('Maintenance toggle error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to toggle maintenance mode.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SET COMMANDS (with DB Persistence)
    // ═══════════════════════════════════════════════════════════

    async handleSetPrice(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/setprice &lt;cheap|vip&gt; &lt;amount&gt;</code>');
        }

        const type = args[1].toLowerCase();
        const amount = parseFloat(args[2]);

        if (isNaN(amount) || amount < 0) {
            return this.replyError(ctx, '❌ <b>Invalid amount.</b>\n\nAmount must be a non-negative number.');
        }

        if (!config.prices) config.prices = {};

        if (type === 'cheap') {
            config.prices.cheapOtp = amount;
        } else if (type === 'vip') {
            config.prices.vipOtp = amount;
        } else {
            return this.replyError(ctx, '❌ <b>Invalid type.</b>\n\nUse: <code>cheap</code> or <code>vip</code>');
        }

        // Persist to DB
        await this._saveSettings();

        await this.replySuccess(ctx, `✅ <b>Price Updated!</b>\n\n${type === 'cheap' ? 'Cheap' : 'VIP'} OTP price set to <code>${formatCurrency(amount)}</code>\n\n<i>Saved to database.</i>`);

        await this.logAdminAction(
            ctx.from.id.toString(),
            'SET_PRICE',
            null,
            { type, amount }
        );
    }

    async handleSetVip(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/setvip &lt;price|days&gt; &lt;value&gt;</code>');
        }

        const type = args[1].toLowerCase();
        const value = parseFloat(args[2]);

        if (isNaN(value) || value < 0) {
            return this.replyError(ctx, '❌ <b>Invalid value.</b>\n\nValue must be a non-negative number.');
        }

        if (!config.prices) config.prices = {};

        if (type === 'price') {
            config.prices.vipSubscription = value;
        } else if (type === 'days') {
            config.prices.vipDuration = Math.floor(value);
        } else {
            return this.replyError(ctx, '❌ <b>Invalid type.</b>\n\nUse: <code>price</code> or <code>days</code>');
        }

        // Persist to DB
        await this._saveSettings();

        const displayValue = type === 'price' ? formatCurrency(value) : `${Math.floor(value)} days`;
        await this.replySuccess(ctx, `✅ <b>VIP Config Updated!</b>\n\nVIP ${type === 'price' ? 'price' : 'duration'} set to <code>${displayValue}</code>\n\n<i>Saved to database.</i>`);

        await this.logAdminAction(
            ctx.from.id.toString(),
            'SET_VIP',
            null,
            { type, value }
        );
    }

    async handleSetFree(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/setfree &lt;daily|pernumber&gt; &lt;number&gt;</code>');
        }

        const type = args[1].toLowerCase();
        const value = parseInt(args[2]);

        if (isNaN(value) || value < 0) {
            return this.replyError(ctx, '❌ <b>Invalid value.</b>\n\nValue must be a non-negative integer.');
        }

        if (!config.limits) config.limits = {};

        if (type === 'daily') {
            config.limits.freeDaily = value;
        } else if (type === 'pernumber') {
            config.limits.freePerNumber = value;
        } else {
            return this.replyError(ctx, '❌ <b>Invalid type.</b>\n\nUse: <code>daily</code> or <code>pernumber</code>');
        }

        // Persist to DB
        await this._saveSettings();

        const label = type === 'daily' ? 'daily limit' : 'per-number limit';
        await this.replySuccess(ctx, `✅ <b>Free Limits Updated!</b>\n\nFree ${label} set to <code>${value}</code>\n\n<i>Saved to database.</i>`);

        await this.logAdminAction(
            ctx.from.id.toString(),
            'SET_FREE',
            null,
            { type, value }
        );
    }

    async handleToggleProvider(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/toggleprovider &lt;twilio|telnyx|cheappanel|freepublic&gt;</code>');
        }

        const name = args[1].toLowerCase();
        const valid = ['twilio', 'telnyx', 'cheappanel', 'freepublic'];

        if (!valid.includes(name)) {
            return this.replyError(ctx, '❌ <b>Invalid provider name.</b>\n\nValid: <code>twilio, telnyx, cheappanel, freepublic</code>');
        }

        if (!config.providers) config.providers = {};

        const current = config.providers[name] !== false;
        config.providers[name] = !current;

        // Persist to DB
        await this._saveSettings();

        const status = !current ? '✅ Enabled' : '❌ Disabled';
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);

        await this.replySuccess(ctx, `✅ <b>Provider Updated!</b>\n\n${displayName}: <b>${status}</b>\n\n<i>Saved to database.</i>`);

        await this.logAdminAction(
            ctx.from.id.toString(),
            'TOGGLE_PROVIDER',
            null,
            { provider: name, enabled: !current }
        );
}
      // ═══════════════════════════════════════════════════════════
    //  DATA EXPORT COMMANDS
    // ═══════════════════════════════════════════════════════════

    async handleExportUsers(ctx) {
        try {
            const users = await User.find().lean();

            if (!users.length) {
                return this.replyError(ctx, '<b>📥 No users to export.</b>');
            }

            const headers = [
                'userId', 'username', 'firstName', 'lastName', 'balance',
                'lockedBalance', 'bundleRemaining', 'mode', 'vipExpiry',
                'isBlacklisted', 'referralCode', 'referredBy', 'referralCount',
                'createdAt', 'lastActive'
            ];

            const rows = users.map(u => headers.map(h => this.escapeCSV(u[h])).join(','));
            const csv = [headers.join(','), ...rows].join('\n');

            // Send as document if too long, otherwise as text
            if (csv.length > 4000) {
                const buffer = Buffer.from(csv, 'utf-8');
                await ctx.replyWithDocument(
                    { source: buffer, filename: `users_export_${Date.now()}.csv` },
                    { caption: '<b>📥 Users Export</b>', parse_mode: 'HTML' }
                );
            } else {
                await this.replySuccess(ctx, `<b>📥 Users Export</b>\n\n<pre>${csv.substring(0, 4000)}</pre>`);
            }

            await this.logAdminAction(ctx.from.id.toString(), 'EXPORT_USERS', null, { count: users.length });

        } catch (error) {
            logger.error('Export users error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to export users.</b>');
        }
    }

    async handleExportTransactions(ctx) {
        try {
            const args = ctx.message.text.split(' ');
            const startDate = args[1] ? new Date(args[1]) : new Date(0);
            const endDate = args[2] ? new Date(args[2]) : new Date();

            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                return this.replyError(ctx, '❌ <b>Invalid date format.</b>\n\nUsage: <code>/export_transactions [YYYY-MM-DD] [YYYY-MM-DD]</code>');
            }

            const transactions = await Transaction.find({
                createdAt: { $gte: startDate, $lte: endDate }
            }).lean();

            if (!transactions.length) {
                return this.replyError(ctx, '<b>📥 No transactions found for the given period.</b>');
            }

            const headers = ['txId', 'userId', 'type', 'amount', 'status', 'metadata', 'createdAt'];
            const rows = transactions.map(t => headers.map(h => {
                if (h === 'metadata') return this.escapeCSV(JSON.stringify(t[h] || {}));
                return this.escapeCSV(t[h]);
            }).join(','));

            const csv = [headers.join(','), ...rows].join('\n');

            if (csv.length > 4000) {
                const buffer = Buffer.from(csv, 'utf-8');
                await ctx.replyWithDocument(
                    { source: buffer, filename: `transactions_export_${Date.now()}.csv` },
                    { caption: '<b>📥 Transactions Export</b>', parse_mode: 'HTML' }
                );
            } else {
                await this.replySuccess(ctx, `<b>📥 Transactions Export</b>\n\n<pre>${csv.substring(0, 4000)}</pre>`);
            }

            await this.logAdminAction(ctx.from.id.toString(), 'EXPORT_TRANSACTIONS', null, { count: transactions.length, startDate, endDate });

        } catch (error) {
            logger.error('Export transactions error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to export transactions.</b>');
        }
    }

    // ─── CSV Escaping Helper ───
    escapeCSV(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
            }
                }

export default AdminCommands;
