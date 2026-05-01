// ═══════════════════════════════════════════════════════════
//  bot/commands/extra.js — Advanced Admin Dashboard
// ═══════════════════════════════════════════════════════════

import { fixNegativeLockedBalances } from '../scripts/index.js';
import logger from '../utils/logger.js';
import config from '../config/env.js';

// ─── SAFE EDIT HELPER ───
// Prevents "no text in the message to edit" crashes
async function safeEditMessage(ctx, text, extra = {}) {
    try {
        // Try to edit existing message text
        if (ctx.callbackQuery?.message?.text !== undefined) {
            return await ctx.editMessageText(text, extra);
        }
        // If message has no text (photo, deleted, etc.), send new message
        return await ctx.reply(text, extra);
    } catch (err) {
        // If edit fails because no text exists, send new message instead
        if (err.message?.includes('there is no text in the message') || 
            err.message?.includes('message to edit') ||
            err.message?.includes('MESSAGE_NOT_MODIFIED')) {
            return await ctx.reply(text, extra);
        }
        // For other errors, log and send new message
        logger.error('safeEditMessage failed', { error: err.message });
        return await ctx.reply(text, extra);
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
        // Main dashboard entry point — replaces /admin slash command
        this.bot.action('admin_dashboard', (ctx) => this.showDashboard(ctx));
        
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

        // ─── NEW: Fraud & Security ───
        this.bot.action('admin_fraud_auto', (ctx) => this.handleAutoBlacklistToggle(ctx));
        this.bot.action('admin_fraud_ip', (ctx) => this.handleIPFingerprinting(ctx));
        this.bot.action('admin_fraud_velocity', (ctx) => this.handleVelocityCheck(ctx));
        this.bot.action('admin_fraud_geo', (ctx) => this.handleGeoFencing(ctx));

        // ─── NEW: Automation ───
        this.bot.action('admin_smart_refund', (ctx) => this.handleSmartRefund(ctx));
        this.bot.action('admin_provider_failover', (ctx) => this.handleProviderFailover(ctx));
        this.bot.action('admin_stale_cleaner', (ctx) => this.handleStaleSessionCleaner(ctx));

        // ─── NEW: Advanced Analytics ───
        this.bot.action('admin_cohort', (ctx) => this.handleCohortRetention(ctx));
        this.bot.action('admin_ltv', (ctx) => this.handleLTV(ctx));
        this.bot.action('admin_churn', (ctx) => this.handleChurnPrediction(ctx));
        this.bot.action('admin_revenue_country', (ctx) => this.handleRevenueByCountry(ctx));
        this.bot.action('admin_heatmap', (ctx) => this.handleHourlyHeatmap(ctx));
        this.bot.action('admin_funnel', (ctx) => this.handleConversionFunnel(ctx));

        // ─── NEW: Advanced User Management ───
        this.bot.action('admin_bulk_ops', (ctx) => this.handleBulkOperations(ctx));
        this.bot.action('admin_user_notes', (ctx) => this.promptUserNotes(ctx));
        this.bot.action('admin_referral_tree', (ctx) => this.handleReferralTree(ctx));
        this.bot.action('admin_shadow_ban', (ctx) => this.promptShadowBan(ctx));
        this.bot.action('admin_account_merge', (ctx) => this.promptAccountMerge(ctx));
        this.bot.action('admin_balance_freeze', (ctx) => this.promptBalanceFreeze(ctx));

        // ─── NEW: Business ───
        this.bot.action('admin_dynamic_price', (ctx) => this.handleDynamicPricing(ctx));
        this.bot.action('admin_promo', (ctx) => this.handlePromoCodes(ctx));
        this.bot.action('admin_commission', (ctx) => this.handleCommissionSplit(ctx));
        this.bot.action('admin_invoice', (ctx) => this.handleInvoiceGenerator(ctx));
        this.bot.action('admin_tax_export', (ctx) => this.handleTaxExport(ctx));
        this.bot.action('admin_audit', (ctx) => this.handleAuditTrail(ctx));

        // ─── NEW: DevOps ───
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
    }

    // ═══════════════════════════════════════════════════════
    //  DASHBOARD MENUS
    // ═══════════════════════════════════════════════════════

    async showDashboard(ctx, edit = true) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) {
            return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
        }

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

        if (edit && ctx.callbackQuery) {
            await safeEditMessage(ctx, text, { 
                parse_mode: 'HTML', 
                reply_markup: keyboard 
            });
        } else {
            await ctx.reply(text, { 
                parse_mode: 'HTML', 
                reply_markup: keyboard 
            });
        }
        ctx.answerCbQuery().catch(() => {});
    }

    // ─── System Sub-Menu ───
    async showSystemMenu(ctx) {
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
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
        ctx.answerCbQuery().catch(() => {});
    }

    // ─── Analytics Sub-Menu ───
    async showAnalyticsMenu(ctx) {
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
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
        ctx.answerCbQuery().catch(() => {});
    }

    // ─── Users Sub-Menu ───
    async showUsersMenu(ctx) {
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
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
        ctx.answerCbQuery().catch(() => {});
    }

    // ─── Finance Sub-Menu ───
    async showFinanceMenu(ctx) {
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
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
        ctx.answerCbQuery().catch(() => {});
    }

    // ─── SMS/OTP Sub-Menu ───
    async showSMSMenu(ctx) {
        const text = `📱 <b>SMS/OTP Management</b>\n\nControl SMS operations:`;
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🔄 Switch Provider', callback_data: 'admin_switch_provider' },
                    { text: '💳 Provider Bal', callback_data: 'admin_provider_balance' }
                ],
                [
                    { text: '🔄 Retry Failed', callback_data: 'admin_retry_otp' },
                    { text: '🌍 Price/Country', callback_data: 'admin_price_by_country' }
                ],
                [{ text: '◀️ Back', callback_data: 'admin_back' }]
            ]
        };
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
        ctx.answerCbQuery().catch(() => {});
    }

    // ─── Fraud & Security Sub-Menu ───
    async showFraudMenu(ctx) {
        const text = `🛡️ <b>Fraud Detection & Security</b>\n\nProtect against abuse:`;
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🤖 Auto-Blacklist', callback_data: 'admin_fraud_auto' },
                    { text: '📍 IP Fingerprint', callback_data: 'admin_fraud_ip' }
                ],
                [
                    { text: '⚡ Velocity Check', callback_data: 'admin_fraud_velocity' },
                    { text: '🌍 Geo-Fence', callback_data: 'admin_fraud_geo' }
                ],
                [{ text: '◀️ Back', callback_data: 'admin_back' }]
            ]
        };
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
        ctx.answerCbQuery().catch(() => {});
    }

    // ─── Automation Sub-Menu ───
    async showAutomationMenu(ctx) {
        const text = `🤖 <b>Automation</b>\n\nSet up auto-pilot features:`;
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🧠 Smart Refund', callback_data: 'admin_smart_refund' },
                    { text: '🔀 Provider Failover', callback_data: 'admin_provider_failover' }
                ],
                [
                    { text: '🧹 Stale Cleaner', callback_data: 'admin_stale_cleaner' },
                    { text: '📉 Churn Predict', callback_data: 'admin_churn' }
                ],
                [
                    { text: '👥 Cohort Retention', callback_data: 'admin_cohort' },
                    { text: '💎 LTV Analysis', callback_data: 'admin_ltv' }
                ],
                [{ text: '◀️ Back', callback_data: 'admin_back' }]
            ]
        };
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
        ctx.answerCbQuery().catch(() => {});
    }

    // ─── DevOps Sub-Menu ───
    async showDevopsMenu(ctx) {
        const text = `⚙️ <b>DevOps & Integrations</b>\n\nSystem operations:`;
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🔔 Webhook Test', callback_data: 'admin_webhook_test' },
                    { text: '♻️ Hot Reload', callback_data: 'admin_hot_reload' }
                ],
                [
                    { text: '🧪 A/B Testing', callback_data: 'admin_ab_test' },
                    { text: '🔑 Key Rotation', callback_data: 'admin_key_rotate' }
                ],
                [{ text: '◀️ Back', callback_data: 'admin_back' }]
            ]
        };
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
        ctx.answerCbQuery().catch(() => {});
    }

    // ══════════════════════════════════
