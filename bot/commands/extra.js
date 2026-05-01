// ═══════════════════════════════════════════════════════════
//  bot/commands/extra.js — Advanced Admin Dashboard
// ═══════════════════════════════════════════════════════════

import { fixNegativeLockedBalances } from '../../scripts/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

// ─── IMAGE CONFIG ───
const ADMIN_IMAGE_URL = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';

// ─── SAFE EDIT HELPER ───
// Prevents "no text in the message to edit" crashes
async function safeEditMessage(ctx, text, extra = {}) {
    try {
        if (ctx.callbackQuery?.message?.text !== undefined) {
            return await ctx.editMessageText(text, extra);
        }
        return await ctx.reply(text, extra);
    } catch (err) {
        if (err.message?.includes('there is no text in the message') || 
            err.message?.includes('message to edit') ||
            err.message?.includes('MESSAGE_NOT_MODIFIED')) {
            return await ctx.reply(text, extra);
        }
        logger.error('safeEditMessage failed', { error: err.message });
        return await ctx.reply(text, extra);
    }
}

// ─── SAFE EDIT WITH IMAGE HELPER ───
// Sends image with caption instead of plain text for all admin messages
async function safeEditWithImage(ctx, text, extra = {}) {
    const captionExtra = {
        ...extra,
        parse_mode: extra.parse_mode || 'HTML'
    };
    try {
        // Try to edit existing message caption if it has a photo
        if (ctx.callbackQuery?.message?.photo && ctx.callbackQuery?.message?.caption !== undefined) {
            return await ctx.editMessageCaption(text, captionExtra);
        }
        // If existing message has text, try to edit text first
        if (ctx.callbackQuery?.message?.text !== undefined) {
            return await ctx.editMessageText(text, extra);
        }
        // Otherwise send new photo with caption
        return await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: text, ...captionExtra });
    } catch (err) {
        if (err.message?.includes('there is no text in the message') || 
            err.message?.includes('message to edit') ||
            err.message?.includes('MESSAGE_NOT_MODIFIED') ||
            err.message?.includes('there is no caption in the message')) {
            return await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: text, ...captionExtra });
        }
        logger.error('safeEditWithImage failed', { error: err.message });
        return await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: text, ...captionExtra });
    }
}

/**
 * Admin command handlers — Button-Based Dashboard
 * All actions check adminId before executing
 */
class Admin {
    constructor(bot, walletService = null, referralService = null, smsProviderManager = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.referralService = referralService;
        this.smsProviderManager = smsProviderManager;
        
        // Support multiple admins (comma-separated)
        this.adminIds = (config.bot?.adminId || '')
            .toString()
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);

