
import { Markup } from 'telegraf';
import { User, Session, Transaction, AdminLog, Settings, Number as NumberModel } from '../../models/index.js';
import { generateId, formatCurrency } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

// ─── Image URLs ───
const IMG_SUCCESS = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';
const IMG_ERROR = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png';
const requireAdmin = (ctx, next) => this.requireAdmin(ctx, next);

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
    REFUND: 'REFUND',
    POOL_PURCHASE: 'POOL_PURCHASE',
    NUMBER_RETIRE: 'NUMBER_RETIRE',
    NUMBER_ASSIGN: 'NUMBER_ASSIGN',
    NUMBER_RELEASE: 'NUMBER_RELEASE'
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
    AWAITING_GIVE_VIP_DAYS: 'awaitingGiveVipDays',
    AWAITING_POOL_PURCHASE_COUNTRY: 'awaitingPoolPurchaseCountry',
    AWAITING_POOL_PURCHASE_QTY: 'awaitingPoolPurchaseQty',
    AWAITING_POOL_PURCHASE_PROVIDER: 'awaitingPoolPurchaseProvider',
    AWAITING_CANCEL_VIP_USER: 'awaitingCancelVipUser',
    AWAITING_SET_BUNDLE_PRICE: 'awaitingSetBundlePrice',
    AWAITING_SET_BUNDLE_OTP_PRICE: 'awaitingSetBundleOtpPrice',
    AWAITING_RETIRE_NUMBER: 'awaitingRetireNumber',
    AWAITING_BROADCAST_MESSAGE: 'awaitingBroadcastMessage',
    AWAITING_CUSTOM_BROADCAST_FILTER: 'awaitingCustomBroadcastFilter'
});

// ─── Number status constants ───
const NUMBER_STATUS = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    ASSIGNED: 'ASSIGNED',
    RESERVED: 'RESERVED',
    RETIRED: 'RETIRED',
    EXPIRED: 'EXPIRED'
});

class AdminCommands {
    constructor(bot, walletService, referralService = null, smsProviderManager = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.referralService = referralService;
        this.smsProviderManager = smsProviderManager;
        this.admins = new Set();
        this._commandCooldowns = new Map(); // Rate limiting storage
        this._registerCommands();
        this._registerTextHandlers();
        this._registerButtonFlows();
        this._loadSettings().catch(err => {
            logger.warn('Admin settings init load failed', { error: err.message });
        });
    }

    // ─── Rate limiting helper ───
    _checkCooldown(userId, command, ms = 2000) {
        const key = `${userId}:${command}`;
        const last = this._commandCooldowns.get(key);
        const now = Date.now();
        if (last && (now - last) < ms) {
            return false;
        }
        this._commandCooldowns.set(key, now);
        // Cleanup old entries periodically
        if (this._commandCooldowns.size > 1000) {
            const cutoff = now - 60000;
            for (const [k, v] of this._commandCooldowns) {
                if (v < cutoff) this._commandCooldowns.delete(k);
            }
        }
        return true;
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

            const allowedKeys = ['prices', 'limits', 'providers', 'maintenance', 'registrationOpen', 'broadcast', 'referral', 'pool'];
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
        // ─── Admin middleware ───
    requireAdmin() {
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
        
        // Pool management commands
        this.bot.command('buypool', this.requireAdmin, this.handleBuyPoolCommand.bind(this));
        this.bot.command('poolstats', this.requireAdmin, this.handlePoolStatsCommand.bind(this));
        this.bot.command('cancelvip', this.requireAdmin, this.handleCancelVipCommand.bind(this));
        this.bot.command('setbundleprice', this.requireAdmin, this.handleSetBundlePriceCommand.bind(this));
        this.bot.command('retire_number', this.requireAdmin, this.handleRetireNumberCommand.bind(this));

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
        this.bot.action('broadcast_custom', this.requireAdmin, this.handleBroadcastCustom.bind(this));
        this.bot.action('broadcast_cancel', this.requireAdmin, this.handleBroadcastCancel.bind(this));

        // Settings submenus
        this.bot.action('settings_prices', this.requireAdmin, this.handleSettingsPrices.bind(this));
        this.bot.action('settings_vip', this.requireAdmin, this.handleSettingsVip.bind(this));
        this.bot.action('settings_free', this.requireAdmin, this.handleSettingsFree.bind(this));
        this.bot.action('settings_providers', this.requireAdmin, this.handleSettingsProviders.bind(this));
        this.bot.action('settings_maintenance', this.requireAdmin, this.handleSettingsMaintenance.bind(this));
        this.bot.action('settings_pool', this.requireAdmin, this.handleSettingsPool.bind(this));

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
    //  BUTTON FLOWS REGISTRATION
    // ═══════════════════════════════════════════════════════════

    _registerButtonFlows() {
        // ─── Dashboard extra buttons ───
        this.bot.action('admin_search', this.requireAdmin, this.handleSearchUserMenu.bind(this));
        this.bot.action('admin_topusers', this.requireAdmin, this.handleTopUsers.bind(this));
        this.bot.action('admin_dailyreport', this.requireAdmin, this.handleDailyReport.bind(this));
        this.bot.action('admin_resetfree', this.requireAdmin, this.handleResetFreeMenu.bind(this));
        this.bot.action('admin_givevip', this.requireAdmin, this.handleGiveVipMenu.bind(this));
                                                                                                                            
        // ═════════════════════════════════════════════════════════════════
        //  ADMIN POOL MANAGEMENT — Fixed requireAdmin binding
        // ═════════════════════════════════════════════════════════════════

        this.bot.action('admin_pool', requireAdmin, this.handlePoolMenu.bind(this));
        this.bot.action('pool_buy_numbers', requireAdmin, this.handlePoolBuyMenu.bind(this));
        this.bot.action('pool_monitor', requireAdmin, this.handlePoolMonitor.bind(this));
        this.bot.action('pool_retire', requireAdmin, this.handlePoolRetireMenu.bind(this));
        this.bot.action('pool_vip_users', requireAdmin, this.handlePoolVipUsers.bind(this));
        
        this.bot.action('pool_provider_twilio', requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, 'twilio'));
        this.bot.action('pool_provider_telnyx', requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, 'telnyx'));
        this.bot.action('pool_provider_any', requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, 'any'));
        
        this.bot.action(/adminpool_co_(.+)/, requireAdmin, (ctx) => {
            const country = ctx.match[1];
            return this.handlePoolCountrySelect(ctx, country);
        });
        
        this.bot.action(/pool_qty_(\d+)/, requireAdmin, (ctx) => {
            const qty = parseInt(ctx.match[1]);
            return this.handlePoolQuantitySelect(ctx, qty);
        });
        
        this.bot.action('confirm_pool_purchase', requireAdmin, this.executePoolPurchase.bind(this));



        
        // Cancel VIP flow
        this.bot.action('cancelvip_search', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_CANCEL_VIP_USER, { mode: 'search' });
            return this.replySuccess(ctx, '❌ <b>Cancel VIP Subscription</b>\n\nSend the user ID to cancel VIP:');
        });
        this.bot.action('cancelvip_from_users', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_CANCEL_VIP_USER, { mode: 'from_list' });
            return this.handleUsers(ctx);
        });
        this.bot.action(/cancelvip_confirm_(.+)/, this.requireAdmin, (ctx) => {
            return this.executeCancelVip(ctx, ctx.match[1]);
        });
        
        // Bundle price setting
        this.bot.action('set_bundle_otp_prices', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SET_BUNDLE_OTP_PRICE);
            return this.replySuccess(ctx, 
                '💰 <b>Set Bundle OTP Prices</b>\n\n' +
                'Send prices in format:\n' +
                '<code>5:0.50,10:0.90,25:2.00,50:3.50</code>\n\n' +
                'Format: quantity:price,quantity:price'
            );
        });
        this.bot.action('set_bundle_pack_price', this.requireAdmin, (ctx) => {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SET_BUNDLE_PRICE);
            return this.replySuccess(ctx, 
                '💰 <b>Set Bundle Pack Price</b>\n\n' +
                'Send price and count:\n' +
                '<code>price:5.00,count:100</code>'
            );
        });

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
        
   // BEFORE (collides with 5Sim):
// this.bot.action(/pool_country_(.+)/, (ctx) => { ... });

