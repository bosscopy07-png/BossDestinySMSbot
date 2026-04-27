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

    // ─── Persist settings to DB ───
    async _saveSettings() {
        try {
            await Settings.findOneAndUpdate(
                {},
                { $set: config },
                { upsert: true, new: true }
            );
        } catch (error) {
            logger.error('Failed to save settings', { error: error.message });
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
                               