        this.registerActions();
    }

    /**
     * Check if user is admin
     */
    isAdmin(userId) {
        return this.adminIds.includes(userId?.toString());
    }

    /**
     * Register all admin callback actions
     */
    registerActions() {
        // Main dashboard entry point
        this.bot.action('admin_dashboard', (ctx) => this.showDashboard(ctx));
        
        // ─── Sub-menu navigation handlers ───
        this.bot.action('admin_system_menu', (ctx) => this.showSystemMenu(ctx));
        this.bot.action('admin_analytics_menu', (ctx) => this.showAnalyticsMenu(ctx));
        this.bot.action('admin_users_menu', (ctx) => this.showUsersMenu(ctx));
        this.bot.action('admin_finance_menu', (ctx) => this.showFinanceMenu(ctx));
        this.bot.action('admin_sms_menu', (ctx) => this.showSMSMenu(ctx));
        this.bot.action('admin_fraud_menu', (ctx) => this.showFraudMenu(ctx));
        this.bot.action('admin_automation_menu', (ctx) => this.showAutomationMenu(ctx));
        this.bot.action('admin_devops_menu', (ctx) => this.showDevopsMenu(ctx));
        
        // ─── System & Maintenance ───
        this.bot.action('admin_fix_balances', (ctx) => this.handleFixBalances(ctx));
        this.bot.action('admin_health', (ctx) => this.handleHealth(ctx));
        this.bot.action('admin_restart', (ctx) => this.handleRestart(ctx));
        this.bot.action('admin_maintenance', (ctx) => this.handleToggleMaintenance(ctx));
        this.bot.action('admin_logs', (ctx) => this.handleViewLogs(ctx));
        this.bot.action('admin_clear_cache', (ctx) => this.handleClearCache(ctx));
        this.bot.action('admin_backup', (ctx) => this.handleBackup(ctx));
        this.bot.action('admin_workers', (ctx) => this.handleWorkerStatus(ctx));

        // ─── Analytics ───
        this.bot.action('admin_stats', (ctx) => this.handleStats(ctx));
        this.bot.action('admin_stats_7d', (ctx) => this.handleStats7d(ctx));
        this.bot.action('admin_stats_30d', (ctx) => this.handleStats30d(ctx));
        this.bot.action('admin_top_users', (ctx) => this.handleTopUsers(ctx));
        this.bot.action('admin_otp_success', (ctx) => this.handleOTPSuccessRate(ctx));
        this.bot.action('admin_provider_perf', (ctx) => this.handleProviderPerformance(ctx));
        this.bot.action('admin_peak_hours', (ctx) => this.handlePeakHours(ctx));

        // ─── User Management ───
        this.bot.action('admin_search_user', (ctx) => this.promptSearchUser(ctx));
        this.bot.action('admin_blacklist', (ctx) => this.promptBlacklist(ctx));
        this.bot.action('admin_whitelist', (ctx) => this.promptWhitelist(ctx));
        this.bot.action('admin_clear_history', (ctx) => this.promptClearHistory(ctx));
        this.bot.action('admin_reset_session', (ctx) => this.promptResetSession(ctx));
        this.bot.action('admin_impersonate', (ctx) => this.promptImpersonate(ctx));
        this.bot.action('admin_message_user', (ctx) => this.promptMessageUser(ctx));
        this.bot.action('admin_broadcast', (ctx) => this.promptBroadcast(ctx));

        // ─── Financial ───
        this.bot.action('admin_refund', (ctx) => this.promptRefund(ctx));
        this.bot.action('admin_adjust_tx', (ctx) => this.promptAdjustTransaction(ctx));
        this.bot.action('admin_set_limits', (ctx) => this.handleSetLimits(ctx));
        this.bot.action('admin_set_price', (ctx) => this.handleSetPrice(ctx));
        this.bot.action('admin_export', (ctx) => this.handleExportRevenue(ctx));
        this.bot.action('admin_pending_deps', (ctx) => this.handlePendingDeposits(ctx));

        // ─── SMS/OTP ───
        this.bot.action('admin_switch_provider', (ctx) => this.handleSwitchProvider(ctx));
        this.bot.action('admin_provider_balance', (ctx) => this.handleProviderBalance(ctx));
        this.bot.action('admin_retry_otp', (ctx) => this.handleRetryFailedOTP(ctx));
        this.bot.action('admin_price_by_country', (ctx) => this.handlePriceByCountry(ctx));

        // ─── Fraud & Security ───
        this.bot.action('admin_fraud_auto', (ctx) => this.handleAutoBlacklistToggle(ctx));
        this.bot.action('admin_fraud_ip', (ctx) => this.handleIPFingerprinting(ctx));
        this.bot.action('admin_fraud_velocity', (ctx) => this.handleVelocityCheck(ctx));
        this.bot.action('admin_fraud_geo', (ctx) => this.handleGeoFencing(ctx));

        // ─── Automation ───
        this.bot.action('admin_smart_refund', (ctx) => this.handleSmartRefund(ctx));
        this.bot.action('admin_provider_failover', (ctx) => this.handleProviderFailover(ctx));
        this.bot.action('admin_stale_cleaner', (ctx) => this.handleStaleSessionCleaner(ctx));

        // ─── Advanced Analytics ───
        this.bot.action('admin_cohort', (ctx) => this.handleCohortRetention(ctx));
        this.bot.action('admin_ltv', (ctx) => this.handleLTV(ctx));
        this.bot.action('admin_churn', (ctx) => this.handleChurnPrediction(ctx));
        this.bot.action('admin_revenue_country', (ctx) => this.handleRevenueByCountry(ctx));
        this.bot.action('admin_heatmap', (ctx) => this.handleHourlyHeatmap(ctx));
        this.bot.action('admin_funnel', (ctx) => this.handleConversionFunnel(ctx));

        // ─── Advanced User Management ───
        this.bot.action('admin_bulk_ops', (ctx) => this.handleBulkOperations(ctx));
        this.bot.action('admin_user_notes', (ctx) => this.promptUserNotes(ctx));
        this.bot.action('admin_referral_tree', (ctx) => this.handleReferralTree(ctx));
        this.bot.action('admin_shadow_ban', (ctx) => this.promptShadowBan(ctx));
        this.bot.action('admin_account_merge', (ctx) => this.promptAccountMerge(ctx));
        this.bot.action('admin_balance_freeze', (ctx) => this.promptBalanceFreeze(ctx));

        // ─── Business ───
        this.bot.action('admin_dynamic_price', (ctx) => this.handleDynamicPricing(ctx));
        this.bot.action('admin_promo', (ctx) => this.handlePromoCodes(ctx));
        this.bot.action('admin_commission', (ctx) => this.handleCommissionSplit(ctx));
        this.bot.action('admin_invoice', (ctx) => this.handleInvoiceGenerator(ctx));
        this.bot.action('admin_tax_export', (ctx) => this.handleTaxExport(ctx));
        this.bot.action('admin_audit', (ctx) => this.handleAuditTrail(ctx));

        // ─── DevOps ───
        this.bot.action('admin_webhook_test', (ctx) => this.handleWebhookTest(ctx));
        this.bot.action('admin_hot_reload', (ctx) => this.handleHotReload(ctx));
        this.bot.action('admin_ab_test', (ctx) => this.handleABTesting(ctx));
        this.bot.action('admin_key_rotate', (ctx) => this.handleKeyRotation(ctx));

        // ─── Navigation ───
        this.bot.action('admin_back', (ctx) => this.showDashboard(ctx));
        this.bot.action('admin_back_system', (ctx) => this.showSystemMenu(ctx));
        this.bot.action('admin_back_analytics', (ctx) => this.showAnalyticsMenu(ctx));
        this.bot.action('admin_back_users', (ctx) => this.showUsersMenu(ctx));
        this.bot.action('admin_back_finance', (ctx) => this.showFinanceMenu(ctx));
        this.bot.action('admin_back_sms', (ctx) => this.showSMSMenu(ctx));
        this.bot.action('admin_back_fraud', (ctx) => this.showFraudMenu(ctx));
        this.bot.action('admin_back_automation', (ctx) => this.showAutomationMenu(ctx));
        this.bot.action('admin_back_devops', (ctx) => this.showDevopsMenu(ctx));
    }
    
    // ═══════════════════════════════════════════════════════
    //  DASHBOARD MENUS
    // ═══════════════════════════════════════════════════════

    async showDashboard(ctx, edit = true) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) {
            return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
        }

        try {
            await ctx.answerCbQuery('🏛️ Dashboard').catch(() => {});
        } catch (e) {}

        const text = 
            `🏛️ <b>Admin Dashboard</b>\n\n` +
            `Welcome, <b>${ctx.from.first_name || 'Admin'}</b>!\n` +
            `Select a category below:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🔧 System', callback_data: 'admin_system_menu' },
                    { text: '📊 Analytics', callback_data: 'admin_analytics_menu' }
                ],
                [
                    { text: '👤 Users', callback_data: 'admin_users_menu' },
                    { text: '💰 Finance', callback_data: 'admin_finance_menu' }
                ],
                [
                    { text: '📱 SMS/OTP', callback_data: 'admin_sms_menu' },
                    { text: '🛡️ Fraud & Security', callback_data: 'admin_fraud_menu' }
                ],
                [
                    { text: '🤖 Automation', callback_data: 'admin_automation_menu' },
                    { text: '⚙️ DevOps', callback_data: 'admin_devops_menu' }
                ]
            ]
        };

        try {
            if (edit && ctx.callbackQuery) {
                await safeEditWithImage(ctx, text, { reply_markup: keyboard });
            } else {
                await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: text, parse_mode: 'HTML', reply_markup: keyboard });
            }
        } catch (err) {
            logger.error('showDashboard error', { error: err.message });
            try {
                await ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: text, parse_mode: 'HTML', reply_markup: keyboard });
            } catch (e) {}
        }
    }

    // ─── System Sub-Menu ───
    async showSystemMenu(ctx) {
        try {
            await ctx.answerCbQuery('🔧 System').catch(() => {});
            const text = `🔧 <b>System & Maintenance</b>\n\nManage bot health and operations:`;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔧 Fix Balances', callback_data: 'admin_fix_balances' },
                        { text: '🏥 Health Check', callback_data: 'admin_health' }
                    ],
                    [
                        { text: '🔄 Restart Bot', callback_data: 'admin_restart' },
                        { text: '🛠️ Maintenance', callback_data: 'admin_maintenance' }
                    ],
                    [
                        { text: '📜 View Logs', callback_data: 'admin_logs' },
                        { text: '🧹 Clear Cache', callback_data: 'admin_clear_cache' }
                    ],
                    [
                        { text: '💾 Backup DB', callback_data: 'admin_backup' },
                        { text: '⚡ Workers', callback_data: 'admin_workers' }
                    ],
                    [{ text: '◀️ Back', callback_data: 'admin_back' }]
                ]
            };
            await safeEditWithImage(ctx, text, { reply_markup: keyboard });
        } catch (err) {
            logger.error('showSystemMenu error', { error: err.message });
            ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    }

    // ─── Analytics Sub-Menu ───
    async showAnalyticsMenu(ctx) {
        try {
            await ctx.answerCbQuery('📊 Analytics').catch(() => {});
            const text = `📊 <b>Analytics & Stats</b>\n\nView performance metrics:`;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📊 24h Stats', callback_data: 'admin_stats' },
                        { text: '📈 7d Stats', callback_data: 'admin_stats_7d' }
                    ],
                    [
                        { text: '📉 30d Stats', callback_data: 'admin_stats_30d' },
                        { text: '🏆 Top Users', callback_data: 'admin_top_users' }
                    ],
                    [
                        { text: '✅ OTP Success', callback_data: 'admin_otp_success' },
                        { text: '📡 Provider Perf', callback_data: 'admin_provider_perf' }
                    ],
                    [
                        { text: '⏰ Peak Hours', callback_data: 'admin_peak_hours' },
                        { text: '🌍 By Country', callback_data: 'admin_revenue_country' }
                    ],
                    [
                        { text: '🔥 Heatmap', callback_data: 'admin_heatmap' },
                        { text: '📉 Funnel', callback_data: 'admin_funnel' }
                    ],
                    [{ text: '◀️ Back', callback_data: 'admin_back' }]
                ]
            };
            await safeEditWithImage(ctx, text, { reply_markup: keyboard });
        } catch (err) {
            logger.error('showAnalyticsMenu error', { error: err.message });
            ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    }

    // ─── Users Sub-Menu ───
    async showUsersMenu(ctx) {
        try {
            await ctx.answerCbQuery('👤 Users').catch(() => {});
            const text = `👤 <b>User Management</b>\n\nManage individual users:`;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔍 Search User', callback_data: 'admin_search_user' },
                        { text: '📋 User Notes', callback_data: 'admin_user_notes' }
                    ],
                    [
                        { text: '🚫 Blacklist', callback_data: 'admin_blacklist' },
                        { text: '✅ Whitelist', callback_data: 'admin_whitelist' }
                    ],
                    [
                        { text: '🧹 Clear History', callback_data: 'admin_clear_history' },
                        { text: '♻️ Reset Session', callback_data: 'admin_reset_session' }
                    ],
                    [
                        { text: '🎭 Impersonate', callback_data: 'admin_impersonate' },
                        { text: '💬 Message User', callback_data: 'admin_message_user' }
                    ],
                    [
                        { text: '📢 Broadcast', callback_data: 'admin_broadcast' },
                        { text: '📦 Bulk Ops', callback_data: 'admin_bulk_ops' }
                    ],
                    [
                        { text: '🌳 Referral Tree', callback_data: 'admin_referral_tree' },
                        { text: '👻 Shadow Ban', callback_data: 'admin_shadow_ban' }
                    ],
                    [
                        { text: '🔒 Freeze Balance', callback_data: 'admin_balance_freeze' },
                        { text: '🔗 Merge Accounts', callback_data: 'admin_account_merge' }
                    ],
                    [{ text: '◀️ Back', callback_data: 'admin_back' }]
                ]
            };
            await safeEditWithImage(ctx, text, { reply_markup: keyboard });
        } catch (err) {
            logger.error('showUsersMenu error', { error: err.message });
            ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    }

    // ─── Finance Sub-Menu ───
    async showFinanceMenu(ctx) {
        try {
            await ctx.answerCbQuery('💰 Finance').catch(() => {});
            const text = `💰 <b>Financial Control</b>\n\nManage money operations:`;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '↩️ Manual Refund', callback_data: 'admin_refund' },
                        { text: '✏️ Adjust TX', callback_data: 'admin_adjust_tx' }
                    ],
                    [
                        { text: '📊 Set Limits', callback_data: 'admin_set_limits' },
                        { text: '🏷️ Set Price', callback_data: 'admin_set_price' }
                    ],
                    [
                        { text: '📥 Export Rev', callback_data: 'admin_export' },
                        { text: '⏳ Pending Deps', callback_data: 'admin_pending_deps' }
                    ],
                    [
                        { text: '🎫 Promo Codes', callback_data: 'admin_promo' },
                        { text: '💹 Dynamic Price', callback_data: 'admin_dynamic_price' }
                    ],
                    [
                        { text: '🧾 Invoice', callback_data: 'admin_invoice' },
                        { text: '📑 Tax Export', callback_data: 'admin_tax_export' }
                    ],
                    [{ text: '◀️ Back', callback_data: 'admin_back' }]
                ]
            };
            await safeEditWithImage(ctx, text, { reply_markup: keyboard });
        } catch (err) {
            logger.error('showFinanceMenu error', { error: err.message });
            ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    }

    // ─── SMS/OTP Sub-Menu ───
    async showSMSMenu(ctx) {
        try {
            a





                // ═══════════════════════════════════════════════════════
    //  ANALYTICS FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 9. 24h Stats ───
    async handleStats(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📊 Loading stats...');

        try {
            const { Transaction } = await import('../../models/index.js');
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

            const [revenue, deposits, pendingLocks] = await Promise.all([
                Transaction.calculateRevenue(since),
                Transaction.aggregate([
                    { $match: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { $gte: since } } },
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
                ]),
                Transaction.countDocuments({ type: 'LOCK', status: 'PENDING' })
            ]);

            const depositTotal = deposits[0]?.total || 0;
            const depositCount = deposits[0]?.count || 0;
            const net = depositTotal - (revenue.total || 0);

            const text = 
                `📊 <b>24h Statistics</b>\n\n` +
                `💰 Revenue: <b>$${revenue.total?.toFixed(2) || '0.00'}</b> (${revenue.count || 0} tx)\n` +
                `💳 Deposits: <b>$${depositTotal.toFixed(2)}</b> (${depositCount} tx)\n` +
                `🔒 Pending Locks: <b>${pendingLocks}</b>\n` +
                `📈 Net: <b>$${net.toFixed(2)}</b>\n\n` +
                `⏰ Updated: <i>${new Date().toLocaleString()}</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📈 7d', callback_data: 'admin_stats_7d' },
                            { text: '📉 30d', callback_data: 'admin_stats_30d' }
                        ],
                        [{ text: '🔄 Refresh', callback_data: 'admin_stats' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Stats failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 10. 7-Day Stats ───
    async handleStats7d(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📈 Loading 7d stats...');

        try {
            const { Transaction } = await import('../../models/index.js');
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            const [revenue, deposits, pendingLocks] = await Promise.all([
                Transaction.calculateRevenue(since),
                Transaction.aggregate([
                    { $match: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { $gte: since } } },
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
                ]),
                Transaction.countDocuments({ type: 'LOCK', status: 'PENDING' })
            ]);

            const depositTotal = deposits[0]?.total || 0;
            const depositCount = deposits[0]?.count || 0;
            const net = depositTotal - (revenue.total || 0);

            const text = 
                `📈 <b>7-Day Statistics</b>\n\n` +
                `💰 Revenue: <b>$${revenue.total?.toFixed(2) || '0.00'}</b> (${revenue.count || 0} tx)\n` +
                `💳 Deposits: <b>$${depositTotal.toFixed(2)}</b> (${depositCount} tx)\n` +
                `🔒 Pending Locks: <b>${pendingLocks}</b>\n` +
                `📈 Net: <b>$${net.toFixed(2)}</b>\n\n` +
                `⏰ Updated: <i>${new Date().toLocaleString()}</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📊 24h', callback_data: 'admin_stats' },
                            { text: '📉 30d', callback_data: 'admin_stats_30d' }
                        ],
                        [{ text: '🔄 Refresh', callback_data: 'admin_stats_7d' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('7d stats failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 11. 30-Day Stats ───
    async handleStats30d(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📉 Loading 30d stats...');

        try {
            const { Transaction } = await import('../../models/index.js');
            const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

            const [revenue, deposits, pendingLocks] = await Promise.all([
                Transaction.calculateRevenue(since),
                Transaction.aggregate([
                    { $match: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { $gte: since } } },
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
                ]),
                Transaction.countDocuments({ type: 'LOCK', status: 'PENDING' })
            ]);

            const depositTotal = deposits[0]?.total || 0;
            const depositCount = deposits[0]?.count || 0;
            const net = depositTotal - (revenue.total || 0);

            const text = 
                `📉 <b>30-Day Statistics</b>\n\n` +
                `💰 Revenue: <b>$${revenue.total?.toFixed(2) || '0.00'}</b> (${revenue.count || 0} tx)\n` +
                `💳 Deposits: <b>$${depositTotal.toFixed(2)}</b> (${depositCount} tx)\n` +
                `🔒 Pending Locks: <b>${pendingLocks}</b>\n` +
                `📈 Net: <b>$${net.toFixed(2)}</b>\n\n` +
                `⏰ Updated: <i>${new Date().toLocaleString()}</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📊 24h', callback_data: 'admin_stats' },
                            { text: '📈 7d', callback_data: 'admin_stats_7d' }
                        ],
                        [{ text: '🔄 Refresh', callback_data: 'admin_stats_30d' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('30d stats failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 12. Top Users by Volume ───
    async handleTopUsers(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🏆 Loading top users...');

        try {
            const { User } = await import('../../models/index.js');
            
            const topUsers = await User.find()
                .sort({ totalSpent: -1 })
                .limit(10)
                .select('userId firstName totalSpent totalDeposited balance');

            let text = `🏆 <b>Top 10 Users by Volume</b>\n\n`;
            
            if (topUsers.length === 0) {
                text += `<i>No users found.</i>`;
            } else {
                topUsers.forEach((u, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    text += `${medal} <code>${u.userId}</code>\n` +
                           `   💰 Spent: <b>$${u.totalSpent?.toFixed(2) || '0.00'}</b>\n` +
                           `   📥 Deposited: <b>$${u.totalDeposited?.toFixed(2) || '0.00'}</b>\n` +
                           `   💳 Balance: <b>$${u.balance?.toFixed(2) || '0.00'}</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_top_users' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Top users failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 13. OTP Success Rate ───
    async handleOTPSuccessRate(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('✅ Analyzing OTP success...');

        try {
            const { Transaction } = await import('../../models/index.js');
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            
            const [total, success, failed] = await Promise.all([
                Transaction.countDocuments({ type: 'OTP', createdAt: { $gte: since } }),
                Transaction.countDocuments({ type: 'OTP', status: 'COMPLETED', createdAt: { $gte: since } }),
                Transaction.countDocuments({ type: 'OTP', status: 'FAILED', createdAt: { $gte: since } })
            ]);

            const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';

            const text = 
                `✅ <b>OTP Success Rate (24h)</b>\n\n` +
                `📊 Total Requests: <b>${total}</b>\n` +
                `✅ Completed: <b>${success}</b>\n` +
                `❌ Failed: <b>${failed}</b>\n` +
                `📈 Success Rate: <b>${successRate}%</b>\n\n` +
                `${parseFloat(successRate) < 80 ? '⚠️ <i>Success rate is low. Check providers.</i>' : '🎉 <i>Great success rate!</i>'}`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_otp_success' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('OTP success rate failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 14. Provider Performance ───
    async handleProviderPerformance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📡 Analyzing providers...');

        try {
            const { Transaction } = await import('../../models/index.js');
            
            const providerStats = await Transaction.aggregate([
                { $match: { type: 'OTP', createdAt: { $gte: new Date(Date.now() - 24*60*60*1000) } } },
                { $group: { 
                    _id: '$provider', 
                    total: { $sum: 1 }, 
                    success: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
                    avgTime: { $avg: '$duration' }
                }}
            ]);

            let text = `📡 <b>SMS Provider Performance (24h)</b>\n\n`;
            
            if (providerStats.length === 0) {
                text += `<i>No OTP data in last 24h.</i>`;
            } else {
                providerStats.forEach(p => {
                    const rate = ((p.success / p.total) * 100).toFixed(1);
                    const avg = p.avgTime ? `${p.avgTime.toFixed(1)}s` : 'N/A';
                    text += `📱 <b>${p._id || 'Unknown'}</b>\n` +
                           `   ✅ Success: <b>${rate}%</b> (${p.success}/${p.total})\n` +
                           `   ⏱️ Avg Time: <b>${avg}</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_provider_perf' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Provider perf failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 15. Peak Hours ───
    async handlePeakHours(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('⏰ Analyzing peak hours...');

        try {
            const { Transaction } = await import('../../models/index.js');
            
            const hourly = await Transaction.aggregate([
                { $match: { createdAt: { $gte: new Date(Date.now() - 7*24*60*60*1000) } } },
                { $group: { 
                    _id: { $hour: '$createdAt' }, 
                    count: { $sum: 1 } 
                }},
                { $sort: { _id: 1 } }
            ]);

            let text = `⏰ <b>Peak Hours (7 days)</b>\n\n`;
            const maxCount = Math.max(...hourly.map(h => h.count), 1);
            
            hourly.forEach(h => {
                const bar = '█'.repeat(Math.round((h.count / maxCount) * 10));
                const hour = h._id.toString().padStart(2, '0');
                text += `${hour}:00 ${bar} <b>${h.count}</b>\n`;
            });

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_peak_hours' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Peak hours failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  USER MANAGEMENT FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 16. Search User ───
    async promptSearchUser(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingSearchUser = true;
        
        await safeEditWithImage(ctx,
            `🔍 <b>Search User</b>\n\n` +
            `Send <b>User ID</b>, <b>Username</b>, or <b>Wallet Address</b> to search.\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processSearchUser(ctx, query) {
        try {
            const { User } = await import('../../models/index.js');
            
            let user;
            if (/^\d+$/.test(query)) {
                user = await User.findOne({ userId: query });
            } else if (query.startsWith('0x')) {
                user = await User.findOne({ walletAddress: query });
            } else {
                user = await User.findOne({ username: query.replace('@', '') });
            }

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ No user found for: <code>${query}</code>`, 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                });
            }

            const text = 
                `👤 <b>User Found</b>\n\n` +
                `🆔 ID: <code>${user.userId}</code>\n` +
                `👤 Name: <b>${user.firstName || 'N/A'} ${user.lastName || ''}</b>\n` +
                `📛 Username: <b>@${user.username || 'N/A'}</b>\n` +
                `💰 Balance: <b>$${user.balance?.toFixed(2) || '0.00'}</b>\n` +
                `🔒 Locked: <b>$${user.lockedBalance?.toFixed(2) || '0.00'}</b>\n` +
                `📊 Total Spent: <b>$${user.totalSpent?.toFixed(2) || '0.00'}</b>\n` +
                `📥 Total Deposited: <b>$${user.totalDeposited?.toFixed(2) || '0.00'}</b>\n` +
                `🚫 Blacklisted: <b>${user.blacklisted ? 'YES 🔴' : 'No 🟢'}</b>\n` +
                `👑 VIP: <b>${user.isVip ? 'YES 🟢' : 'No'}</b>\n` +
                `📅 Joined: <i>${user.createdAt?.toLocaleDateString() || 'N/A'}</i>\n` +
                `📱 Last Active: <i>${user.lastActive?.toLocaleDateString() || 'N/A'}</i>`;

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: text,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '💰 Add Balance', callback_data: `admin_add_bal_${user.userId}` },
                            { text: '💸 Deduct', callback_data: `admin_ded_bal_${user.userId}` }
                        ],
                        [
                            { text: '🚫 Blacklist', callback_data: `admin_blacklist_${user.userId}` },
                            { text: '💬 Message', callback_data: `admin_msg_${user.userId}` }
                        ],
                        [{ text: '◀️ Back to Users', callback_data: 'admin_back_users' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Search user failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 17. Add Balance ───
    async promptAddBalance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingAddBalance = true;
        
        await safeEditWithImage(ctx,
            `💰 <b>Add Balance</b>\n\n` +
            `Send: <code>USER_ID AMOUNT</code>\n` +
            `Example: <code>123456789 50.00</code>\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processAddBalance(ctx, targetId, amount, reason = 'Admin credit') {
        try {
            const { User, Transaction } = await import('../../models/index.js');
            
            const us





                // ═══════════════════════════════════════════════════════
    //  FRAUD & SECURITY FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 37. Auto-Blacklist Toggle ───
    async handleAutoBlacklistToggle(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        const current = config.autoBlacklist || false;
        config.autoBlacklist = !current;
        
        const status = config.autoBlacklist ? '🟢 ENABLED' : '🔴 DISABLED';
        await ctx.answerCbQuery(`Auto-blacklist: ${status}`, { show_alert: true });

        await safeEditWithImage(ctx,
            `🤖 <b>Auto-Blacklist System</b>\n\n` +
            `Status: <b>${status}</b>\n\n` +
            `📋 <b>Rules:</b>\n` +
            `• >3 failed OTPs in 10 min → Auto-ban\n` +
            `• >5 deposits in 1 hour → Flag for review\n` +
            `• Rapid-fire commands (>20/min) → Temp ban\n\n` +
            `${config.autoBlacklist 
                ? '✅ Bot will automatically enforce these rules.' 
                : '🔒 Manual review required for all cases.'}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ 
                            text: config.autoBlacklist ? '🔴 Disable' : '🟢 Enable', 
                            callback_data: 'admin_fraud_auto' 
                        }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            }
        );
    }

    // ─── 38. IP/Device Fingerprinting ───
    async handleIPFingerprinting(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📍 Analyzing fingerprints...');

        try {
            const { User } = await import('../../models/index.js');
            
            const suspicious = await User.aggregate([
                { $match: { lastIP: { $exists: true } } },
                { $group: { 
                    _id: '$lastIP', 
                    count: { $sum: 1 }, 
                    users: { $push: '$userId' } 
                }},
                { $match: { count: { $gt: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            let text = `📍 <b>IP Fingerprinting</b>\n\n`;
            
            if (suspicious.length === 0) {
                text += `<i>No multi-account IPs detected.</i>`;
            } else {
                text += `⚠️ <b>${suspicious.length} suspicious IPs found:</b>\n\n`;
                suspicious.forEach(s => {
                    text += `🌐 <code>${s._id}</code>\n` +
                           `   👥 Accounts: <b>${s.count}</b>\n` +
                           `   🔗 IDs: <code>${s.users.slice(0, 3).join(', ')}${s.users.length > 3 ? '...' : ''}</code>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_fraud_ip' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('IP fingerprint failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    }

    // ─── 39. Velocity Checks ───
    async handleVelocityCheck(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('⚡ Checking velocity...');

        try {
            const { Transaction } = await import('../../models/index.js');
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            
            const velocity = await Transaction.aggregate([
                { $match: { type: 'OTP', createdAt: { $gte: oneHourAgo } } },
                { $group: { 
                    _id: '$userId', 
                    count: { $sum: 1 } 
                }},
                { $match: { count: { $gt: 5 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            let text = `⚡ <b>Velocity Alerts (1h)</b>\n\n`;
            
            if (velocity.length === 0) {
                text += `<i>No suspicious velocity detected.</i>`;
            } else {
                text += `⚠️ <b>${velocity.length} users with >5 OTPs/hour:</b>\n\n`;
                velocity.forEach(v => {
                    text += `👤 <code>${v._id}</code>: <b>${v.count}</b> requests\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_fraud_velocity' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Velocity check failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    }

    // ─── 40. Geo-Fencing ───
    async handleGeoFencing(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🌍 Checking geo-fence...');

        try {
            const { User } = await import('../../models/index.js');
            
            const blockedCountries = config.blockedCountries || ['CN', 'KP', 'IR'];
            const flagged = await User.countDocuments({ countryCode: { $in: blockedCountries } });

            const text = 
                `🌍 <b>Geo-Fencing</b>\n\n` +
                `🚫 Blocked Countries: <b>${blockedCountries.join(', ')}</b>\n` +
                `⚠️ Flagged Users: <b>${flagged}</b>\n\n` +
                `<i>Users from blocked countries are automatically restricted.</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⚙️ Edit Countries', callback_data: 'admin_geo_settings' }],
                        [{ text: '🔄 Refresh', callback_data: 'admin_fraud_geo' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Geo-fencing failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  AUTOMATION FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 41. Smart Refund Bot ───
    async handleSmartRefund(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🧠 Checking smart refunds...');

        try {
            const { Transaction } = await import('../../models/index.js');
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            
            const stuck = await Transaction.find({
                type: 'DEPOSIT',
                status: 'PENDING',
                createdAt: { $lt: oneDayAgo }
            }).limit(10);

            let text = `🧠 <b>Smart Refund Candidates</b>\n\n`;
            
            if (stuck.length === 0) {
                text += `<i>No stuck deposits found. All good!</i>`;
            } else {
                text += `⚠️ <b>${stuck.length} stuck deposits (>24h):</b>\n\n`;
                stuck.forEach((tx, i) => {
                    text += `${i + 1}. <code>${tx.userId}</code>\n` +
                           `   💰 Amount: <b>$${tx.amount?.toFixed(2) || '0.00'}</b>\n` +
                           `   ⏰ Age: <b>${Math.floor((Date.now() - tx.createdAt) / 3600000)}h</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💰 Auto-Refund All', callback_data: 'admin_smart_refund_all' }],
                        [{ text: '🔄 Refresh', callback_data: 'admin_smart_refund' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Smart refund failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 42. Provider Failover ───
    async handleProviderFailover(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔀 Checking failover...');

        try {
            if (!this.smsProviderManager) {
                throw new Error('SMS Provider Manager not initialized');
            }

            const settings = await this.smsProviderManager.getFailoverSettings();
            const current = settings.enabled ? '🟢 ENABLED' : '🔴 DISABLED';

            await safeEditWithImage(ctx,
                `🔀 <b>Provider Failover</b>\n\n` +
                `Status: <b>${current}</b>\n\n` +
                `📋 <b>Settings:</b>\n` +
                `• Trigger: Success rate < <b>${settings.threshold || 80}%</b>\n` +
                `• Check interval: <b>${settings.interval || 5} min</b>\n` +
                `• Fallback order: <b>${settings.fallbackOrder?.join(' → ') || 'Not set'}</b>\n\n` +
                `💡 When primary fails, bot auto-switches to next provider.`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ 
                                text: settings.enabled ? '🔴 Disable' : '🟢 Enable', 
                                callback_data: 'admin_provider_failover' 
                            }],
                            [{ text: '⚙️ Edit Settings', callback_data: 'admin_provider_failover_settings' }],
                            [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                        ]
                    }
                }
            );

        } catch (error) {
            logger.error('Provider failover failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 43. Stale Session Cleaner ───
    async handleStaleSessionCleaner(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🧹 Cleaning stale sessions...');

        try {
            const { Session } = await import('../../models/index.js');
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            
            const result = await Session.updateMany(
                { status: { $in: ['WAITING', 'CHECKING'] }, updatedAt: { $lt: oneHourAgo } },
                { $set: { status: 'EXPIRED', expiredAt: new Date() } }
            );

            const text = 
                `🧹 <b>Stale Session Cleaner</b>\n\n` +
                `⏰ Sessions older than 1 hour cleaned.\n\n` +
                `🗑️ Expired: <b>${result.modifiedCount}</b> sessions\n\n` +
                `<i>Users will need to restart their OTP request.</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🧹 Clean Again', callback_data: 'admin_stale_cleaner' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Stale cleaner failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  ADVANCED ANALYTICS FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 44. Cohort Retention ───
    async handleCohortRetention(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('👥 Analyzing cohorts...');

        try {
            const { User } = await import('../../models/index.js');
            
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const newUsers = await User.countDocuments({ createdAt: { $gte: sevenDaysAgo } });
            const activeNew = await User.countDocuments({ 
                createdAt: { $gte: sevenDaysAgo },
                lastActive: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            });

            const retention = newUsers > 0 ? ((activeNew / newUsers) * 100).toFixed(1) : '0.0';

            const text = 
                `👥 <b>Cohort Retention (7-Day)</b>\n\n` +
                `🆕 New Users: <b>${newUsers}</b>\n` +
                `✅ Active Today: <b>${activeNew}</b>\n` +
                `📈 Retention: <b>${retention}%</b>\n\n` +
                `${parseFloat(retention) < 30 ? '⚠️ Retention is low. Consider onboarding improvements.' : '🎉 Good retention rate!'}`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_cohort' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Cohort retention failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 45. LTV per User ───
    async handleLTV(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('💎 Analyzing LTV...');

        try {
            const { User } = await import('../../models/index.js');
            
            const avgLTV = await User.aggregate([
                { $match: { totalSpent: { $gt: 0 } } },
                { $group: { _id: null, avg: { $avg: '$totalSpent' }, max: { $max: '$totalSpent' } } }
            ]);

            const avg = avgLTV[0]?.avg || 0;
            const max = avgLTV[0]?.max || 0;

            const text = 
                `💎 <b>Lifetime Value (LTV) Analysis</b>\n\n` +
                `📊 Average LTV: <b>$${avg.toFixed(2)}</b>\n` +
                `🏆 Highest LTV: <b>$${max.toFixed(2)}</b>\n\n` +
                `<i>LTV = Total Spent - Total Deposited</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_ltv' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('LTV failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 46. Churn Prediction ───
    async handleChurnPrediction(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📉 Analyzing churn...');

        try {
            const { User } = await import('../../models/index.js');
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            
            const churnRisk = await User.find({
                lastActive: { $lt: sevenDaysAgo },
                totalSpent: { $gt: 0 },
                blacklisted: { $ne: true }
            }).sort({ totalSpent: -1 }).limit(20);

            let text = `📉 <b>Churn Risk Users</b>\n\n` +
                       `Users inactive >7 days but previously spent:\n\n`;

            if (churnRisk.length === 0) {
                text += `<i>No churn risk users. Great retention!</i>`;
            } else {
                churnRisk.forEach((u, i) => {
                    const daysSince = u.lastActive 
                        ? Math.floor((Date.now() - u.lastActive) / 86400000) 
                        : 'N/A';
                    text += `${i + 1}. <code>${u.userId}</code>\n` +
                           `   💰 LTV: <b>$${u.totalSpent?.toFixed(2) || '0.00'}</b>\n` +
                           `   📅 Last active: <b>${daysSince} days ago</b>\n` +
                           `   💬 <i>Consider re-engagement message</i>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📢 Message All', callback_data: 'admin_churn_message_all' }],
                        [{ text: '🔄 Refresh', callback_data: 'admin_churn' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Churn prediction failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 47. Revenue by Country ───
    async handleRevenueByCountry(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🌍 Analyzing by country...');

        try {
            const { Transaction, User } = await import('../../models/index.js');
            
            const byCountry = await Transaction.aggregate([
                { $match: { type: 'DEPOSIT', status: 'COMPLETED' } },
                { $lookup: { from: 'users', localField: 'userId', foreignField: 'userId', as: 'user' } },
                { $unwind: '$user' },
                { $group: { _id: '$user.countryCode', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    
