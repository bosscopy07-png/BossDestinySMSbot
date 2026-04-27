import { Markup } from 'telegraf';
import { User, Session, Transaction, AdminLog, Settings } from '../../models/index.js';
import { generateId, formatCurrency } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

// ─── Image URLs ───
const IMG_SUCCESS = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';
const IMG_ERROR = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png';

// ─── Transaction type constants ───
const TX_TYPES = Object.freeze({
    CHEAP_OTP: 'CHEAP_OTP',
    BUNDLE_PURCHASE: 'BUNDLE_PURCHASE',
    VIP_SUBSCRIPTION: 'VIP_SUBSCRIPTION',
    DEPOSIT: 'DEPOSIT',
    REFERRAL_REWARD: 'REFERRAL_REWARD',
    ADMIN_ADD: 'ADMIN_ADD',
    ADMIN_DEDUCT: 'ADMIN_DEDUCT',
    WITHDRAWAL: 'WITHDRAWAL',
    REFUND: 'REFUND'
});

// ─── Admin state constants for button flows ───
const ADMIN_STATE = Object.freeze({
    NONE: 'none',
    AWAITING_BROADCAST: 'awaitingBroadcast',
    AWAITING_ADD_BALANCE: 'awaitingAddBalance',
    AWAITING_DEDUCT_BALANCE: 'awaitingDeductBalance',
    AWAITING_BLACKLIST_REASON: 'awaitingBlacklistReason',
    AWAITING_MESSAGE_USER: 'awaitingMessageUser',
    AWAITING_SEARCH_QUERY: 'awaitingSearchQuery',
    AWAITING_RESET_FREE_USER: 'awaitingResetFreeUser',
    AWAITING_GIVE_VIP_USER: 'awaitingGiveVipUser',
    AWAITING_GIVE_VIP_DAYS: 'awaitingGiveVipDays'
});

class AdminCommands {
    constructor(bot, walletService, referralService = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.referralService = referralService;
        this.admins = new Set();
        this._registerCommands();
        this._registerTextHandlers();
        this._registerButtonFlows();
        this._loadSettings();
    }

    // ─── Session helper ───
    _ensureSession(ctx) {
        if (!ctx.session) ctx.session = {};
        if (!ctx.session.adminState) ctx.session.adminState = { state: ADMIN_STATE.NONE, data: {} };
    }

    _setAdminState(ctx, state, data = {}) {
        this._ensureSession(ctx);
        ctx.session.adminState = { state, data, timestamp: Date.now() };
    }

    _clearAdminState(ctx) {
        this._ensureSession(ctx);
        ctx.session.adminState = { state: ADMIN_STATE.NONE, data: {} };
    }

    _getAdminState(ctx) {
        this._ensureSession(ctx);
        return ctx.session.adminState;
    }

    // ─── Load persisted settings on init ───
    async _loadSettings() {
        try {
            const settings = await Settings.findOne().lean();
            if (settings) {
                const { _id, __v, ...settingsData } = settings;
                Object.assign(config, settingsData);
                logger.info('Admin settings loaded from DB');
            }
        } catch (error) {
            logger.warn('Failed to load settings from DB', { error: error.message });
        }
    }

