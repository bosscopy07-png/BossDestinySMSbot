
import { Markup } from 'telegraf';
import { User, Session, Transaction, AdminLog, Settings, Number as NumberModel } from '../../models/index.js';
import { generateId, formatCurrency } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';
import { poolMethods } from './admin/pool.js';
import { usersMethods } from './admin/users.js';
import { reportsMethods } from './admin/reports.js';
import { broadcastMethods } from './admin/broadcast.js';
import { settingsMethods } from './admin/settings.js';
import { IMG_SUCCESS, IMG_ERROR, TX_TYPES, ADMIN_STATE, NUMBER_STATUS } from './admin/constants.js';

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
    
    /**
 * Safely edits a message, handling both text and photo messages.
 * Falls back to sending a new message if edit fails.
 */

    

    // ─── Admin middleware ───
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
        this.bot.command('approve_referral', this.requireAdmin, this.handleApproveReferral.bind(this));
        this.bot.command('reject_referral', this.requireAdmin, this.handleRejectReferral.bind(this));
        this.bot.command('master_balance', this.requireAdmin, this.handleMasterBalance.bind(this));
        this.bot.command('setprice', this.requireAdmin, this.handleSetPrice.bind(this));
        this.bot.command('setvip', this.requireAdmin, this.handleSetVip.bind(this));
        this.bot.command('setfree', this.requireAdmin, this.handleSetFree.bind(this));
        this.bot.command('toggleprovider', this.requireAdmin, this.handleToggleProvider.bind(this));
        this.bot.command('export_users', this.requireAdmin, this.handleExportUsers.bind(this));
        this.bot.command('export_transactions', this.requireAdmin, this.handleExportTransactions.bind(this));
        
        // Pool management commands
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

        // ─── Pool Management ───
this.bot.action('admin_pool', this.requireAdmin, this.handlePoolMenu.bind(this));
this.bot.action('pool_buy_numbers', this.requireAdmin, this.handlePoolBuyMenu.bind(this));
this.bot.action('pool_monitor', this.requireAdmin, this.handlePoolMonitor.bind(this));
this.bot.action('pool_retire', this.requireAdmin, this.handlePoolRetireMenu.bind(this));
this.bot.action('pool_vip_users', this.requireAdmin, this.handlePoolVipUsers.bind(this));

this.bot.action('pool_provider_twilio', this.requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, 'twilio'));
this.bot.action('pool_provider_telnyx', this.requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, 'telnyx'));
this.bot.action('pool_provider_any', this.requireAdmin, (ctx) => this.handlePoolProviderSelect(ctx, 'any'));

this.bot.action(/adminpool_co_(.+)/, this.requireAdmin, (ctx) => {
    const country = ctx.match[1];
    return this.handlePoolCountrySelect(ctx, country);
});

this.bot.action(/pool_qty_(\d+)/, this.requireAdmin, (ctx) => {
    const qty = parseInt(ctx.match[1]);
    return this.handlePoolQuantitySelect(ctx, qty);
});

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
     // ═══════════════════════════════════════════════════════════
//  RPC MODE CONTROL — Admin Action Handlers
// ═══════════════════════════════════════════════════════════

this.bot.action('admin_rpc_control', async (ctx) => {
    try {
        await ctx.answerCbQuery().catch(() => {});
        return await this.showRpcControlPanel(ctx);
    } catch (err) {
        logger.error('RPC control panel error', { error: err.message, userId: ctx.from?.id });
        await this.replyError(ctx, '❌ Failed to load RPC control panel.');
    }
});
this.bot.action('rpc_force_idle', async (ctx) => {
    try {
        await ctx.answerCbQuery('⏳ Switching to IDLE...').catch(() => {});
        
        if (!this.walletService) {
            return await this.replyError(ctx, '❌ Wallet service not available.');
        }

        this.walletService._switchToIdleMode();
        
        const message = 
            '✅ <b>RPC Mode Switched</b>\n\n' +
            '⛓️ Mode: <code>IDLE</code>\n' +
            '🔌 Provider: <code>Light RPC</code>\n' +
            '⏱️ Interval: <code>60s</code>\n\n' +
            '<i>Premium RPC credits conserved.</i>';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Back to RPC Panel', 'admin_rpc_control')],
            [Markup.button.callback('🏠 Admin Dashboard', 'admin_dashboard')]
        ]);

        await this._safeEditMessage(ctx, message, keyboard);

    } catch (err) {
        logger.error('Force idle error', { error: err.message, userId: ctx.from?.id });
        await this.replyError(ctx, '❌ Failed to switch to IDLE mode.');
    }
});
    
