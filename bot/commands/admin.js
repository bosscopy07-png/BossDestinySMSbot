import { Markup } from 'telegraf';
import { User, Session, Transaction, AdminLog, Settings, Number as NumberModel } from '../../models/index.js';
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
    REFUND: 'REFUND',
    POOL_PURCHASE: 'POOL_PURCHASE'
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
    AWAITING_SET_BUNDLE_OTP_PRICE: 'awaitingSetBundleOtpPrice'
});

class AdminCommands {
    constructor(bot, walletService, referralService = null, smsProviderManager = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.referralService = referralService;
        this.smsProviderManager = smsProviderManager;
        this.admins = new Set();
        this._registerCommands();
        this._registerTextHandlers();
        this._registerButtonFlows();
        this._loadSettings().catch(err => {
            logger.warn('Admin settings init load failed', { error: err.message });
        });
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
        
        // NEW: Pool management commands
        this.bot.command('buypool', this.requireAdmin, this.handleBuyPoolCommand.bind(this));
        this.bot.command('poolstats', this.requireAdmin, this.handlePoolStatsCommand.bind(this));
        this.bot.command('cancelvip', this.requireAdmin, this.handleCancelVipCommand.bind(this));
        this.bot.command('setbundleprice', this.requireAdmin, this.handleSetBundlePriceCommand.bind(this));

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
        
        // NEW: Pool management buttons
        this.bot.action('admin_pool', this.requireAdmin, this.handlePoolMenu.bind(this));
        this.bot.action('pool_buy_numbers', this.requireAdmin, this.handlePoolBuyMenu.bind(this));
        this.bot.action('pool_monitor', this.requireAdmin, this.handlePoolMonitor.bind(this));
        this.bot.action('pool_retire', this.requireAdmin, this.handlePoolRetireMenu.bind(this));
        this.bot.action('pool_vip_users', this.requireAdmin, this.handlePoolVipUsers.bind(this));
        this.bot.action('admin_cancelvip', this.requireAdmin, this.handleCancelVipMenu.bind(this));
        this.bot.action('admin_bundleprices', this.requireAdmin, this.handleBundlePricesMenu.bind(this));
        
        // Pool provider selection
        this.bot.action('pool_provider_twilio', this.requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, 'TWILIO'));
        this.bot.action('pool_provider_telnyx', this.requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, 'TELNYX'));
        this.bot.action('pool_provider_any', this.requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, null));
        
        // Pool country selection
        this.bot.action(/pool_country_(.+)/, this.requireAdmin, (ctx) => {
            const country = ctx.match[1];
            return this.handlePoolCountrySelect(ctx, country);
        });
        
        // Pool quantity selection
        this.bot.action(/pool_qty_(\d+)/, this.requireAdmin, (ctx) => {
            const qty = parseInt(ctx.match[1]);
            return this.handlePoolQuantitySelect(ctx, qty);
        });
        
        // Confirm pool purchase
        this.bot.action('confirm_pool_purchase', this.requireAdmin, this.executePoolPurchase.bind(this));
        
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
            
            // NEW: Quick cancel VIP from user detail
            this.bot.action(/quick_cancelvip_(.+)/, this.requireAdmin, (ctx) => {
                return this.executeCancelVip(ctx, ctx.match[1]);
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

                // NEW: Pool purchase country
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

                // NEW: Pool purchase quantity
                if (state === ADMIN_STATE.AWAITING_POOL_PURCHASE_QTY) {
                    const qty = parseInt(ctx.message.text.trim());
                    this._clearAdminState(ctx);
                    if (isNaN(qty) || qty < 1 || qty > 50) {
                        return this.replyError(ctx, '❌ <b>Invalid quantity.</b>\n\nMust be 1-50.');
                    }
                    ctx.session.poolPurchase = { ...ctx.session.poolPurchase, quantity: qty };
                    return this.showPoolPurchaseConfirm(ctx);
                }

                // NEW: Cancel VIP user ID
                if (state === ADMIN_STATE.AWAITING_CANCEL_VIP_USER) {
                    const userId = ctx.message.text.trim();
                    this._clearAdminState(ctx);
                    return this.showCancelVipConfirm(ctx, userId);
                }

                // NEW: Set bundle OTP prices
                if (state === ADMIN_STATE.AWAITING_SET_BUNDLE_OTP_PRICE) {
                    this._clearAdminState(ctx);
                    return this.processSetBundleOtpPrices(ctx, ctx.message.text.trim());
                }

                // NEW: Set bundle pack price
                if (state === ADMIN_STATE.AWAITING_SET_BUNDLE_PRICE) {
                    this._clearAdminState(ctx);
                    return this.processSetBundlePackPrice(ctx(ctx, ctx.message.text.trim());
                }

                return next();
            });
        }

        // ═══════════════════════════════════════════════════════════
        //  SYSTEM STATS HELPER (NEW — fixes getSystemStats undefined)
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
                    otpFailed24h
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
                    Session.countDocuments({ status: { $in: ['TIMEOUT', 'CANCELLED', 'FAILED'] }, startTime: { $gte: dayAgo } })
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
                    uptime: `${hours}h ${mins}m`
                };
            } catch (error) {
                logger.error('Get system stats error', { error: error.message, stack: error.stack });
                return {
                    revenue24h: 0, revenue7d: 0, revenue30d: 0,
                    totalUsers: 0, payingUsers: 0, vipUsers: 0, activeToday: 0,
                    otpRequests24h: 0, otpSuccess24h: 0, otpFailed24h: 0,
                    successRate24h: 0, masterBalance: 0, uptime: '0h 0m'
                };
            }
        }

        // ═══════════════════════════════════════════════════════════
        //  REVENUE CALCULATOR (NEW — fixes calculateRevenue undefined)
        // ═══════════════════════════════════════════════════════════

        async calculateRevenue(since) {
            try {
                const result = await Transaction.aggregate([
                    {
                        $match: {
                            type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION] },
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
                    ],
                    // NEW: Pool management
                    [
                        Markup.button.callback('📦 Pool', 'admin_pool'),
                        Markup.button.callback('❌ Cancel VIP', 'admin_cancelvip')
                    ],
                    [
                        Markup.button.callback('💰 Bundle Prices', 'admin_bundleprices')
                    ]
                ]);

                await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
            } catch (error) {
                logger.error('Admin dashboard error', { error: error.message, stack: error.stack });
                await this.replyError(ctx, '❌ <b>Failed to load admin dashboard.</b>\n\nPlease check the logs for details.');
            }
        }

        // ═══════════════════════════════════════════════════════════
        //  POOL MANAGEMENT (NEW)
        // ═══════════════════════════════════════════════════════════

        async handlePoolMenu(ctx) {
            const message = `
<b>📦 Number Pool Management</b>

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
        }

        async handlePoolBuyMenu(ctx) {
            if (!this.smsProviderManager?.numberPool) {
                return this.replyError(ctx, '❌ <b>Pool not available.</b>\n\nNumber pool is not configured.');
            }

            const message = `
<b>🛒 Buy Numbers for Pool</b>

Select provider:
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🏢 Twilio', 'pool_provider_twilio')],
                [Markup.button.callback('🏢 Telnyx', 'pool_provider_telnyx')],
                [Markup.button.callback('🎲 Any Available', 'pool_provider_any')],
                [Markup.button.callback('🔙 Back', 'admin_pool')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        }

        async handlePoolProviderSelect(ctx, provider) {
            ctx.session = ctx.session || {};
            ctx.session.poolPurchase = { preferredProvider: provider };
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_POOL_PURCHASE_COUNTRY, { provider });
            
            const message = `
<b>🛒 Buy Numbers — ${provider || 'Any Provider'}</b>

Send the country code (2 letters):
<code>US</code>, <code>GB</code>, <code>CA</code>, etc.
            `;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancel', 'admin_pool')]
                ]).reply_markup
            });
        }

        async handlePoolCountrySelect(ctx, country) {
            ctx.session.poolPurchase = { ...ctx.session.poolPurchase, country };
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_POOL_PURCHASE_QTY, { country });
            
            const message = `
<b>🛒 Buy Numbers — ${country}</b>

Select quantity or send custom:
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('1', 'pool_qty_1'), Markup.button.callback('5', 'pool_qty_5'), Markup.button.callback('10', 'pool_qty_10')],
                [Markup.button.callback('20', 'pool_qty_20'), Markup.button.callback('50', 'pool_qty_50')],
                [Markup.button.callback('❌ Cancel', 'admin_pool')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keybo