// AFTER (unique prefix):
this.bot.action(/numpool_country_(.+)/, (ctx) => {
    const countryCode = ctx.match[1];
    return this.handlePoolCountryButton(ctx, countryCode);
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
        
        // Quick cancel VIP from user detail
        this.bot.action(/quick_cancelvip_(.+)/, this.requireAdmin, (ctx) => {
            return this.executeCancelVip(ctx, ctx.match[1]);
        });

        // ─── NEW: Number inventory buttons ───
        this.bot.action('number_inventory_all', this.requireAdmin, (ctx) => this.handleNumberInventoryList(ctx, 'all'));
        this.bot.action('number_inventory_available', this.requireAdmin, (ctx) => this.handleNumberInventoryList(ctx, 'available'));
        this.bot.action('number_inventory_assigned', this.requireAdmin, (ctx) => this.handleNumberInventoryList(ctx, 'assigned'));
        this.bot.action('number_inventory_retired', this.requireAdmin, (ctx) => this.handleNumberInventoryList(ctx, 'retired'));
        this.bot.action(/number_detail_(.+)/, this.requireAdmin, (ctx) => {
            return this.showNumberDetail(ctx, ctx.match[1]);
        });
        this.bot.action(/number_retire_confirm_(.+)/, this.requireAdmin, (ctx) => {
            return this.executeRetireNumber(ctx, ctx.match[1]);
        });

        // ─── NEW: Bulk actions ───
        this.bot.action('bulk_broadcast', this.requireAdmin, this.handleBulkBroadcastMenu.bind(this));
        this.bot.action('bulk_add_balance', this.requireAdmin, this.handleBulkAddBalanceMenu.bind(this));
        this.bot.action('bulk_give_vip', this.requireAdmin, this.handleBulkGiveVipMenu.bind(this));
        this.bot.action('bulk_reset_free', this.requireAdmin, this.handleBulkResetFreeMenu.bind(this));

        // ─── NEW: Analytics ───
        this.bot.action('admin_healthcheck', this.requireAdmin, this.handleHealthCheck.bind(this));

        this.bot.action('analytics_revenue', this.requireAdmin, this.handleAnalyticsRevenue.bind(this));
        this.bot.action('analytics_users', this.requireAdmin, this.handleAnalyticsUsers.bind(this));
        this.bot.action('analytics_services', this.requireAdmin, this.handleAnalyticsServices.bind(this));
        this.bot.action('analytics_retention', this.requireAdmin, this.handleAnalyticsRetention.bind(this));
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

            // ─── Awaiting broadcast message (legacy session key) ───
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
            //  BUTTON FLOW HANDLERS
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

            // Pool purchase country
            if (state === ADMIN_STATE.AWAITING_POOL_PURCHASE_COUNTRY) {
                const country = ctx.message.text.trim().toUpperCase();
                this._clearAdminState(ctx);
                if (country.length !== 2) {
                    return this.replyError(ctx, '❌ <b>Invalid country code.</b>\n\nMust be 2 letters (e.g., US, GB, CA).');
                }
                ctx.session.poolPurchase = { ...ctx.session.poolPurchase, country };
                this._setAdminState(ctx, ADMIN_STATE.AWAITING_POOL_PURCHASE_QTY, { country });
                return this.replySuccess(ctx, 
                    '📦 <b>Pool Purchase</b>\n\n' +
                    `Country: <code>${country}</code>\n\n` +
                    'Send quantity to purchase (1-50):'
                );
            }

            // Pool purchase quantity
            if (state === ADMIN_STATE.AWAITING_POOL_PURCHASE_QTY) {
                const qty = parseInt(ctx.message.text.trim());
                this._clearAdminState(ctx);
                if (isNaN(qty) || qty < 1 || qty > 50) {
                    return this.replyError(ctx, '❌ <b>Invalid quantity.</b>\n\nMust be 1-50.');
                }
                ctx.session.poolPurchase = { ...ctx.session.poolPurchase, quantity: qty };
                return this.showPoolPurchaseConfirm(ctx);
            }

            // Cancel VIP user ID
            if (state === ADMIN_STATE.AWAITING_CANCEL_VIP_USER) {
                const userId = ctx.message.text.trim();
                this._clearAdminState(ctx);
                return this.showCancelVipConfirm(ctx, userId);
            }

            // Set bundle OTP prices
            if (state === ADMIN_STATE.AWAITING_SET_BUNDLE_OTP_PRICE) {
                this._clearAdminState(ctx);
                return this.processSetBundleOtpPrices(ctx, ctx.message.text.trim());
            }

            // Set bundle pack price
            if (state === ADMIN_STATE.AWAITING_SET_BUNDLE_PRICE) {
                this._clearAdminState(ctx);
                return this.processSetBundlePackPrice(ctx, ctx.message.text.trim());
            }

            // NEW: Retire number
            if (state === ADMIN_STATE.AWAITING_RETIRE_NUMBER) {
                this._clearAdminState(ctx);
                return this.processRetireNumber(ctx, ctx.message.text.trim());
            }

            // NEW: Custom broadcast filter
            if (state === ADMIN_STATE.AWAITING_CUSTOM_BROADCAST_FILTER) {
                this._clearAdminState(ctx);
                return this.executeBroadcast(ctx, {}, 'Custom Filter', ctx.message.text);
            }

            return next();
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  SYSTEM STATS HELPER
    // ═══════════════════════════════════════════════════════════

    async getSystemStats() {
        try {
            const now = new Date();
            const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
            const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
            const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

            const [
                revenue24h,
                revenue7d,
                revenue30d,
                totalUsers,
                payingUsers,
                vipUsers,
                activeToday,
                otpRequests24h,
                otpSuccess24h,
                otpFailed24h,
                totalNumbers,
                availableNumbers,
                assignedNumbers
            ] = await Promise.all([
                this.calculateRevenue(dayAgo),
                this.calculateRevenue(weekAgo),
                this.calculateRevenue(monthAgo),
                User.countDocuments(),
                User.countDocuments({ balance: { $gt: 0 } }),
                User.countDocuments({ vipExpiry: { $gt: now } }),
                User.countDocuments({ lastActive: { $gte: dayAgo } }),
                Session.countDocuments({ startTime: { $gte: dayAgo } }),
                Session.countDocuments({ status: 'RECEIVED', startTime: { $gte: dayAgo } }),
                Session.countDocuments({ status: { $in: ['TIMEOUT', 'CANCELLED', 'FAILED'] }, startTime: { $gte: dayAgo } }),
                NumberModel?.countDocuments?.() || Promise.resolve(0),
                NumberModel?.countDocuments?.({ status: NUMBER_STATUS.AVAILABLE }) || Promise.resolve(0),
                NumberModel?.countDocuments?.({ status: NUMBER_STATUS.ASSIGNED }) || Promise.resolve(0)
            ]);

            const successRate24h = otpRequests24h > 0 ? ((otpSuccess24h / otpRequests24h) * 100).toFixed(1) : 0;

            let masterBalance = 0;
            try {
                if (this.walletService?.getMasterBalance) {
                    const bal = await this.walletService.getMasterBalance();
                    masterBalance = typeof bal?.usdt === 'number' ? bal.usdt : 0;
                }
            } catch (error) {
                logger.warn('Failed to get master balance for stats', { error: error.message });
            }

            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const mins = Math.floor((uptime % 3600) / 60);

            return {
                revenue24h,
                revenue7d,
                revenue30d,
                totalUsers,
                payingUsers,
                vipUsers,
                activeToday,
                otpRequests24h,
                otpSuccess24h,
                otpFailed24h,
                successRate24h,
                masterBalance,
                uptime: `${hours}h ${mins}m`,
                totalNumbers,
                availableNumbers,
                assignedNumbers
            };
        } catch (error) {
            logger.error('Get system stats error', { error: error.message, stack: error.stack });
            return {
                revenue24h: 0, revenue7d: 0, revenue30d: 0,
                totalUsers: 0, payingUsers: 0, vipUsers: 0, activeToday: 0,
                otpRequests24h: 0, otpSuccess24h: 0, otpFailed24h: 0,
                successRate24h: 0, masterBalance: 0, uptime: '0h 0m',
                totalNumbers: 0, availableNumbers: 0, assignedNumbers: 0
            };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  REVENUE CALCULATOR
    // ═══════════════════════════════════════════════════════════

    async calculateRevenue(since) {
        try {
            const result = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE] },
                        status: 'COMPLETED',
                        createdAt: { $gte: since }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: { $abs: '$amount' } }
                    }
                }
            ]);
            return result[0]?.total || 0;
        } catch (error) {
            logger.error('Calculate revenue error', { error: error.message, since });
            return 0;
        }
    }
    // Add to _registerButtonFlows()
    
    // Add method
    async handleHealthCheck(ctx) {
        const checks = [];
        
        // Check free providers
        const freeProviders = ['smsreceivefree.com', 'receive-smss.com'];
        for (const provider of freeProviders) {
            try {
                await fetch(`https://${provider}`, { method: 'HEAD', timeout: 5000 });
                checks.push(`✅ ${provider}`);
            } catch (e) {
                checks.push(`❌ ${provider}: ${e.message}`);
            }
        }

        // Check pool
        checks.push(this.smsProviderManager?.numberPool ? '✅ Number Pool' : '❌ Number Pool: not configured');

        // Check 5SIM/cheap panel
        try {
            if (this.smsProviderManager?.cheapProvider?.getBalance) {
                await this.smsProviderManager.cheapProvider.getBalance();
                checks.push('✅ Cheap Panel');
            } else {
                checks.push('⚠️ Cheap Panel: no getBalance method');
            }
        } catch (e) {
            checks.push(`❌ Cheap Panel: ${e.message}`);
        }

        const message = `<b>🏥 Provider Health Check</b>\n\n${checks.join('\n')}`;

        await this.replySuccess(ctx, message, {
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'admin_healthcheck')],
                [Markup.button.callback('🔙 Back', 'admin')]
            ]).reply_markup
        });
    }
    
    // ═══════════════════════════════════════════════════════════
    //  DASHBOARD (Updated with new feature buttons)
    // ═══════════════════════════════════════════════════════════

    async handleAdmin(ctx) {
    try {
        if (!this._checkCooldown(ctx.from.id, 'admin', 3000)) {
            return ctx.answerCbQuery?.('Please wait...').catch(() => {});
        }

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

<b>📦 Number Pool</b>
• Total: <code>${stats.totalNumbers}</code>
• Available: <code>${stats.availableNumbers}</code>
• Assigned: <code>${stats.assignedNumbers}</code>

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
            [
                Markup.button.callback('🔍 Search', 'admin_search'),
                Markup.button.callback('🏆 Top Users', 'admin_topusers')
            ],
            [
                Markup.button.callback('📊 Daily Report', 'admin_dailyreport'),
                Markup.button.callback('🔄 Reset Free', 'admin_resetfree')
            ],
            [
                Markup.button.callback('👑 Give VIP', 'admin_givevip'),
                Markup.button.callback('❌ Cancel VIP', 'admin_cancelvip')
            ],
            [
                Markup.button.callback('📦 Pool', 'admin_pool'),
                Markup.button.callback('💰 Bundle Prices', 'admin_bundleprices')
            ],
            [
                Markup.button.callback('📱 Numbers', 'admin_numberinventory'),
                Markup.button.callback('📊 Analytics', 'admin_analytics')
            ],
            [
                Markup.button.callback('⚡ Bulk Actions', 'admin_bulkactions')
            ],
            // ═══════════════════════════════════════════════════
            //  NEW: Advanced Admin Tools Button
            // ═══════════════════════════════════════════════════
            [
                Markup.button.callback('🛠️ Advanced Tools', 'open_admin_dashboard')
            ]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    } catch (error) {
        logger.error('Admin dashboard error', { error: error.message, stack: error.stack });
        await this.replyError(ctx, '❌ <b>Failed to load admin dashboard.</b>\n\nPlease check the logs for details.');
    }
    }
    
                    
    // ═══════════════════════════════════════════════════════════
    //  POOL MANAGEMENT
    // ═══════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════════════════
    //  ADMIN POOL PURCHASE — FULL REWRITE
    //  Flow: Provider → Available Countries+Prices → Pick Country → 
    //        Quantity → Balance Check → Confirm → Purchase
    // ═══════════════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════
    //  POOL MANAGEMENT — COMPLETE REWRITE
    //  Flow: Menu → Buy → Provider → Countries+Prices → Country → 
    //        Quantity → Balance Check → Confirm → Execute
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Show pool management menu
     */
    async handlePoolMenu(ctx) {
        try {
            const stats = this.smsProviderManager?.getPoolStats?.() || { available: false, pools: {} };
            
            let poolSummary = '';
            if (stats.pools) {
                for (const [country, data] of Object.entries(stats.pools)) {
                    poolSummary += `• ${country}: <code>${data.available || 0}</code> avail / <code>${data.active || 0}</code> act\n`;
                }
            }

            const message = `
<b>📦 Number Pool Management</b>

<b>Quick Stats:</b>
${poolSummary || '<i>No pool data</i>'}

Manage your Twilio/Telnyx number pool:
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🛒 Buy Numbers', 'pool_buy_numbers')],
                [Markup.button.callback('📊 Pool Monitor', 'pool_monitor')],
                [Markup.button.callback('👥 VIP Users', 'pool_vip_users')],
                [Markup.button.callback('🗑 Retire Numbers', 'pool_retire')],
                [Markup.button.callback('🔙 Back', 'admin')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Pool menu error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load pool menu.</b>');
        }
    }

    /**
     * Step 1: Show provider selection with balance info
     */
    async handlePoolBuyMenu(ctx) {
        if (!this.smsProviderManager) {
            return this.replyError(ctx, '❌ <b>Pool not available.</b>\n\nSMS Provider Manager not configured.');
        }

        // Check provider balances
        let balanceInfo = '';
        try {
            const balances = await this.smsProviderManager.checkBalances();
            
            if (balances['TWILIO']?.success) {
                const bal = balances['TWILIO'].balance;
                balanceInfo += `🏢 Twilio: <code>${bal > 900 ? 'Post-paid' : '$' + bal.toFixed(2)}</code>\n`;
            }
            if (balances['TELNYX']?.success) {
                const bal = balances['TELNYX'].balance;
                balanceInfo += `🏢 Telnyx: <code>${bal > 900 ? 'Post-paid' : '$' + bal.toFixed(2)}</code>\n`;
            }
            if (balances['CHEAP_PANEL']?.success) {
                balanceInfo += `💰 5SIM: <code>${balances['CHEAP_PANEL'].balance.toFixed(2)} ${balances['CHEAP_PANEL'].currency}</code>\n`;
            }
        } catch (e) {
            balanceInfo = '<i>Balance check unavailable</i>';
        }

        const message = `
<b>🛒 Buy Numbers for Pool</b>

<b>Provider Balances:</b>
${balanceInfo || '<i>Unknown</i>'}

Select provider to see available countries and prices:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🏢 Twilio', 'pool_provider_twilio')],
            [Markup.button.callback('🏢 Telnyx', 'pool_provider_telnyx')],
            [Markup.button.callback('🎲 Any Available', 'pool_provider_any')],
            [Markup.button.callback('🔙 Back', 'admin_pool')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    /**
     * Step 2: Provider selected — fetch available countries + prices
     */
    async handlePoolProviderSelect(ctx, provider) {
        ctx.session = ctx.session || {};
        ctx.session.poolPurchase = { preferredProvider: provider };
        this._setAdminState(ctx, 'AWAITING_POOL_COUNTRY', { provider });

        const providerUpper = provider?.toUpperCase() || 'ANY';
        let availabilityInfo = '';
        let countryButtons = [];
        let availableCountries = [];

        try {
            if (this.smsProviderManager) {
                const targetProvider = providerUpper === 'ANY' 
                    ? null 
                    : this.smsProviderManager.getProvider(providerUpper);

                if (targetProvider && typeof targetProvider.hasAvailableNumbers === 'function') {
                    const checkCountries = [
                        { code: 'US', flag: '🇺🇸', name: 'United States' },
                        { code: 'CA', flag: '🇨🇦', name: 'Canada' },
                        { code: 'GB', flag: '🇬🇧', name: 'United Kingdom' },
                        { code: 'AU', flag: '🇦🇺', name: 'Australia' },
                        { code: 'DE', flag: '🇩🇪', name: 'Germany' },
                        { code: 'FR', flag: '🇫🇷', name: 'France' },
                        { code: 'ES', flag: '🇪🇸', name: 'Spain' },
                        { code: 'IT', flag: '🇮🇹', name: 'Italy' },
                        { code: 'NL', flag: '🇳🇱', name: 'Netherlands' },
                        { code: 'SE', flag: '🇸🇪', name: 'Sweden' },
                        { code: 'IE', flag: '🇮🇪', name: 'Ireland' },
                        { code: 'PL', flag: '🇵🇱', name: 'Poland' },
                        { code: 'BE', flag: '🇧🇪', name: 'Belgium' },
                        { code: 'AT', flag: '🇦🇹', name: 'Austria' },
                        { code: 'PT', flag: '🇵🇹', name: 'Portugal' },
                        { code: 'DK', flag: '🇩🇰', name: 'Denmark' },
                        { code: 'FI', flag: '🇫🇮', name: 'Finland' },
                        { code: 'NO', flag: '🇳🇴', name: 'Norway' },
                        { code: 'CH', flag: '🇨🇭', name: 'Switzerland' },
                        { code: 'NZ', flag: '🇳🇿', name: 'New Zealand' },
                        { code: 'JP', flag: '🇯🇵', name: 'Japan' },
                        { code: 'SG', flag: '🇸🇬', name: 'Singapore' },
                        { code: 'HK', flag: '🇭🇰', name: 'Hong Kong' },
                        { code: 'BR', flag: '🇧🇷', name: 'Brazil' },
                        { code: 'MX', flag: '🇲🇽', name: 'Mexico' },
                        { code: 'ZA', flag: '🇿🇦', name: 'South Africa' },
                        { code: 'IN', flag: '🇮🇳', name: 'India' },
                        { code: 'AE', flag: '🇦🇪', name: 'UAE' },
                        { code: 'IL', flag: '🇮🇱', name: 'Israel' },
                        { code: 'TR', flag: '🇹🇷', name: 'Turkey' }
                    ];

                    for (const country of checkCountries) {
                        try {
                            const hasStock = await targetProvider.hasAvailableNumbers(country.code);
                            if (hasStock) {
                                const cost = targetProvider.estimateMonthlyCost?.(country.code) || 1.00;
                                availableCountries.push({ ...country, cost });
                            }
                        } catch (e) {
                            // Skip unavailable
                        }
                    }
                } else if (providerUpper === 'ANY') {
                    // Check both providers
                    const twilio = this.smsProviderManager.getProvider('TWILIO');
                    const telnyx = this.smsProviderManager.getProvider('TELNYX');
                    
                    const checkCountries = ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE'];
                    
                    for (const code of checkCountries) {
                        let hasStock = false;
                        let cost = 1.00;
                        let providerName = '';
                        
                        try {
                            if (twilio?.isActive && await twilio.hasAvailableNumbers(code)) {
                                hasStock = true;
                                cost = twilio.estimateMonthlyCost?.(code) || 1.00;
                                providerName = 'Twilio';
                            }
                        } catch (e) {}
                        
                        if (!hasStock && telnyx?.isActive) {
                            try {
                                if (await telnyx.hasAvailableNumbers(code)) {
                                    hasStock = true;
                                    cost = telnyx.estimateMonthlyCost?.(code) || 1.50;
                                    providerName = 'Telnyx';
                                }
                            } catch (e) {}
                        }
                        
                        if (hasStock) {
                            const flagMap = {
                                'US': '🇺🇸', 'CA': '🇨🇦', 'GB': '🇬🇧', 'AU': '🇦🇺',
                                'DE': '🇩🇪', 'FR': '🇫🇷', 'ES': '🇪🇸', 'IT': '🇮🇹',
                                'NL': '🇳🇱', 'SE': '🇸🇪'
                            };
                            availableCountries.push({
                                code,
                                flag: flagMap[code] || '🏳️',
                                name: code,
                                cost,
                                provider: providerName
                            });
                        }
                    }
                }
            }
        } catch (e) {
            logger.error('Pool availability check failed', { provider, error: e.message });
        }

        // Build display and buttons
        if (availableCountries.length > 0) {
            const rows = [];
            for (let i = 0; i < availableCountries.length; i += 2) {
                const row = [];
                row.push(Markup.button.callback(
                    `${availableCountries[i].flag} ${availableCountries[i].code} (~$${availableCountries[i].cost.toFixed(2)})`,
                    `adminpool_co_${availableCountries[i].code}`
                ));
                if (availableCountries[i + 1]) {
                    row.push(Markup.button.callback(
                        `${availableCountries[i + 1].flag} ${availableCountries[i + 1].code} (~$${availableCountries[i + 1].cost.toFixed(2)})`,
                        `adminpool_co_${availableCountries[i + 1].code}`
                    ));
                }
                rows.push(row);
            }
            countryButtons = rows;

            availabilityInfo = availableCountries.map(c => 
                `${c.flag} <b>${c.code}</b>: ~$${c.cost.toFixed(2)}/mo${c.provider ? ` (${c.provider})` : ''}`
            ).join('\n');
        } else {
            availabilityInfo = '<i>No countries available from this provider right now.</i>\n\nYou can still try sending any 2-letter country code.';
        }

        countryButtons.push([Markup.button.callback('✏️ Type Custom Code', 'adminpool_co_custom')]);
        countryButtons.push([Markup.button.callback('🔙 Back', 'pool_buy_numbers')]);

        const message = `
<b>🛒 Buy Numbers — ${providerUpper}</b>

<b>Available Countries with Prices:</b>
${availabilityInfo}

<i>Tap a country or type a custom 2-letter code</i>
        `;

        await this.replySuccess(ctx, message, {
            reply_markup: Markup.inlineKeyboard(countryButtons).reply_markup,
            parse_mode: 'HTML'
        });
    }

    /**
     * Step 3: Country selected from button
     */
    async handlePoolCountryButton(ctx, countryCode) {
        return this.handlePoolCountrySelect(ctx, countryCode);
    }

    /**
     * Step 3: Country selected — ask for quantity
     */
    async handlePoolCountrySelect(ctx, country) {
        ctx.session.poolPurchase = { ...ctx.session.poolPurchase, country };
        this._setAdminState(ctx, 'AWAITING_POOL_QTY', { country });

        let priceEstimate = '';
        try {
            const provider = ctx.session.poolPurchase.preferredProvider;
            const providerInstance = provider && provider !== 'any'
                ? this.smsProviderManager?.getProvider(provider.toUpperCase())
                : null;
            
            if (providerInstance?.estimateMonthlyCost) {
                const cost = providerInstance.estimateMonthlyCost(country);
                priceEstimate = `\n💰 Est. cost: <code>~$${cost.toFixed(2)}</code> per number/month`;
            }
        } catch (e) {}

        const message = `
<b>🛒 Buy Numbers — ${ctx.session.poolPurchase.preferredProvider?.toUpperCase() || 'ANY'}</b>

🌍 Country: <code>${country}</code>${priceEstimate}

How many numbers do you want?
        `;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('1️⃣  1', 'pool_qty_1'),
                Markup.button.callback('5️⃣  5', 'pool_qty_5'),
                Markup.button.callback('🔟  10', 'pool_qty_10')
            ],
            [
                Markup.button.callback('2️⃣0️⃣  20', 'pool_qty_20'),
                Markup.button.callback('5️⃣0️⃣  50', 'pool_qty_50'),
                Markup.button.callback('1️⃣0️⃣0️⃣  100', 'pool_qty_100')
            ],
            [
                Markup.button.callback('✏️ Custom Amount', 'pool_qty_custom')
            ],
            [
                Markup.button.callback('🔙 Back', 'pool_buy_numbers'),
                Markup.button.callback('❌ Cancel', 'admin_pool')
            ]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    /**
     * Step 4: Quantity selected
     */
    async handlePoolQuantitySelect(ctx, qty) {
        ctx.session.poolPurchase = { ...ctx.session.poolPurchase, quantity: parseInt(qty) || 1 };
        return this.showPoolPurchaseConfirm(ctx);
    }

    /**
     * Step 5: Show confirmation with balance check
     */
    async showPoolPurchaseConfirm(ctx) {
        const purchase = ctx.session.poolPurchase;
        if (!purchase?.country || !purchase?.quantity) {
            return this.replyError(ctx, '❌ <b>Invalid purchase data.</b>\n\nPlease start over.');
        }

        let totalEstimate = 0;
        let providerBalance = null;
        
        try {
            const providerName = purchase.preferredProvider === 'any' 
                ? 'TWILIO' 
                : purchase.preferredProvider.toUpperCase();
            
            const providerInstance = this.smsProviderManager?.getProvider(providerName);
            if (providerInstance?.estimateMonthlyCost) {
                totalEstimate = providerInstance.estimateMonthlyCost(purchase.country) * purchase.quantity;
            } else {
                totalEstimate = purchase.quantity * 1.50;
            }

            const balanceCheck = await this.smsProviderManager?.hasSufficientBalance?.(providerName, totalEstimate);
            providerBalance = balanceCheck;
        } catch (e) {
            logger.warn('Balance check failed for confirmation', { error: e.message });
        }

        const balanceWarning = providerBalance && !providerBalance.sufficient
            ? `\n\n⚠️ <b>Warning:</b> ${providerBalance.reason}\nAvailable: $${providerBalance.available?.toFixed(2) || 0}\nRequired: ~$${totalEstimate.toFixed(2)}`
            : '';

        const message = `
<b>✅ Confirm Pool Purchase</b>

🏢 Provider: <code>${(purchase.preferredProvider || 'any').toUpperCase()}</code>
🌍 Country: <code>${purchase.country}</code>
📦 Quantity: <code>${purchase.quantity}</code>
💰 Est. Total: <code>~$${totalEstimate.toFixed(2)}</code>${balanceWarning}

Proceed with purchase?
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_pool_purchase')],
            [Markup.button.callback('🔙 Back', `pool_country_${purchase.country}`)],
            [Markup.button.callback('❌ Cancel', 'admin_pool')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    /**
     * Step 6: Execute purchase with balance validation
     */
    async executePoolPurchase(ctx) {
        const purchase = ctx.session?.poolPurchase;
        if (!purchase) {
            return this.replyError(ctx, '❌ <b>Session expired.</b>\n\nPlease start over.');
        }

        try {
            const providerName = purchase.preferredProvider === 'any' 
                ? null 
                : purchase.preferredProvider.toUpperCase();

            // Calculate estimated cost
            let estimatedCost = 0;
            try {
                const p = providerName ? this.smsProviderManager?.getProvider(providerName) : null;
                if (p?.estimateMonthlyCost) {
                    estimatedCost = p.estimateMonthlyCost(purchase.country) * purchase.quantity;
                } else {
                    estimatedCost = purchase.quantity * 1.50;
                }
            } catch (e) {
                estimatedCost = purchase.quantity * 1.50;
            }

            // Check provider balance before purchase
            if (providerName && this.smsProviderManager?.hasSufficientBalance) {
                const balanceCheck = await this.smsProviderManager.hasSufficientBalance(
                    providerName, 
                    estimatedCost
                );
                
                if (!balanceCheck.sufficient) {
                    ctx.session.poolPurchase = null;
                    return this.replyError(ctx, 
                        `❌ <b>Insufficient ${providerName} Balance</b>\n\n` +
                        `💰 Required: ~$${estimatedCost.toFixed(2)}\n` +
                        `💳 Available: $${balanceCheck.available?.toFixed(2) || 0}\n\n` +
                        `Please top up your ${providerName} account before purchasing.`, {
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('🔄 Try Again', 'pool_buy_numbers')],
                                [Markup.button.callback('🔙 Back', 'admin_pool')]
                            ]).reply_markup
                        });
                }
            }

            // Execute purchase
            const result = await this.smsProviderManager.buyPoolNumbers(
                purchase.country,
                purchase.quantity,
                purchase.preferredProvider
            );

            ctx.session.poolPurchase = null;

            if (result.purchased?.length > 0) {
                // Store purchased numbers
                for (const num of result.purchased) {
                    try {
                        await NumberModel.create({
                            numberId: generateId(),
                            phoneNumber: num.phoneNumber,
                            provider: num.provider,
                            country: purchase.country,
                            status: 'AVAILABLE',
                            purchasedAt: new Date(),
                            cost: num.cost || 0,
                            metadata: num
                        });
                    } catch (dbError) {
                        logger.warn('Failed to store number in DB', { 
                            phone: num.phoneNumber, 
                            error: dbError.message 
                        });
                    }
                }

                const numbersList = result.purchased.map(n => 
                    `• <code>${n.phoneNumber}</code> (${n.provider})`
                ).join('\n');

                const actualCost = result.totalCost || (result.purchased.length * 1.00);

                                const message = `
<b>✅ Pool Purchase Complete!</b>

🏢 Provider: <code>${purchase.preferredProvider?.toUpperCase() || 'ANY'}</code>
🌍 Country: <code>${purchase.country}</code>
📦 Purchased: <code>${result.purchased.length}</code> numbers
❌ Failed: <code>${result.failed || 0}</code>
💰 Total Cost: <code>$${actualCost.toFixed(2)}</code>

<b>Numbers:</b>
${numbersList}
                `;

                await this.replySuccess(ctx, message, {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🛒 Buy More', 'pool_buy_numbers')],
                        [Markup.button.callback('📊 Pool Monitor', 'pool_monitor')],
                        [Markup.button.callback('🔙 Back', 'admin_pool')]
                    ]).reply_markup
                });

                await this.logAdminAction(
                    ctx.from.id.toString(),
                    'POOL_PURCHASE',
                    null,
                    { 
                        country: purchase.country, 
                        quantity: purchase.quantity, 
                        purchased: result.purchased.length,
                        provider: purchase.preferredProvider,
                        cost: actualCost
                    }
                );
            } else {
                await this.replyError(ctx, 
                    `❌ <b>Purchase Failed</b>\n\nNo numbers were purchased.\nError: ${result.errors?.[0]?.error || 'Unknown error'}`, {
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔄 Retry', 'pool_buy_numbers')],
                            [Markup.button.callback('🔙 Back', 'admin_pool')]
                        ]).reply_markup
                    });
            }
        } catch (error) {
            ctx.session.poolPurchase = null;
            logger.error('Pool purchase failed', { error: error.message, purchase });
            await this.replyError(ctx, `❌ <b>Purchase Failed:</b> ${error.message}`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Retry', 'pool_buy_numbers')],
                    [Markup.button.callback('🔙 Back', 'admin_pool')]
                ]).reply_markup
            });
        }
    }
                
    async handlePoolMonitor(ctx) {
        try {
            if (!this.smsProviderManager?.numberPool) {
                return this.replyError(ctx, '❌ <b>Pool not available.</b>');
            }

            const stats = this.smsProviderManager.getPoolStats();
            const detailed = this.smsProviderManager.numberPool?.getDetailedStats?.();

            let message = `
<b>📊 Pool Monitor</b>

<b>Pool Status:</b> ${stats.available ? '✅ Active' : '❌ Inactive'}
            `;

            if (stats.pools) {
                message += '\n\n<b>By Country:</b>\n';
                for (const [country, data] of Object.entries(stats.pools)) {
                    message += `• ${country}: <code>${data.available}</code> available / <code>${data.active}</code> active / <code>${data.total}</code> total\n`;
                }
            }

            if (detailed) {
                message += `\n<b>Total Active Assignments:</b> <code>${detailed.totalActive || 0}</code>\n`;
                message += `<b>Max Hold Time:</b> <code>${detailed.maxHoldMinutes || 30}</code> min\n`;
                
                if (detailed.activeAssignments?.length > 0) {
                    message += '\n<b>Active Assignments (top 5):</b>\n';
                    detailed.activeAssignments.slice(0, 5).forEach(a => {
                        message += `• <code>${a.phone}</code> | ${a.country} | ${a.service} | ${a.heldMinutes}min\n`;
                    });
                }
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'pool_monitor')],
                [Markup.button.callback('🛒 Buy Numbers', 'pool_buy_numbers')],
                [Markup.button.callback('🔙 Back', 'admin_pool')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Pool monitor error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load pool stats.</b>');
        }
    }

    async handlePoolVipUsers(ctx) {
        try {
            const vipUsers = await User.find({
                vipExpiry: { $gt: new Date() },
                vipPhoneNumber: { $ne: null }
            }).select('userId username firstName vipPhoneNumber vipProvider vipExpiry vipNumberAssignedAt').lean();

            if (!vipUsers.length) {
                return this.replyError(ctx, '<b>👥 No VIP users with assigned numbers.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', 'admin_pool')]
                    ]).reply_markup
                });
            }

            let message = `<b>👑 VIP Users with Numbers</b> (${vipUsers.length} total)\n\n`;
            const buttons = [];

            for (const user of vipUsers) {
                const daysLeft = Math.ceil((new Date(user.vipExpiry) - new Date()) / (1000 * 60 * 60 * 24));
                const displayName = user.username ? `@${user.username}` : (user.firstName || user.userId);
                
                message += `👑 <b>${displayName}</b>\n`;
                message += `   📞 <code>${user.vipPhoneNumber}</code> (${user.vipProvider})\n`;
                message += `   ⏰ ${daysLeft} days left | ID: <code>${user.userId}</code>\n\n`;

                buttons.push([Markup.button.callback(
                    `❌ Cancel VIP ${displayName.substring(0, 15)}`,
                    `quick_cancelvip_${user.userId}`
                )]);
            }

            buttons.push([Markup.button.callback('🔙 Back', 'admin_pool')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Pool VIP users error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load VIP users.</b>');
        }
    }

    async handlePoolRetireMenu(ctx) {
        await this.replySuccess(ctx, 
            '<b>🗑 Retire Numbers</b>\n\nSelect a number from inventory or use /retire_number &lt;number_id&gt;',
            { reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('📱 View Inventory', 'number_inventory_all')],
                [Markup.button.callback('📊 Go to Monitor', 'pool_monitor')],
                [Markup.button.callback('🔙 Back', 'admin_pool')]
            ]).reply_markup }
        );
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER INVENTORY (NEW FEATURE)
    // ═══════════════════════════════════════════════════════════

    async handleNumberInventory(ctx) {
        const message = `
<b>📱 Number Inventory</b>

View and manage all numbers in the system:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📋 All Numbers', 'number_inventory_all')],
            [Markup.button.callback('✅ Available', 'number_inventory_available')],
            [Markup.button.callback('🔒 Assigned', 'number_inventory_assigned')],
            [Markup.button.callback('🗑 Retired', 'number_inventory_retired')],
            [Markup.button.callback('🔙 Back', 'admin')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async handleNumberInventoryList(ctx, filter) {
        try {
            const query = {};
            if (filter !== 'all') query.status = filter.toUpperCase();

            const numbers = await NumberModel.find(query)
                .sort({ updatedAt: -1 })
                .limit(20)
                .lean();

            if (!numbers.length) {
                return this.replyError(ctx, `<b>📱 No ${filter} numbers found.</b>`, {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', 'admin_numberinventory')]
                    ]).reply_markup
                });
            }

            let message = `<b>📱 ${filter.charAt(0).toUpperCase() + filter.slice(1)} Numbers</b> (${numbers.length} shown)\n\n`;
            const buttons = [];

            for (const num of numbers) {
                const statusEmoji = num.status === NUMBER_STATUS.AVAILABLE ? '✅' :
                    num.status === NUMBER_STATUS.ASSIGNED ? '🔒' :
                    num.status === NUMBER_STATUS.RETIRED ? '🗑' : '⚪';

                message += `${statusEmoji} <code>${num.phoneNumber}</code>\n`;
                message += `   ${num.provider} | ${num.country} | ${num.status}\n`;
                if (num.assignedTo) message += `   👤 <code>${num.assignedTo}</code>\n`;
                message += '\n';

                buttons.push([Markup.button.callback(
                    `🔍 ${num.phoneNumber}`,
                    `number_detail_${num.numberId}`
                )]);
            }

            buttons.push([Markup.button.callback('🔙 Back', 'admin_numberinventory')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Number inventory error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load number inventory.</b>');
        }
    }

    async showNumberDetail(ctx, numberId) {
        try {
            const num = await NumberModel.findOne({ numberId }).lean();
            if (!num) {
                return this.replyError(ctx, '❌ <b>Number not found.</b>');
            }

            const message = `
<b>📱 Number Detail</b>

<b>Phone:</b> <code>${num.phoneNumber}</code>
<b>Provider:</b> <code>${num.provider}</code>
<b>Country:</b> <code>${num.country}</code>
<b>Status:</b> <code>${num.status}</code>
<b>Purchased:</b> <code>${num.purchasedAt ? new Date(num.purchasedAt).toLocaleDateString() : 'N/A'}</code>
<b>Cost:</b> <code>${formatCurrency(num.cost || 0)}</code>
${num.assignedTo ? `<b>Assigned To:</b> <code>${num.assignedTo}</code>\n` : ''}
${num.assignedAt ? `<b>Assigned At:</b> <code>${new Date(num.assignedAt).toLocaleDateString()}</code>\n` : ''}
${num.retiredAt ? `<b>Retired At:</b> <code>${new Date(num.retiredAt).toLocaleDateString()}</code>\n` : ''}
            `;

            const buttons = [];
            if (num.status !== NUMBER_STATUS.RETIRED) {
                buttons.push([Markup.button.callback('🗑 Retire Number', `number_retire_confirm_${num.numberId}`)]);
            }
            buttons.push([Markup.button.callback('🔙 Back', 'number_inventory_all')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Number detail error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load number detail.</b>');
        }
    }

    async handleRetireNumberCommand(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/retire_number &lt;number_id&gt;</code>');
        }
        return this.executeRetireNumber(ctx, args[1]);
    }

    async executeRetireNumber(ctx, numberId) {
        try {
            const num = await NumberModel.findOne({ numberId });
            if (!num) {
                return this.replyError(ctx, `❌ <b>Number not found:</b> <code>${numberId}</code>`);
            }

            if (num.status === NUMBER_STATUS.RETIRED) {
                return this.replyError(ctx, `❌ <b>Number already retired:</b> <code>${numberId}</code>`);
            }

            // Release from provider if assigned
            if (num.status === NUMBER_STATUS.ASSIGNED && this.smsProviderManager?.numberPool) {
                try {
                    await this.smsProviderManager.numberPool.releaseNumber(numberId, 'ADMIN_RETIRED');
                } catch (e) {
                    logger.warn('Failed to release from provider pool', { numberId, error: e.message });
                }
            }

            // Update user if assigned
            if (num.assignedTo) {
                await User.updateOne(
                    { userId: num.assignedTo },
                    { $unset: { vipPhoneNumber: 1, vipNumberId: 1, vipProvider: 1 } }
                );
            }

            await NumberModel.updateOne(
                { numberId },
                {
                    $set: {
                        status: NUMBER_STATUS.RETIRED,
                        retiredAt: new Date(),
                        retiredBy: ctx.from.id.toString()
                    }
                }
            );

            await Transaction.create({
                txId: generateId(),
                type: TX_TYPES.NUMBER_RETIRE,
                amount: 0,
                status: 'COMPLETED',
                metadata: { numberId, phoneNumber: num.phoneNumber, adminId: ctx.from.id.toString() },
                createdAt: new Date()
            });

            await this.logAdminAction(
                ctx.from.id.toString(),
                'RETIRE_NUMBER',
                num.assignedTo,
                { numberId, phoneNumber: num.phoneNumber }
            );

            await this.replySuccess(ctx, `🗑 <b>Number Retired!</b>\n\n<code>${num.phoneNumber}</code> has been retired.`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Inventory', 'admin_numberinventory')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

        } catch (error) {
            logger.error('Retire number error', { error: error.message, numberId });
            await this.replyError(ctx, '❌ <b>Failed to retire number.</b>');
        }
    }

    async processRetireNumber(ctx, input) {
        // Input can be numberId or phone number
        const num = await NumberModel.findOne({
            $or: [{ numberId: input }, { phoneNumber: input }]
        }).lean();

        if (!num) {
            return this.replyError(ctx, `❌ <b>Number not found:</b> <code>${input}</code>`);
        }

        return this.executeRetireNumber(ctx, num.numberId);
                                                   }


                // ═══════════════════════════════════════════════════════════
    //  CANCEL VIP
    // ═══════════════════════════════════════════════════════════

    async handleCancelVipMenu(ctx) {
        const message = `
<b>❌ Cancel VIP Subscription</b>

Choose how to select the user:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆔 Enter User ID', 'cancelvip_search')],
            [Markup.button.callback('👥 Pick from User List', 'cancelvip_from_users')],
            [Markup.button.callback('🔙 Back', 'admin')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async handleCancelVipCommand(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/cancelvip &lt;user_id&gt;</code>');
        }
        return this.showCancelVipConfirm(ctx, args[1]);
    }

    async showCancelVipConfirm(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user) {
                return this.replyError(ctx, `❌ <b>User not found:</b> <code>${userId}</code>`);
            }

            if (!user.vipExpiry || new Date(user.vipExpiry) <= new Date()) {
                return this.replyError(ctx, `❌ <b>User is not VIP:</b> <code>${userId}</code>`);
            }

            const displayName = user.username ? `@${user.username}` : (user.firstName || userId);
            const daysLeft = Math.ceil((new Date(user.vipExpiry) - new Date()) / (1000 * 60 * 60 * 24));

            const message = `
<b>❌ Confirm Cancel VIP</b>

<b>User:</b> <code>${displayName}</code>
<b>ID:</b> <code>${userId}</code>
<b>Number:</b> <code>${user.vipPhoneNumber || 'N/A'}</code>
<b>Expires:</b> <code>${new Date(user.vipExpiry).toLocaleDateString()}</code>
<b>Days Left:</b> <code>${daysLeft}</code>

⚠️ This will immediately release their dedicated number and remove VIP status.
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Yes, Cancel VIP', `cancelvip_confirm_${userId}`)],
                [Markup.button.callback('❌ No, Keep VIP', 'admin_cancelvip')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Cancel VIP confirm error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to load user.</b>');
        }
    }

    async executeCancelVip(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user?.vipExpiry || new Date(user.vipExpiry) <= new Date()) {
                return this.replyError(ctx, `❌ <b>User is not VIP or already expired.</b>`);
            }

            // Release VIP number via pool manager
            if (this.smsProviderManager?.numberPool && user.vipNumberId) {
                try {
                    await this.smsProviderManager.numberPool.releaseNumber(user.vipNumberId, 'ADMIN_CANCELLED');
                } catch (e) {
                    logger.warn('Failed to release VIP number from provider', { userId, error: e.message });
                }
            }

            // Release from NumberModel
            if (user.vipNumberId) {
                try {
                    await NumberModel.updateOne(
                        { numberId: user.vipNumberId },
                        { $set: { status: NUMBER_STATUS.AVAILABLE, assignedTo: null, assignedAt: null } }
                    );
                } catch (e) {
                    logger.warn('Failed to release number in DB', { userId, error: e.message });
                }
            }

            // Update user
            await User.updateOne(
                { userId },
                {
                    $set: {
                        vipExpiry: new Date(0),
                        vipNumberId: null,
                        vipPhoneNumber: null,
                        vipProvider: null,
                        vipNumberAssignedAt: null,
                        vipNumberCountry: null,
                        mode: 'CHEAP'
                    }
                }
            );

            await Transaction.create({
                txId: generateId(),
                userId,
                type: TX_TYPES.NUMBER_RELEASE,
                amount: 0,
                status: 'COMPLETED',
                metadata: { adminId: ctx.from.id.toString(), reason: 'ADMIN_CANCELLED', previousExpiry: user.vipExpiry },
                createdAt: new Date()
            });

            await this.logAdminAction(
                ctx.from.id.toString(),
                'CANCEL_VIP',
                userId,
                { previousExpiry: user.vipExpiry, phoneNumber: user.vipPhoneNumber }
            );

            await this.replySuccess(ctx, `✅ <b>VIP Cancelled!</b>\n\nUser: <code>${userId}</code>\nNumber released and VIP status removed.`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancel Another', 'admin_cancelvip')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

            // Notify user with contact support button
            await ctx.telegram.sendMessage(userId, `
<b>❌ VIP Subscription Cancelled</b>

Your VIP subscription has been cancelled by an admin.

Your dedicated number has been released.

Contact @Swiftsmssupport if you have questions.
            `, { 
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('📞 Contact Support', 'https://t.me/Swiftsmssupport')]
                ]).reply_markup
            }).catch(() => {});

        } catch (error) {
            logger.error('Cancel VIP error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to cancel VIP.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  BUNDLE PRICES
    // ═══════════════════════════════════════════════════════════

    async handleBundlePricesMenu(ctx) {
        const prices = config.prices || {};
        const bundleOtpPrices = prices.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        const bundlePack = { price: prices.bundlePrice || 5.00, count: prices.bundleOtpCount || 100 };

        let otpPricesText = '';
        for (const [qty, price] of Object.entries(bundleOtpPrices)) {
            otpPricesText += `• ${qty} OTPs: <code>${formatCurrency(price)}</code>\n`;
        }

        const message = `
<b>💰 Bundle Price Settings</b>

<b>Bundle Pack:</b>
• Price: <code>${formatCurrency(bundlePack.price)}</code>
• Includes: <code>${bundlePack.count}</code> OTPs

<b>Individual Bundle OTPs:</b>
${otpPricesText}
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✏️ Set Pack Price', 'set_bundle_pack_price')],
            [Markup.button.callback('✏️ Set OTP Prices', 'set_bundle_otp_prices')],
            [Markup.button.callback('🔙 Back', 'admin')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async processSetBundleOtpPrices(ctx, text) {
        try {
            const pairs = text.split(',').map(p => p.trim());
            const prices = {};
            
            for (const pair of pairs) {
                const [qty, price] = pair.split(':').map(s => s.trim());
                const quantity = parseInt(qty);
                const cost = parseFloat(price);
                
                if (isNaN(quantity) || isNaN(cost) || quantity < 1 || cost < 0) {
                    return this.replyError(ctx, '❌ <b>Invalid format.</b>\n\nUse: <code>5:0.50,10:0.90</code>');
                }
                prices[quantity] = cost;
            }

            if (!config.prices) config.prices = {};
            config.prices.bundleOtp = prices;
            await this._saveSettings();

            await this.replySuccess(ctx, `✅ <b>Bundle OTP Prices Updated!</b>\n\n${Object.entries(prices).map(([q, p]) => `• ${q} OTPs: ${formatCurrency(p)}`).join('\n')}`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back', 'admin_bundleprices')]
                ]).reply_markup
            });

            await this.logAdminAction(ctx.from.id.toString(), 'SET_BUNDLE_OTP_PRICES', null, { prices });

        } catch (error) {
            logger.error('Set bundle OTP prices error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to update prices.</b>');
        }
    }

    async processSetBundlePackPrice(ctx, text) {
        try {
            const pairs = text.split(',').map(p => p.trim());
            let price, count;

            for (const pair of pairs) {
                const [key, value] = pair.split(':').map(s => s.trim());
                if (key === 'price') price = parseFloat(value);
                if (key === 'count') count = parseInt(value);
            }

            if (isNaN(price) || isNaN(count) || price < 0 || count < 1) {
                return this.replyError(ctx, '❌ <b>Invalid format.</b>\n\nUse: <code>price:5.00,count:100</code>');
            }

            if (!config.prices) config.prices = {};
            config.prices.bundlePrice = price;
            config.prices.bundleOtpCount = count;
            await this._saveSettings();

            await this.replySuccess(ctx, `✅ <b>Bundle Pack Price Updated!</b>\n\nPrice: <code>${formatCurrency(price)}</code>\nCount: <code>${count}</code> OTPs`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back', 'admin_bundleprices')]
                ]).reply_markup
            });

            await this.logAdminAction(ctx.from.id.toString(), 'SET_BUNDLE_PACK_PRICE', null, { price, count });

        } catch (error) {
            logger.error('Set bundle pack price error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to update price.</b>');
        }
    }

    async handleSetBundlePriceCommand(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/setbundleprice &lt;otp|pack&gt;</code>\n\nUse buttons for easier setup.');
        }
        const type = args[1].toLowerCase();
        if (type === 'otp') {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SET_BUNDLE_OTP_PRICE);
            return this.replySuccess(ctx, 
                '💰 <b>Set Bundle OTP Prices</b>\n\n' +
                'Send prices in format:\n' +
                '<code>5:0.50,10:0.90,25:2.00,50:3.50</code>'
            );
        } else if (type === 'pack') {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SET_BUNDLE_PRICE);
            return this.replySuccess(ctx, 
                '💰 <b>Set Bundle Pack Price</b>\n\n' +
                'Send price and count:\n' +
                '<code>price:5.00,count:100</code>'
            );
        } else {
            return this.replyError(ctx, '❌ <b>Invalid type.</b>\n\nUse <code>otp</code> or <code>pack</code>.');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  USERS LIST
    // ═══════════════════════════════════════════════════════════

    async handleUsers(ctx) {
        try {
            const page = parseInt(ctx.match?.[1]) || 1;
            const limit = 10;
            const skip = (page - 1) * limit;

            const [users, totalUsers] = await Promise.all([
                User.find()
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                User.countDocuments()
            ]);

            const totalPages = Math.ceil(totalUsers / limit) || 1;

            if (!users.length) {
                return this.replyError(ctx, '<b>👥 No users found.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            let message = `<b>👥 Users</b> (Page ${page} of ${totalPages}) — Total: <code>${totalUsers}</code>\n\n`;
            const buttons = [];

            for (const user of users) {
                const status = user.isBlacklisted ? '🔴' :
                    (user.vipExpiry && new Date(user.vipExpiry) > new Date()) ? '👑' :
                        user.balance > 0 ? '💰' : '🆓';

                const displayName = user.username ? `@${user.username}` : (user.firstName || 'Unknown');
                message += `${status} <b>${displayName}</b> — <code>${user.userId}</code>\n`;
                message += `   Balance: <code>${formatCurrency(user.balance)}</code> | Joined: ${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}\n\n`;

                buttons.push([Markup.button.callback(
                    `${status} View ${displayName.substring(0, 20)}`,
                    `user_detail_${user.userId}`
                )]);
            }

            const navButtons = [];
            if (page > 1) {
                navButtons.push(Markup.button.callback('⬅️ Prev', `admin_users_${page - 1}`));
            }
            if (skip + users.length < totalUsers) {
                navButtons.push(Markup.button.callback('Next ➡️', `admin_users_${page + 1}`));
            }
            if (navButtons.length) {
                buttons.push(navButtons);
            }

            buttons.push([Markup.button.callback('🔙 Back to Admin', 'admin')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Users list error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load users.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SEARCH USER
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
    //  TOP USERS
    // ═══════════════════════════════════════════════════════════

    async handleTopUsers(ctx) {
        try {
            const topUsers = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE] },
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
    //  DAILY REPORT
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
                topServices,
                poolPurchases
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
                ]),
                Transaction.countDocuments({ type: TX_TYPES.POOL_PURCHASE, createdAt: { $gte: dayAgo } })
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

<b>📦 Pool Purchases:</b> <code>${poolPurchases}</code>

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
    //  RESET FREE OTPs
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
    //  GIVE VIP
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

    // ═══════════════════════════════════════════════════════════
    //  USER DETAIL INLINE (FIXED — was cut off at Lifetime Value)
    // ═══════════════════════════════════════════════════════════

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
                                        { $in: ['$type', [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE]] },
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

            // Calculate lifetime value safely
            const bundleValue = (user.bundleRemaining || 0) * (config.prices?.cheapOtp || 0.05);
            const lifetimeValue = (stats.totalSpent || 0) + bundleValue;

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
• Lifetime Value: <code>${formatCurrency(lifetimeValue)}</code>

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
                [
                    Markup.button.callback('🔄 Reset Free', `quick_resetfree_${userId}`),
                    Markup.button.callback('👑 Give VIP', `quick_givevip_${userId}`)
                ],
                [
                    Markup.button.callback('❌ Cancel VIP', `quick_cancelvip_${userId}`)
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
                    masterBalance.address = await this.walletService.getMasterAddress();
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
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE] },
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
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE] },
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
                address = await this.walletService.getMasterAddress();
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
                    address = await this.walletService.getMasterAddress();
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

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🏥 Health', 'admin_healthcheck')],
                [Markup.button.callback('🔙 Back', 'admin')]     
                ]).reply_markup
            });
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

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'admin_logs')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });
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
                    [Markup.button.callback('🎯 Custom', 'broadcast_custom')],
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
                this._ensureSession(ctx);
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
                            await User.updateOne(
                                { userId: user.userId },
                                { $set: { blockedBot: true, isBlacklisted: true } }
                            ).catch(() => {});
                        }
                        logger.warn('Broadcast failed for user', { userId: user.userId, error: error.message });
                    }
                }));

                // Rate limit protection between batches
                if (i + batchSize < users.length) {
                    await new Promise(r => setTimeout(r, 1000));
                }

                // Progress update every 5 batches (FIXED: i > 0 check)
                if (i > 0 && (i / batchSize) % 5 === 0) {
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

    async handleBroadcastCustom(ctx) {
        this._setAdminState(ctx, ADMIN_STATE.AWAITING_CUSTOM_BROADCAST_FILTER, {});
        await this.replySuccess(ctx, `
<b>🎯 Custom Broadcast</b>

Send a MongoDB-style filter query as text.

<i>Example: <code>{"balance": {"$gt": 10}}</code></i>

Or just send a message to broadcast to all users with custom text.
        `);
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
            const tx = await Transaction.findOne({ txId, type: TX_TYPES.REFERRAL_REWARD, status: 'PENDING' });

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

            const tx = await Transaction.findOne({ txId, type: TX_TYPES.REFERRAL_REWARD, status: 'PENDING' });
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
                    address = await this.walletService.getMasterAddress();
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

<b>📦 Pool:</b>
• Auto-buy: ${settings.poolAutoBuy ? '✅' : '❌'}
• Min stock: <code>${settings.poolMinStock}</code>

<b>🛠 Maintenance:</b> ${settings.maintenanceMode ? '🔴 ON' : '🟢 OFF'}
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💰 OTP Prices', 'settings_prices')],
                [Markup.button.callback('👑 VIP Config', 'settings_vip')],
                [Markup.button.callback('🆓 Free Limits', 'settings_free')],
                [Markup.button.callback('⚡ Providers', 'settings_providers')],
                [Markup.button.callback('📦 Pool', 'settings_pool')],
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
            poolAutoBuy: config.pool?.autoBuy !== false,
            poolMinStock: config.pool?.minStock || 5,
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

    async handleSettingsPool(ctx) {
        const autoBuy = config.pool?.autoBuy !== false ? '✅' : '❌';
        const minStock = config.pool?.minStock || 5;

        const message = `
<b>📦 Pool Settings</b>

<b>Current:</b>
• Auto-buy: ${autoBuy}
• Min stock: <code>${minStock}</code>

<i>Pool auto-buy triggers when available numbers fall below minimum stock.</i>
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

    // ═══════════════════════════════════════════════════════════
    //  BULK ACTIONS (NEW FEATURE)
    // ═══════════════════════════════════════════════════════════

    async handleBulkActionsMenu(ctx) {
        const message = `
<b>⚡ Bulk Actions</b>

Perform actions on multiple users at once:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📢 Bulk Broadcast', 'bulk_broadcast')],
            [Markup.button.callback('💰 Bulk Add Balance', 'bulk_add_balance')],
            [Markup.button.callback('👑 Bulk Give VIP', 'bulk_give_vip')],
            [Markup.button.callback('🔄 Bulk Reset Free', 'bulk_reset_free')],
            [Markup.button.callback('🔙 Back', 'admin')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async handleBulkBroadcastMenu(ctx) {
        this._setAdminState(ctx, ADMIN_STATE.AWAITING_BROADCAST_MESSAGE, { mode: 'bulk' });
        await this.replySuccess(ctx, `
<b>📢 Bulk Broadcast</b>

Send the message to broadcast to ALL users:

<i>This will send to every non-blacklisted user. Use with caution.</i>
        `);
    }

    async handleBulkAddBalanceMenu(ctx) {
        await this.replySuccess(ctx, `
<b>💰 Bulk Add Balance</b>

Use the command:
<code>/addbalance &lt;user_id&gt; &lt;amount&gt;</code>

For multiple users, use the button flow for each user individually.
        `, {
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('👥 Go to Users', 'admin_users')],
                [Markup.button.callback('🔙 Back', 'admin_bulkactions')]
            ]).reply_markup
        });
    }

    async handleBulkGiveVipMenu(ctx) {
        await this.replySuccess(ctx, `
<b>👑 Bulk Give VIP</b>

Use the <code>/user &lt;user_id&gt;</code> command to find users, then use the quick VIP button.

Or grant VIP via:
<code>/givevip &lt;user_id&gt; &lt;days&gt;</code>
        `, {
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('👥 Go to Users', 'admin_users')],
                [Markup.button.callback('🔙 Back', 'admin_bulkactions')]
            ]).reply_markup
        });
    }

    async handleBulkResetFreeMenu(ctx) {
        await this.replySuccess(ctx, `
<b>🔄 Bulk Reset Free</b>

Use the <code>/user &lt;user_id&gt;</code> command to find users, then use the quick reset button.

Or reset via:
<code>/resetfree &lt;user_id&gt;</code>
        `, {
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('👥 Go to Users', 'admin_users')],
                [Markup.button.callback('🔙 Back', 'admin_bulkactions')]
            ]).reply_markup
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  ANALYTICS (NEW FEATURE)
    // ═══════════════════════════════════════════════════════════

    async handleAnalyticsMenu(ctx) {
        const message = `
<b>📊 Advanced Analytics</b>

Deep dive into bot performance metrics:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💰 Revenue Trends', 'analytics_revenue')],
            [Markup.button.callback('👥 User Growth', 'analytics_users')],
            [Markup.button.callback('🔥 Service Demand', 'analytics_services')],
            [Markup.button.callback('🔄 Retention', 'analytics_retention')],
            [Markup.button.callback('🔙 Back', 'admin')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    }

    async handleAnalyticsRevenue(ctx) {
        try {
            const now = new Date();
            const days7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
            const days30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

            const [weekData, monthData] = await Promise.all([
                Transaction.aggregate([
                    { $match: { status: 'COMPLETED', createdAt: { $gte: days7 } } },
                    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: { $abs: '$amount' } } } },
                    { $sort: { _id: 1 } }
                ]),
                Transaction.aggregate([
                    { $match: { status: 'COMPLETED', createdAt: { $gte: days30 } } },
                    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: { $abs: '$amount' } } } },
                    { $sort: { _id: 1 } }
                ])
            ]);

            let message = '<b>💰 Revenue Trends</b>\n\n<b>Last 7 Days:</b>\n';
            weekData.forEach(d => {
                message += `• ${d._id}: <code>${formatCurrency(d.total)}</code>\n`;
            });

            const monthTotal = monthData.reduce((sum, d) => sum + d.total, 0);
            message += `\n<b>30-Day Total:</b> <code>${formatCurrency(monthTotal)}</code>\n`;
            message += `<b>Daily Average:</b> <code>${formatCurrency(monthTotal / 30)}</code>`;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'analytics_revenue')],
                    [Markup.button.callback('🔙 Back', 'admin_analytics')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Analytics revenue error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load revenue analytics.</b>');
        }
    }

    async handleAnalyticsUsers(ctx) {
        try {
            const now = new Date();
            const intervals = [1, 7, 30, 90].map(d => new Date(now - d * 24 * 60 * 60 * 1000));

            const [new1d, new7d, new30d, new90d, total, active7d, active30d] = await Promise.all([
                User.countDocuments({ createdAt: { $gte: intervals[0] } }),
                User.countDocuments({ createdAt: { $gte: intervals[1] } }),
                User.countDocuments({ createdAt: { $gte: intervals[2] } }),
                User.countDocuments({ createdAt: { $gte: intervals[3] } }),
                User.countDocuments(),
                User.countDocuments({ lastActive: { $gte: intervals[1] } }),
                User.countDocuments({ lastActive: { $gte: intervals[2] } })
            ]);

            const message = `
<b>👥 User Growth Analytics</b>

<b>New Users:</b>
• 24h: <code>${new1d}</code>
• 7d: <code>${new7d}</code>
• 30d: <code>${new30d}</code>
• 90d: <code>${new90d}</code>

<b>Active Users:</b>
• 7d active: <code>${active7d}</code>
• 30d active: <code>${active30d}</code>

<b>Total Users:</b> <code>${total}</code>
<b>Retention (7d/30d):</b> <code>${new30d > 0 ? ((active7d / new30d) * 100).toFixed(1) : 0}%</code>
            `;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'analytics_users')],
                    [Markup.button.callback('🔙 Back', 'admin_analytics')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Analytics users error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load user analytics.</b>');
        }
    }

    async handleAnalyticsServices(ctx) {
        try {
            const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

            const services = await Session.aggregate([
                { $match: { status: 'RECEIVED', startTime: { $gte: monthAgo } } },
                { $group: { _id: '$service', count: { $sum: 1 }, revenue: { $sum: '$cost' }, avgTime: { $avg: '$duration' } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            let message = '<b>🔥 Service Demand (30d)</b>\n\n';
            services.forEach((s, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
                message += `${medal} <b>${s._id}</b>\n`;
                message += `   Requests: <code>${s.count}</code> | Revenue: <code>${formatCurrency(s.revenue)}</code>\n`;
                message += `   Avg Time: <code>${(s.avgTime || 0).toFixed(1)}s</code>\n\n`;
            });

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'analytics_services')],
                    [Markup.button.callback('🔙 Back', 'admin_analytics')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Analytics services error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load service analytics.</b>');
        }
    }

    async handleAnalyticsRetention(ctx) {
        try {
            const now = new Date();
            const cohorts = [];
            const weeks = 4;

            for (let i = 0; i < weeks; i++) {
                const weekStart = new Date(now - (i + 1) * 7 * 24 * 60 * 60 * 1000);
                const weekEnd = new Date(now - i * 7 * 24 * 60 * 60 * 1000);

                const newUsers = await User.countDocuments({ createdAt: { $gte: weekStart, $lt: weekEnd } });
                const retained = await User.countDocuments({
                    createdAt: { $gte: weekStart, $lt: weekEnd },
                    lastActive: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) }
                });

                cohorts.push({
                    week: `Week ${weeks - i}`,
                    newUsers,
                    retained,
                    rate: newUsers > 0 ? ((retained / newUsers) * 100).toFixed(1) : 0
                });
            }

            let message = '<b>🔄 Retention Cohorts</b>\n\n';
            cohorts.forEach(c => {
                message += `<b>${c.week}</b>: <code>${c.newUsers}</code> new → <code>${c.retained}</code> retained (<code>${c.rate}%</code>)\n`;
            });

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'analytics_retention')],
                    [Markup.button.callback('🔙 Back', 'admin_analytics')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Analytics retention error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load retention analytics.</b>');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE BUY POOL COMMAND (Missing implementation)
    // ═══════════════════════════════════════════════════════════

    async handleBuyPoolCommand(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/buypool &lt;country&gt; &lt;quantity&gt; [provider]</code>');
        }

        const country = args[1].toUpperCase();
        const quantity = parseInt(args[2]);
        const provider = args[3] || null;

        if (country.length !== 2) {
            return this.replyError(ctx, '❌ <b>Invalid country code.</b>\n\nMust be 2 letters (e.g., US, GB).');
        }
        if (isNaN(quantity) || quantity < 1 || quantity > 50) {
            return this.replyError(ctx, '❌ <b>Invalid quantity.</b>\n\nMust be 1-50.');
        }

        ctx.session.poolPurchase = { country, quantity, preferredProvider: provider };
        return this.showPoolPurchaseConfirm(ctx);
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE POOL STATS COMMAND (Missing implementation)
    // ═══════════════════════════════════════════════════════════

    async handlePoolStatsCommand(ctx) {
        return this.handlePoolMonitor(ctx);
    }
}

export default AdminCommands;