this.bot.action('rpc_force_active', async (ctx) => {
    try {
        await ctx.answerCbQuery('⏳ Switching to ACTIVE...').catch(() => {});
        
        if (!this.walletService) {
            return await this.replyError(ctx, '❌ Wallet service not available.');
        }

        this.walletService._switchToActiveMode();
        
        const message = 
            '✅ <b>RPC Mode Switched</b>\n\n' +
            '⛓️ Mode: <code>ACTIVE</code>\n' +
            '🔌 Provider: <code>Premium RPC</code>\n' +
            '⏱️ Interval: <code>15s</code>\n\n' +
            '<i>Fast deposit detection enabled.</i>';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Back to RPC Panel', 'admin_rpc_control')],
            [Markup.button.callback('🏠 Admin Dashboard', 'admin_dashboard')]
        ]);

        await this._safeEditMessage(ctx, message, keyboard);

    } catch (err) {
        logger.error('Force active error', { error: err.message, userId: ctx.from?.id });
        await this.replyError(ctx, '❌ Failed to switch to ACTIVE mode.');
    }
});
                                
                              
this.bot.action('rpc_status', async (ctx) => {
    try {
        await ctx.answerCbQuery().catch(() => {});
        
        if (!this.walletService) {
            return await this.replyError(ctx, '❌ Wallet service not available.');
        }

        const ws = this.walletService;
        const now = Date.now();
        const expiresIn = ws.activeModeExpiry > now 
            ? `${Math.ceil((ws.activeModeExpiry - now) / 1000)}s` 
            : 'Expired';
        const expiresAt = ws.activeModeExpiry 
            ? new Date(ws.activeModeExpiry).toLocaleTimeString() 
            : 'N/A';

        let masterBalance = 'Unavailable';
        try {
            const balance = await ws.getMasterBalance();
            masterBalance = `${balance.usdt} USDT`;
        } catch {
            // keep default
        }

        const message = 
            '📊 <b>RPC Status Report</b>\n\n' +
            `⛓️ <b>Current Mode:</b> <code>${ws.scanMode || 'UNKNOWN'}</code>\n` +
            `🔌 <b>Provider:</b> <code>${ws.currentProviderType || 'none'}</code>\n` +
            `📦 <b>Master Address:</b> <code>${ws.getMasterAddress()}</code>\n` +
            `💰 <b>Master Balance:</b> <code>${masterBalance}</code>\n\n` +
            `⏱️ <b>Active Expires:</b> <code>${expiresAt}</code>\n` +
            `⏳ <b>Time Remaining:</b> <code>${expiresIn}</code>\n\n` +
            `🟢 <b>Light RPC:</b> ${ws.lightProvider ? 'Connected' : 'Disconnected'}\n` +
            `🔵 <b>Premium RPC:</b> ${ws.premiumProvider ? 'Connected' : 'Disconnected'}\n` +
            `✅ <b>Wallet Ready:</b> ${ws.isReady ? 'Yes' : 'No'}`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'rpc_status')],
            [Markup.button.callback('⬅️ Back to RPC Panel', 'admin_rpc_control')],
            [Markup.button.callback('🏠 Admin Dashboard', 'admin_dashboard')]
        ]);

        // Safe edit: handles both text and photo messages
        await this._safeEditMessage(ctx, message, keyboard);

    } catch (err) {
        logger.error('RPC status error', { error: err.message, userId: ctx.from?.id });
        await this.replyError(ctx, '❌ Failed to fetch RPC status.');
    }
});
                                    

// Re-open admin dashboard from RPC panel
this.bot.action('admin_dashboard', async (ctx) => {
    try {
        await ctx.answerCbQuery().catch(() => {});
        return await this.handleAdmin(ctx);
    } catch (err) {
        logger.error('Return to admin dashboard error', { error: err.message });
    }
});
        // ═══════════════════════════════════════════════════════════════════════