    // ─── Persist settings to DB ───
    async _saveSettings() {
        try {
            const settingsToSave = { ...config };
            delete settingsToSave._id;
            delete settingsToSave.__v;

            const allowedKeys = ['prices', 'limits', 'providers', 'maintenance', 'registrationOpen', 'broadcast', 'referral'];
            const cleaned = {};
            for (const key of allowedKeys) {
                if (settingsToSave[key] !== undefined) {
                    cleaned[key] = settingsToSave[key];
                }
            }

            await Settings.findOneAndUpdate(
                {},
                { $set: cleaned },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            logger.info('Admin settings saved to DB');
        } catch (error) {
            logger.error('Failed to save settings', { error: error.message });
            throw error;
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

    // ─── Maintenance middleware ───
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

    // ═══════════════════════════════════════════════════════════
    //  NEW FEATURE: BUTTON FLOWS REGISTRATION
    // ═══════════════════════════════════════════════════════════

    _registerButtonFlows() {
        // ─── Dashboard extra buttons ───
        this.bot.action('admin_search', this.requireAdmin, this.handleSearchUserMenu.bind(this));
        this.bot.action('admin_topusers', this.requireAdmin, this.handleTopUsers.bind(this));
        this.bot.action('admin_dailyreport', this.requireAdmin, this.handleDailyReport.bind(this));
        this.bot.action('admin_resetfree', this.requireAdmin, this.handleResetFreeMenu.bind(this));
        this.bot.action('admin_givevip', this.requireAdmin, this.handleGiveVipMenu.bind(this));

        // ─── Search flow ───
        this.bot.action('search_by_id', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SEARCH_QUERY, { mode: 'id' });
            return this.replySuccess(ctx, '🔍 <b>Search by User ID</b>\n\nSend the user ID to search:');
        });
        this.bot.action('search_by_username', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SEARCH_QUERY, { mode: 'username' });
            return this.replySuccess(ctx, '🔍 <b>Search by Username</b>\n\nSend the username to search (without @):');
        });
        this.bot.action('search_by_name', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SEARCH_QUERY, { mode: 'name' });
            return this.replySuccess(ctx, '🔍 <b>Search by Name</b>\n\nSend the name to search:');
        });
        this.bot.action('search_cancel', this.requireAdmin, (ctx) => {
            this._clearAdminState(ctx);
            return this.handleAdmin(ctx);
        });

        // ─── Reset Free flow ───
        this.bot.action('resetfree_search', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_RESET_FREE_USER, { mode: 'search' });
            return this.replySuccess(ctx, '🔄 <b>Reset Free OTPs</b>\n\nSend the user ID to reset:');
        });
        this.bot.action('resetfree_from_users', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_RESET_FREE_USER, { mode: 'from_list' });
            return this.handleUsers(ctx);
        });
        this.bot.action('resetfree_cancel', this.requireAdmin, (ctx) => {
            this._clearAdminState(ctx);
            return this.handleAdmin(ctx);
        });
        this.bot.action(/resetfree_confirm_(.+)/, this.requireAdmin, (ctx) => {
            const userId = ctx.match[1];
            return this.executeResetFree(ctx, userId);
        });

        // ─── Give VIP flow ───
        this.bot.action('givevip_search', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_GIVE_VIP_USER, { mode: 'search' });
            return this.replySuccess(ctx, '👑 <b>Grant VIP</b>\n\nSend the user ID to grant VIP:');
        });
        this.bot.action('givevip_from_users', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_GIVE_VIP_USER, { mode: 'from_list' });
            return this.handleUsers(ctx);
        });
        this.bot.action('givevip_cancel', this.requireAdmin, (ctx) => {
            this._clearAdminState(ctx);
            return this.handleAdmin(ctx);
        });
        this.bot.action(/givevip_confirm_(.+)/, this.requireAdmin, (ctx) => {
            const userId = ctx.match[1];
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_GIVE_VIP_DAYS, { userId });
            return this.replySuccess(ctx, `👑 <b>Grant VIP to ${userId}</b>\n\nSend the number of days:`);
        });

        // ─── Quick action from user detail ───
        this.bot.action(/quick_resetfree_(.+)/, this.requireAdmin, (ctx) => {
            return this.executeResetFree(ctx, ctx.match[1]);
        });
        this.bot.action(/quick_givevip_(.+)/, this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_GIVE_VIP_DAYS, { userId: ctx.match[1] });
            return this.replySuccess(ctx, `👑 <b>Grant VIP to ${ctx.match[1]}</b>\n\nSend the number of days:`);
        });
                        }
        _registerTextHandlers() {
        this.bot.on('text', async (ctx, next) => {
            this._ensureSession(ctx);

            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            if (!adminIds.includes(ctx.from.id.toString())) {
                return next();
            }

            const { state, data } = this._getAdminState(ctx);

            // ─── Awaiting broadcast message ───
            if (ctx.session.awaitingBroadcast) {
                const { target, filter, label } = ctx.session.awaitingBroadcast;
                delete ctx.session.awaitingBroadcast;
                this._clearAdminState(ctx);
                return this.executeBroadcast(ctx, filter, label, ctx.message.text);
            }

            // ─── Awaiting add balance amount ───
            if (ctx.session.awaitingAddBalance) {
                const targetId = ctx.session.awaitingAddBalance;
                delete ctx.session.awaitingAddBalance;
                this._clearAdminState(ctx);
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
                this._clearAdminState(ctx);
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
                this._clearAdminState(ctx);
                const reason = ctx.message.text.trim().toLowerCase() === 'skip'
                    ? 'Manual blacklist'
                    : ctx.message.text.trim();
                return this.processBlacklist(ctx, targetId, reason);
            }

            // ─── Awaiting message to user ───
            if (ctx.session.awaitingMessageUser) {
                const targetId = ctx.session.awaitingMessageUser;
                delete ctx.session.awaitingMessageUser;
                this._clearAdminState(ctx);
                return this.processMessageUser(ctx, targetId, ctx.message.text);
            }

            // ═══════════════════════════════════════════════════════
            //  NEW FEATURE: BUTTON FLOW HANDLERS
            // ═══════════════════════════════════════════════════════

            // ─── Search query ───
            if (state === ADMIN_STATE.AWAITING_SEARCH_QUERY) {
                this._clearAdminState(ctx);
                return this.executeSearch(ctx, ctx.message.text.trim(), data.mode);
            }

            // ─── Reset Free user ID ───
            if (state === ADMIN_STATE.AWAITING_RESET_FREE_USER) {
                const userId = ctx.message.text.trim();
                this._clearAdminState(ctx);
                return this.showResetFreeConfirm(ctx, userId);
            }

            // ─── Give VIP user ID ───
            if (state === ADMIN_STATE.AWAITING_GIVE_VIP_USER) {
                const userId = ctx.message.text.trim();
                this._clearAdminState(ctx);
                return this.showGiveVipDaysInput(ctx, userId);
            }

            // ─── Give VIP days ───
            if (state === ADMIN_STATE.AWAITING_GIVE_VIP_DAYS) {
                const days = parseInt(ctx.message.text.trim());
                this._clearAdminState(ctx);
                if (isNaN(days) || days <= 0) {
                    return this.replyError(ctx, '❌ <b>Invalid days.</b>\n\nMust be a positive integer.');
                }
                return this.executeGiveVip(ctx, data.userId, days);
            }

            return next();
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  DASHBOARD (Updated with new feature buttons)
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
                ],
                // ─── NEW FEATURE BUTTONS ───
                [
                    Markup.button.callback('🔍 Search', 'admin_search'),
                    Markup.button.callback('🏆 Top Users', 'admin_topusers')
                ],
                [
                    Markup.button.callback('📊 Daily Report', 'admin_dailyreport'),
                    Markup.button.callback('🔄 Reset Free', 'admin_resetfree')
                ],
                [
                    Markup.button.callback('👑 Give VIP', 'admin_givevip')
                ]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Admin dashboard error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load admin dashboard.</b>\n\nPlease check the logs for details.');
        }
}
                        // ═══════════════════════════════════════════════════════════
    //  NEW FEATURE: SEARCH USER (Button Flow)
    // ═══════════════════════════════════════════════════════════

    async handleSearchUserMenu(ctx) {
        const message = `
<b>🔍 Search Users</b>

Select search method:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆔 By User ID', 'search_by_id')],
            [Markup.button.callback('👤 By Username', 'search_by_username')],
            [Markup.button.callback('📝 By Name', 'search_by_name')],
            [Markup.button.callback('❌ Cancel', 'search_cancel')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async executeSearch(ctx, query, mode) {
        try {
            let searchConditions = [];

            if (mode === 'id') {
                searchConditions.push({ userId: query });
            } else if (mode === 'username') {
                searchConditions.push({ username: { $regex: query, $options: 'i' } });
            } else if (mode === 'name') {
                searchConditions.push(
                    { firstName: { $regex: query, $options: 'i' } },
                    { lastName: { $regex: query, $options: 'i' } }
                );
            }

            const users = await User.find({ $or: searchConditions }).limit(10).lean();

            if (!users.length) {
                return this.replyError(ctx, '🔍 <b>No users found.</b>\n\nTry a different search term.', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔍 Search Again', 'admin_search')],
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            let message = `<b>🔍 Search Results</b> (${users.length} found)\n\n`;
            const buttons = [];

            for (const user of users) {
                const status = user.isBlacklisted ? '🔴' :
                    (user.vipExpiry && new Date(user.vipExpiry) > new Date()) ? '👑' :
                        user.balance > 0 ? '💰' : '🆓';

                const displayName = user.username ? `@${user.username}` : (user.firstName || 'Unknown');
                message += `${status} <b>${displayName}</b> — <code>${user.userId}</code>\n`;
                message += `   Balance: <code>${formatCurrency(user.balance)}</code>\n\n`;

                buttons.push([Markup.button.callback(
                    `${status} View ${displayName.substring(0, 20)}`,
                    `user_detail_${user.userId}`
                )]);
            }

            buttons.push([Markup.button.callback('🔍 Search Again', 'admin_search')]);
            buttons.push([Markup.button.callback('🔙 Back to Admin', 'admin')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Search user error', { error: error.message, query, mode });
            await this.replyError(ctx, '❌ <b>Search failed.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NEW FEATURE: TOP USERS (Button)
    // ═══════════════════════════════════════════════════════════

    async handleTopUsers(ctx) {
        try {
            const topUsers = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION] },
                        status: 'COMPLETED'
                    }
                },
                {
                    $group: {
                        _id: '$userId',
                        totalSpent: { $sum: { $abs: '$amount' } }
                    }
                },
                { $sort: { totalSpent: -1 } },
                { $limit: 10 }
            ]);

            if (!topUsers.length) {
                return this.replyError(ctx, '<b>📊 No spending data yet.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            const userIds = topUsers.map(u => u._id);
            const users = await User.find({ userId: { $in: userIds } })
                .select('userId username firstName balance')
                .lean();

            const userMap = new Map(users.map(u => [u.userId, u]));

            let message = '<b>🏆 Top 10 Users by Spending</b>\n\n';

            for (let i = 0; i < topUsers.length; i++) {
                const tu = topUsers[i];
                const u = userMap.get(tu._id);
                const name = u?.username ? `@${u.username}` : (u?.firstName || tu._id);
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
                message += `${medal} <b>${name}</b>\n`;
                message += `   Spent: <code>${formatCurrency(tu.totalSpent)}</code> | Balance: <code>${formatCurrency(u?.balance || 0)}</code>\n\n`;
            }

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Top users error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load top users.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NEW FEATURE: DAILY REPORT (Button)
    // ═══════════════════════════════════════════════════════════

    async handleDailyReport(ctx) {
        try {
            const now = new Date();
            const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

            const [
                newUsers,
                activeUsers,
                completedSessions,
                revenue,
                topServices
            ] = await Promise.all([
                User.countDocuments({ createdAt: { $gte: dayAgo } }),
                User.countDocuments({ lastActive: { $gte: dayAgo } }),
                Session.countDocuments({ status: 'RECEIVED', startTime: { $gte: dayAgo } }),
                this.calculateRevenue(dayAgo),
                Session.aggregate([
                    { $match: { status: 'RECEIVED', startTime: { $gte: dayAgo } } },
                    { $group: { _id: '$service', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 5 }
                ])
            ]);

            const topServicesText = topServices.length
                ? topServices.map(s => `• ${s._id}: <code>${s.count}</code>`).join('\n')
                : '<i>No data</i>';

            const message = `
<b>📊 Daily Report</b> (<code>${dayAgo.toLocaleDateString()}</code> — <code>${now.toLocaleDateString()}</code>)

<b>👥 Users:</b>
• New: <code>${newUsers}</code>
• Active: <code>${activeUsers}</code>

<b>📈 Sessions:</b>
• Completed: <code>${completedSessions}</code>

<b>💰 Revenue:</b> <code>${formatCurrency(revenue)}</code>

<b>🔥 Top Services:</b>
${topServicesText}
            `;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'admin_dailyreport')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

            await this.logAdminAction(ctx.from.id.toString(), 'DAILY_REPORT', null, { revenue, newUsers, activeUsers });

        } catch (error) {
            logger.error('Daily report error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to generate daily report.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NEW FEATURE: RESET FREE OTPs (Button Flow)
    // ═══════════════════════════════════════════════════════════

    async handleResetFreeMenu(ctx) {
        const message = `
<b>🔄 Reset Free OTPs</b>

Choose how to select the user:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆔 Enter User ID', 'resetfree_search')],
            [Markup.button.callback('👥 Pick from User List', 'resetfree_from_users')],
            [Markup.button.callback('❌ Cancel', 'resetfree_cancel')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async showResetFreeConfirm(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user) {
                return this.replyError(ctx, `❌ <b>User not found:</b> <code>${userId}</code>`, {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'admin_resetfree')],
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            const displayName = user.username ? `@${user.username}` : (user.firstName || userId);

            const message = `
<b>🔄 Confirm Reset Free OTPs</b>

<b>User:</b> <code>${displayName}</code>
<b>ID:</b> <code>${userId}</code>
<b>Current Free Used:</b> <code>${user.freeUsedToday || 0}</code>/3

Are you sure you want to reset their free OTP count?
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Yes, Reset', `resetfree_confirm_${userId}`)],
                [Markup.button.callback('❌ Cancel', 'admin_resetfree')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Reset free confirm error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to load user.</b>');
        }
    }

    async executeResetFree(ctx, userId) {
        try {
            await User.updateOne(
                { userId },
                { $set: { freeUsedToday: 0, freeResetDate: new Date() } }
            );

            await this.logAdminAction(ctx.from.id.toString(), 'RESET_FREE', userId, {});

            await this.replySuccess(ctx, `✅ <b>Free OTP Reset!</b>\n\nUser: <code>${userId}</code>\nDaily free count has been reset to 0.`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Reset Another', 'admin_resetfree')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

            await ctx.telegram.sendMessage(userId, `
<b>🔄 Free OTP Reset</b>

Your daily free OTP count has been reset by an admin.

You can now use your free OTPs again.
            `, { parse_mode: 'HTML' }).catch(() => {});

        } catch (error) {
            logger.error('Reset free error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to reset free OTPs.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NEW FEATURE: GIVE VIP (Button Flow)
    // ═══════════════════════════════════════════════════════════

    async handleGiveVipMenu(ctx) {
        const message = `
<b>👑 Grant VIP Status</b>

Choose how to select the user:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆔 Enter User ID', 'givevip_search')],
            [Markup.button.callback('👥 Pick from User List', 'givevip_from_users')],
            [Markup.button.callback('❌ Cancel', 'givevip_cancel')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async showGiveVipDaysInput(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user) {
                return this.replyError(ctx, `❌ <b>User not found:</b> <code>${userId}</code>`, {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'admin_givevip')],
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            const displayName = user.username ? `@${user.username}` : (user.firstName || userId);
            const currentVip = user.vipExpiry && new Date(user.vipExpiry) > new Date()
                ? `Until ${new Date(user.vipExpiry).toLocaleDateString()}`
                : 'Inactive';

            const message = `
<b>👑 Grant VIP to ${displayName}</b>

<b>ID:</b> <code>${userId}</code>
<b>Current VIP:</b> ${currentVip}

Send the number of days to grant:
            `;

            await this.replySuccess(ctx, message);
        } catch (error) {
            logger.error('Give VIP days input error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to load user.</b>');
        }
    }

    async executeGiveVip(ctx, userId, days) {
        try {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + days);

            await User.updateOne(
                { userId },
                { $set: { vipExpiry: expiry } }
            );

            await Transaction.create({
                txId: generateId(),
                userId,
                type: TX_TYPES.VIP_SUBSCRIPTION,
                amount: 0,
                status: 'COMPLETED',
                metadata: { adminId: ctx.from.id.toString(), grantedDays: days, expiry },
                createdAt: new Date()
            });

            await this.logAdminAction(ctx.from.id.toString(), 'GIVE_VIP', userId, { days, expiry });

            await this.replySuccess(ctx, `👑 <b>VIP Granted!</b>\n\nUser: <code>${userId}</code>\nDuration: <code>${days}</code> days\nExpires: <code>${expiry.toLocaleDateString()}</code>`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('👑 Grant Another', 'admin_givevip')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

            await ctx.telegram.sendMessage(userId, `
<b>👑 VIP Status Granted!</b>

You have been granted VIP status for <code>${days}</code> days.

<b>Expires:</b> <code>${expiry.toLocaleDateString()}</code>

Enjoy premium benefits!
            `, { parse_mode: 'HTML' }).catch(() => {});

        } catch (error) {
            logger.error('Give VIP error', { error: error.message, userId, days });
            await this.replyError(ctx, '❌ <b>Failed to grant VIP.</b>');
        }
    }
            async showUserDetailInline(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();

            if (!user) {
                return this.replyError(ctx, '❌ <b>User not found.</b>');
            }

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
                    { $match: { userId, status: { $in: ['COMPLETED', 'completed'] } } },
                    {
                        $group: {
                            _id: null,
                            totalSpent: {
                                $sum: {
                                    $cond: [
                                        { $in: ['$type', [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION]] },
                                        { $abs: '$amount' },
                                        0
                                    ]
                                }
                            },
                            totalDeposited: {
                                $sum: {
                                    $cond: [{ $eq: ['$type', TX_TYPES.DEPOSIT] }, '$amount', 0]
                                }
                            },
                            totalRefEarnings: {
                                $sum: {
                                    $cond: [{ $eq: ['$type', TX_TYPES.REFERRAL_REWARD] }, '$amount', 0]
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
                // ─── NEW QUICK ACTIONS ───
                [
                    Markup.button.callback('🔄 Reset Free', `quick_resetfree_${userId}`),
                    Markup.button.callback('👑 Give VIP', `quick_givevip_${userId}`)
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
                const emoji = tx.status === 'COMPLETED' || tx.status === 'completed' ? '✅' : tx.status === 'PENDING' || tx.status === 'pending' ? '⏳' : '❌';
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
    //  BALANCE OPERATIONS (FIXED ENUM VALUES + processedBy)
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
                    type: TX_TYPES.ADMIN_ADD,
                    amount,
                    status: 'COMPLETED',
                    processedBy: ctx.from.id.toString(),
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
        this._ensureSession(ctx);
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
                    type: TX_TYPES.ADMIN_DEDUCT,
                    amount: -amount,
                    status: 'COMPLETED',
                    processedBy: ctx.from.id.toString(),
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
        this._ensureSession(ctx);
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
        this._ensureSession(ctx);
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
        this._ensureSession(ctx);
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
<i>SWIFTSMS — The fastest SMS Service. Contact us if you need assistance.</i>
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
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION] },
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
            return results.map(r => `• ${r._id}: <code>${formatCurrency(r.revenue)}</code> (${r.count} OTPs)`).joi