//  ORPHAN SMS ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════

this.bot.action('admin_orphan_review', async (ctx) => {
    try {
        await ctx.answerCbQuery().catch(() => {});
        await this.handleOrphanReview(ctx);
    } catch (err) {
        logger.error('admin_orphan_review error', { error: err.message });
        await this.replyError(ctx, '❌ Failed to load orphan review.');
    }
});

this.bot.action('admin_orphan_markall', async (ctx) => {
    try {
        await ctx.answerCbQuery('Marking all as reviewed...').catch(() => {});
        await this.handleOrphanMarkAll(ctx);
    } catch (err) {
        logger.error('admin_orphan_markall error', { error: err.message });
        await this.replyError(ctx, '❌ Failed to mark orphans.');
    }
});

this.bot.action('admin_orphan_export', async (ctx) => {
    try {
        await ctx.answerCbQuery('Generating CSV...').catch(() => {});
        await this.handleOrphanExport(ctx);
    } catch (err) {
        logger.error('admin_orphan_export error', { error: err.message });
        await this.replyError(ctx, '❌ Export failed.');
    }
});

this.bot.action('admin_orphan_search', async (ctx) => {
    try {
        await ctx.answerCbQuery().catch(() => {});
        await this.handleOrphanSearch(ctx);
    } catch (err) {
        logger.error('admin_orphan_search error', { error: err.message });
        await this.replyError(ctx, '❌ Search init failed.');
    }
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
            // In handleTextInput() or setupTextHandler():
if (ctx.session?.adminState?.state === 'ORPHAN_SEARCH') {
    delete ctx.session.adminState;
    return this.processOrphanSearch(ctx, ctx.message.text);
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
        Markup.button.callback('🔎 Investigation', 'at_menu')
    ],
    [
        Markup.button.callback('📱 Numbers', 'admin_numberinventory'),
        Markup.button.callback('📊 Analytics', 'admin_analytics')
    ],
    [
        Markup.button.callback('⚡ Bulk Actions', 'admin_bulkactions')
    ],
    [
        Markup.button.callback('🛠️ Advanced Tools', 'open_admin_dashboard')
    ],
    // ═══════════════════════════════════════════════════
    //  NEW: RPC Mode Control Button
    // ═══════════════════════════════════════════════════
    [
    Markup.button.callback('📨 Orphan SMS', 'admin_orphan_review'),
    Markup.button.callback('⛓️ RPC Mode', 'admin_rpc_control')
]
                                               
]);
        

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    } catch (error) {
        logger.error('Admin dashboard error', { error: error.message, stack: error.stack });
        await this.replyError(ctx, '❌ <b>Failed to load admin dashboard.</b>\n\nPlease check the logs for details.');
    }
    }

// ═══════════════════════════════════════════════════════════════════════
//  HELPER METHODS
// ═══════════════════════════════════════════════════════════════════════

_formatTimeAgo(date) {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

_maskPhone(phone) {
    if (!phone) return '****';
    const str = phone.toString().replace(/\D/g, '');
    if (str.length < 4) return '****';
    return '+' + str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
}

/**
 * Safe message edit — handles both text and photo messages
 */
async _safeEditMessage(ctx, text, keyboard) {
    try {
        if (ctx.callbackQuery?.message?.photo) {
            // Edit caption for photo messages
            await ctx.editMessageCaption(text, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        } else {
            // Edit text message
            await ctx.editMessageText(text, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        }
    } catch (err) {
        // If edit fails, send new message
        if (err.message?.includes('not modified')) return;
        await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        });
    }
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE BUY POOL COMMAND (Missing implementation)
    // ═══════════════════════════════════════════════════════════

    

    // ═══════════════════════════════════════════════════════════
    //  HANDLE POOL STATS COMMAND (Missing implementation)
    // ═══════════════════════════════════════════════════════════

    
}

// ─── Mix the split modules into the class (methods keep working unchanged via `this`) ───
Object.assign(AdminCommands.prototype, poolMethods, usersMethods, reportsMethods, broadcastMethods, settingsMethods);

export default AdminCommands;
