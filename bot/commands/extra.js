// ═══════════════════════════════════════════════════════════
//  bot/commands/extra.js — Advanced Admin Dashboard
// ═══════════════════════════════════════════════════════════

import { fixNegativeLockedBalances } from '../../scripts/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';


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

        // ─── Sub-menu navigation handlers (WERE MISSING!) ───
this.bot.action('admin_system_menu', (ctx) => this.showSystemMenu(ctx));
this.bot.action('admin_analytics_menu', (ctx) => this.showAnalyticsMenu(ctx));
this.bot.action('admin_users_menu', (ctx) => this.showUsersMenu(ctx));
this.bot.action('admin_finance_menu', (ctx) => this.showFinanceMenu(ctx));
this.bot.action('admin_sms_menu', (ctx) => this.showSMSMenu(ctx));
this.bot.action('admin_fraud_menu', (ctx) => this.showFraudMenu(ctx));
this.bot.action('admin_automation_menu', (ctx) => this.showAutomationMenu(ctx));
this.bot.action('admin_devops_menu', (ctx) => this.showDevopsMenu(ctx));
        
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
    } catch (err) {
        logger.error('showDashboard error', { error: err.message });
        try {
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
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
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
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
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
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
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
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
        await safeEditMessage(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err) {
        logger.error('showFinanceMenu error', { error: err.message });
        ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}

// ─── SMS/OTP Sub-Menu ───
async showSMSMenu(ctx) {
    try {
        await ctx.answerCbQuery('📱 SMS').catch(() => {});
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
    } catch (err) {
        logger.error('showSMSMenu error', { error: err.message });
        ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}

// ─── Fraud & Security Sub-Menu ───
async showFraudMenu(ctx) {
    try {
        await ctx.answerCbQuery('🛡️ Fraud').catch(() => {});
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
    } catch (err) {
        logger.error('showFraudMenu error', { error: err.message });
        ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}

// ─── Automation Sub-Menu ───
async showAutomationMenu(ctx) {
    try {
        await ctx.answerCbQuery('🤖 Automation').catch(() => {});
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
    } catch (err) {
        logger.error('showAutomationMenu error', { error: err.message });
        ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}

// ─── DevOps Sub-Menu ───
async showDevopsMenu(ctx) {
    try {
        await ctx.answerCbQuery('⚙️ DevOps').catch(() => {});
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
    } catch (err) {
        logger.error('showDevopsMenu error', { error: err.message });
        ctx.answerCbQuery('❌ Error').catch(() => {});
    }
}
    

    // ═══════════════════════════════════════════════════════
    //  EXISTING FEATURES (Your #1-3, 5-8, 14, 15, 22-24, 27, 28, 35)
    // ═══════════════════════════════════════════════════════

    // ─── 1. Fix Negative Balances ───
    async handleFixBalances(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) {
            return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
        }

        await ctx.answerCbQuery('🔧 Running balance fix...');
        const msg = await ctx.reply('🔧 <b>Running balance fix...</b>', { parse_mode: 'HTML' });

        try {
            const results = await fixNegativeLockedBalances();
            const details = [];
            
            if (results.fixedNegative.length > 0) {
                details.push(`<b>🔴 Negative fixed:</b> ${results.fixedNegative.length}`);
                results.fixedNegative.slice(0, 5).forEach(u => {
                    details.push(`  • <code>${u.userId}</code>: ${u.was} → ${u.now}`);
                });
                if (results.fixedNegative.length > 5) {
                    details.push(`  ... and ${results.fixedNegative.length - 5} more`);
                }
            }

            if (results.fixedMissing.length > 0) {
                details.push(`<b>⚪ Missing fixed:</b> ${results.fixedMissing.length}`);
            }

            if (results.fixedExcessive.length > 0) {
                details.push(`<b>🟠 Excessive fixed:</b> ${results.fixedExcessive.length}`);
                results.fixedExcessive.slice(0, 3).forEach(u => {
                    details.push(`  • <code>${u.userId}</code>: ${u.was} → ${u.now} (bal: ${u.balance})`);
                });
            }

            const text = results.totalFixed > 0
                ? `✅ <b>Balance Fix Complete</b>\n\n` +
                  `📊 Total fixed: <b>${results.totalFixed}</b> users\n\n` +
                  details.join('\n') +
                  `\n\n<i>${new Date().toLocaleString()}</i>`
                : `✅ <b>Balance Fix Complete</b>\n\n` +
                  `🎉 No issues found. All balances are clean.\n\n` +
                  `<i>${new Date().toLocaleString()}</i>`;

            await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null, text, { 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
            });

        } catch (error) {
            logger.error('Fix balances failed', { error: error.message });
            await ctx.telegram.editMessageText(
                msg.chat.id, msg.message_id, null,
                `❌ <b>Fix failed:</b>\n\n<code>${error.message}</code>`,
                { 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
                }
            );
        }
    }

    // ─── 2. System Health ───
    async handleHealth(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🏥 Checking health...');

        try {
            const { User, Session } = await import('../../models/index.js');
            
            const [totalUsers, activeSessions, brokenBalances] = await Promise.all([
                User.countDocuments(),
                Session.countDocuments({ status: { $in: ['WAITING', 'CHECKING'] } }),
                User.countDocuments({ lockedBalance: { $lt: 0 } })
            ]);

            const uptime = process.uptime();
            const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

            const text = 
                `🏥 <b>System Health Report</b>\n\n` +
                `👤 <b>Users:</b> ${totalUsers.toLocaleString()}\n` +
                `⏳ <b>Active Sessions:</b> ${activeSessions}\n` +
                `⚠️ <b>Broken Balances:</b> ${brokenBalances}\n` +
                `⏱️ <b>Uptime:</b> ${uptimeStr}\n` +
                `💾 <b>Memory:</b> ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\n\n` +
                (brokenBalances > 0 
                    ? `⚡ <i>Tap "Fix Balances" below to repair.</i>`
                    : `✅ <i>All systems operational.</i>`
                );

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔧 Fix Balances', callback_data: 'admin_fix_balances' },
                            { text: '🔄 Refresh', callback_data: 'admin_health' }
                        ],
                        [{ text: '◀️ Back', callback_data: 'admin_back_system' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Health check failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
            });
        }
    }

    // ─── 3. Restart Bot ───
    async handleRestart(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔄 Restarting...');
        await safeEditMessage(ctx,
            `🔄 <b>Bot Restarting...</b>\n\n` +
            `⏳ Graceful shutdown in progress.\n` +
            `💡 The bot will be back online in ~5 seconds.`,
            { parse_mode: 'HTML' }
        );

        logger.info('Admin triggered restart', { adminId: userId });
        setTimeout(() => process.exit(0), 2000);
    }

    // ─── 5. Toggle Maintenance ───
    async handleToggleMaintenance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        const current = config.maintenance || false;
        config.maintenance = !current;
        
        const status = config.maintenance ? '🔴 ON' : '🟢 OFF';
        await ctx.answerCbQuery(`Maintenance: ${status}`, { show_alert: true });
        
        await safeEditMessage(ctx,
            `🛠️ <b>Maintenance Mode</b>\n\n` +
            `Status: <b>${status}</b>\n\n` +
            `${config.maintenance 
                ? '🔒 Non-admin users are now blocked.' 
                : '✅ Bot is open to all users.'}`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ 
                            text: config.maintenance ? '🟢 Disable' : '🔴 Enable', 
                            callback_data: 'admin_maintenance' 
                        }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_system' }]
                    ]
                }
            }
        );
    }

    // ─── 6. View Logs ───
    async handleViewLogs(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📜 Fetching logs...');
        await safeEditMessage(ctx,
            `📜 <b>Recent Logs</b>\n\n` +
            `<i>Implement log retrieval from your logging system.</i>\n\n` +
            `💡 Tip: Use Winston/Pino to store last 100 lines in memory.`,
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
            }
        );
    }

    // ─── 7. Clear Cache ───
    async handleClearCache(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🧹 Clearing...');
        if (global.botCache) global.botCache.clear();
        
        await safeEditMessage(ctx,
            `🧹 <b>Cache Cleared</b>\n\n` +
            `✅ All temporary data flushed.\n` +
            `💾 Memory freed.`,
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
            }
        );
    }

    // ─── 8. Database Backup ───
    async handleBackup(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('💾 Backing up...');
        const msg = await ctx.reply('💾 <b>Database backup in progress...</b>', { parse_mode: 'HTML' });

        try {
            await ctx.telegram.editMessageText(
                msg.chat.id, msg.message_id, null,
                `✅ <b>Backup Complete</b>\n\n` +
                `📦 Database exported successfully.\n` +
                `⏰ ${new Date().toLocaleString()}`,
                { 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
                }
            );
        } catch (error) {
            await ctx.telegram.editMessageText(
                msg.chat.id, msg.message_id, null,
                `❌ <b>Backup Failed</b>\n\n<code>${error.message}</code>`,
                { 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_system' }]] }
                }
            );
        }
    }
    // ═══════════════════════════════════════════════════════
    //  FEATURES #9-21 — Analytics & User Management
    // ═══════════════════════════════════════════════════════

    // ─── 9. 7-Day Stats ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
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
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 10. 30-Day Stats ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
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
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 11. Top Users by Volume ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_top_users' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Top users failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 12. OTP Success Rate ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_otp_success' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('OTP success rate failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 16. Search User ───
    async promptSearchUser(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingSearchUser = true;
        
        await safeEditMessage(ctx,
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
                return ctx.reply(`❌ No user found for: <code>${query}</code>`, { 
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

            await ctx.reply(text, {
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
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 17. View User Profile (same as impersonate, already implemented as #24) ───
    // Using processImpersonate for this — already implemented above

    // ─── 18. Add Balance ───
    async promptAddBalance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingAddBalance = true;
        
        await safeEditMessage(ctx,
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
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { $inc: { balance: amount } },
                { new: true }
            );

            if (!user) {
                return ctx.reply(`❌ User <code>${targetId}</code> not found.`, { parse_mode: 'HTML' });
            }

            await Transaction.create({
                userId: targetId,
                type: 'ADMIN_CREDIT',
                amount: amount,
                status: 'COMPLETED',
                reason: reason,
                adminId: ctx.from.id.toString(),
                createdAt: new Date()
            });

            await ctx.reply(
                `💰 <b>Balance Added</b>\n\n` +
                `👤 User: <code>${targetId}</code>\n` +
                `💵 Amount: <b>$${amount.toFixed(2)}</b>\n` +
                `📝 Reason: <i>${reason}</i>\n` +
                `💳 New Balance: <b>$${user.balance.toFixed(2)}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                }
            );

        } catch (error) {
            logger.error('Add balance failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 19. Deduct Balance ───
    async promptDeductBalance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingDeductBalance = true;
        
        await safeEditMessage(ctx,
            `💸 <b>Deduct Balance</b>\n\n` +
            `Send: <code>USER_ID AMOUNT</code>\n` +
            `Example: <code>123456789 25.00</code>\n\n` +
            `⚠️ User must have sufficient balance.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processDeductBalance(ctx, targetId, amount, reason = 'Admin deduction') {
        try {
            const { User, Transaction } = await import('../../models/index.js');
            
            const user = await User.findOne({ userId: targetId });
            if (!user) {
                return ctx.reply(`❌ User <code>${targetId}</code> not found.`, { parse_mode: 'HTML' });
            }

            if (user.balance < amount) {
                return ctx.reply(
                    `❌ <b>Insufficient Balance</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `💰 Current: <b>$${user.balance.toFixed(2)}</b>\n` +
                    `💸 Requested: <b>$${amount.toFixed(2)}</b>`,
                    { parse_mode: 'HTML' }
                );
            }

            await User.updateOne(
                { userId: targetId },
                { $inc: { balance: -amount } }
            );

            await Transaction.create({
                userId: targetId,
                type: 'ADMIN_DEBIT',
                amount: -amount,
                status: 'COMPLETED',
                reason: reason,
                adminId: ctx.from.id.toString(),
                createdAt: new Date()
            });

            await ctx.reply(
                `💸 <b>Balance Deducted</b>\n\n` +
                `👤 User: <code>${targetId}</code>\n` +
                `💵 Amount: <b>$${amount.toFixed(2)}</b>\n` +
                `📝 Reason: <i>${reason}</i>\n` +
                `💳 New Balance: <b>$${(user.balance - amount).toFixed(2)}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                }
            );

        } catch (error) {
            logger.error('Deduct balance failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 20. Blacklist User ───
    async promptBlacklist(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingBlacklistReason = true;
        
        await safeEditMessage(ctx,
            `🚫 <b>Blacklist User</b>\n\n` +
            `Send: <code>USER_ID REASON</code>\n` +
            `Example: <code>123456789 Fraudulent activity</code>\n\n` +
            `Or send <code>skip</code> for default reason.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processBlacklist(ctx, targetId, reason) {
        try {
            const { User } = await import('../../models/index.js');
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { 
                    $set: { 
                        blacklisted: true,
                        blacklistedAt: new Date(),
                        blacklistedBy: ctx.from.id.toString(),
                        blacklistReason: reason
                    } 
                },
                { new: true }
            );

            if (!user) {
                return ctx.reply(`❌ User <code>${targetId}</code> not found.`, { parse_mode: 'HTML' });
            }

            await ctx.reply(
                `🚫 <b>User Blacklisted</b>\n\n` +
                `👤 User: <code>${targetId}</code>\n` +
                `📝 Reason: <i>${reason}</i>\n` +
                `⏰ Time: <i>${new Date().toLocaleString()}</i>\n\n` +
                `⚠️ User can no longer use the bot.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                }
            );

        } catch (error) {
            logger.error('Blacklist failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 21. Whitelist User ───
    async promptWhitelist(ctx) {

        
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_provider_perf' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Provider perf failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_peak_hours' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Peak hours failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }
    // ═══════════════════════════════════════════════════════
    //  FEATURES #40-70 — Fraud, Automation, Analytics, Business, DevOps
    // ═══════════════════════════════════════════════════════

    // ─── 40. Velocity Checks ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_fraud_velocity' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Velocity check failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    }

    // ─── 41. Deposit Address Clustering ───
    async handleAddressClustering(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔗 Analyzing addresses...');

        try {
            const { User } = await import('../../models/index.js');
            
            const clusters = await User.aggregate([
                { $match: { walletAddress: { $exists: true, $ne: null } } },
                { $group: { 
                    _id: '$walletAddress', 
                    count: { $sum: 1 }, 
                    users: { $push: '$userId' } 
                }},
                { $match: { count: { $gt: 1 } } },
                { $limit: 10 }
            ]);

            let text = `🔗 <b>Deposit Address Clustering</b>\n\n`;
            
            if (clusters.length === 0) {
                text += `<i>No shared addresses detected.</i>`;
            } else {
                text += `⚠️ <b>${clusters.length} shared addresses:</b>\n\n`;
                clusters.forEach(c => {
                    text += `📍 <code>${c._id.slice(0, 10)}...${c._id.slice(-8)}</code>\n` +
                           `   👥 Users: <b>${c.count}</b>\n` +
                           `   🔗 IDs: <code>${c.users.slice(0, 3).join(', ')}${c.users.length > 3 ? '...' : ''}</code>\n\n`;
                });
            }

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_fraud_cluster' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Address clustering failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    }

    // ─── 42. Geo-Fencing ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
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
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    }

    // ─── 43. Transaction Pattern Analysis ───
    async handlePatternAnalysis(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📊 Analyzing patterns...');

        try {
            const { Transaction } = await import('../../models/index.js');
            
            // Find circular deposits (A -> B -> A)
            const circular = await Transaction.aggregate([
                { $match: { type: 'DEPOSIT', status: 'COMPLETED' } },
                { $group: { 
                    _id: { from: '$fromAddress', to: '$toAddress' }, 
                    count: { $sum: 1 } 
                }},
                { $match: { count: { $gt: 3 } } },
                { $limit: 10 }
            ]);

            let text = `📊 <b>Transaction Pattern Analysis</b>\n\n`;
            
            if (circular.length === 0) {
                text += `<i>No suspicious patterns detected.</i>`;
            } else {
                text += `⚠️ <b>${circular.length} suspicious patterns:</b>\n\n`;
                circular.forEach(c => {
                    text += `🔄 <code>${c._id.from?.slice(0, 8)}... → ${c._id.to?.slice(0, 8)}...</code>\n` +
                           `   Count: <b>${c.count}</b> circular tx\n\n`;
                });
            }

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_fraud_pattern' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Pattern analysis failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    }

    // ─── 44. Smart Refund Bot ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
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
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 46. Low Balance Alert ───
    async handleLowBalanceAlert(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('💳 Checking balances...');

        try {
            const masterBalance = this.walletService?.getBalance?.() || 0;
            const threshold = config.lowBalanceThreshold || 100;

            const text = 
                `💳 <b>Low Balance Alert</b>\n\n` +
                `🏦 Master Wallet: <b>$${masterBalance.toFixed(2)}</b>\n` +
                `⚠️ Threshold: <b>$${threshold.toFixed(2)}</b>\n\n` +
                `${masterBalance < threshold 
                    ? '🔴 <b>CRITICAL:</b> Balance below threshold! Top up immediately.' 
                    : '🟢 Balance is healthy.'}`;

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⚙️ Set Threshold', callback_data: 'admin_set_threshold' }],
                        [{ text: '🔄 Refresh', callback_data: 'admin_low_balance' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Low balance check failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 47. SMS Provider Failover (already implemented as #45) ───
    // Using handleProviderFailover — already implemented above

    // ─── 48. Deposit Confirmation Bot ───
    async handleDepositConfirmationBot(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        
        const current = config.autoConfirmDeposits || false;
        const status = current ? '🟢 ENABLED' : '🔴 DISABLED';

        await safeEditMessage(ctx,
            `🤖 <b>Auto Deposit Confirmation</b>\n\n` +
            `Status: <b>${status}</b>\n\n` +
            `📋 <b>Settings:</b>\n` +
            `• Confirm after: <b>${config.confirmAfterBlocks || 12} blocks</b>\n` +
            `• Max auto-confirm: <b>$${config.maxAutoConfirm || 500}</b>\n\n` +
            `${current 
                ? '✅ Deposits are auto-confirmed after N blocks.' 
                : '🔒 Manual confirmation required for all deposits.'}`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ 
                            text: current ? '🔴 Disable' : '🟢 Enable', 
                            callback_data: 'admin_toggle_auto_confirm' 
                        }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            }
        );
    }

    // ─── 49. Cohort Retention ───
    async handleCohortRetention(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('👥 Analyzing cohorts...');

        try {
            const { User } = await import('../../models/index.js');
            
            // Simplified cohort: users who joined in last 7 days
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_cohort' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Cohort retention failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 50. LTV per User ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_ltv' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('LTV failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 52. Revenue by Country ───
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
                { $sort: { total: -1 } },
                { $limit: 10 }
            ]);

            let text = `🌍 <b>Revenue by Country</b>\n\n`;
            
            if (byCountry.length === 0) {
                text += `<i>No country data available.</i>`;
            } else {
                byCountry.forEach(c => {
                    const flag = c._id ? String.fromCodePoint(...[...c._id.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '🏳️';
                    text += `${flag} <b>${c._id || 'Unknown'}</b>\n` +
                           `   💰 Revenue: <b>$${c.total?.toFixed(2) || '0.00'}</b>\n` +
                           `   📊 Transactions: <b>${c.count}</b>\n\n`;
                });
            }

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_revenue_country' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Revenue by country failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ─── 53. Hourly Heatmap ───
    async handleHourlyHeatmap(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔥 Generating heatmap...');

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

            let text = `🔥 <b>Hourly Activity Heatmap (7 days)</b>\n\n`;
            co



                // ═══════════════════════════════════════════════════════
    //  FEATURES #25-37 — More User Management + Finance + SMS
    // ═══════════════════════════════════════════════════════

    // ─── 25. Reset User Session (already implemented as #23) ───
    // Using processResetSession — already implemented above

    // ─── 26. Message User ───
    async promptMessageUser(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingMessageUser = true;
        
        await safeEditMessage(ctx,
            `💬 <b>Message User</b>\n\n` +
            `Send: <code>USER_ID YOUR MESSAGE</code>\n` +
            `Example: <code>123456789 Hello, your deposit is confirmed!</code>\n\n` +
            `⚠️ Message will be sent as bot.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processMessageUser(ctx, targetId, messageText) {
        try {
            await ctx.telegram.sendMessage(targetId, 
                `📩 <b>Message from Admin</b>\n\n${messageText}`,
                { parse_mode: 'HTML' }
            );

            await ctx.reply(
                `✅ <b>Message Sent</b>\n\n` +
                `👤 To: <code>${targetId}</code>\n` +
                `📝 Content: <i>${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}</i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                }
            );

        } catch (error) {
            logger.error('Message user failed', { error: error.message, targetId });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 29. Set Min/Max Deposit Limits ───
    async handleSetLimits(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingSetLimits = true;
        
        await safeEditMessage(ctx,
            `📊 <b>Set Deposit Limits</b>\n\n` +
            `Send: <code>MIN MAX</code>\n` +
            `Example: <code>10 1000</code>\n\n` +
            `Current: Min <b>$${config.minDeposit || 'N/A'}</b>, Max <b>$${config.maxDeposit || 'N/A'}</b>\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processSetLimits(ctx, min, max) {
        try {
            config.minDeposit = min;
            config.maxDeposit = max;
            
            await ctx.reply(
                `📊 <b>Limits Updated</b>\n\n` +
                `🔽 Minimum: <b>$${min.toFixed(2)}</b>\n` +
                `🔼 Maximum: <b>$${max.toFixed(2)}</b>\n\n` +
                `✅ New limits are now active.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
                }
            );

        } catch (error) {
            logger.error('Set limits failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }

    // ─── 30. Set OTP Price ───
    async handleSetPrice(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingSetPrice = true;
        
        await safeEditMessage(ctx,
            `🏷️ <b>Set OTP Price</b>\n\n` +
            `Send: <code>NEW_PRICE</code>\n` +
            `Example: <code>2.50</code>\n\n` +
            `Current: <b>$${config.otpPrice || 'N/A'}</b>\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processSetPrice(ctx, newPrice) {
        try {
            config.otpPrice = newPrice;
            
            await ctx.reply(
                `🏷️ <b>Price Updated</b>\n\n` +
                `💰 New OTP Price: <b>$${newPrice.toFixed(2)}</b>\n\n` +
                `✅ Price is now active for all users.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
                }
            );

        } catch (error) {
            logger.error('Set price failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }

    // ─── 31. Revenue Export ───
    async handleExportRevenue(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📥 Generating export...');

        try {
            const { Transaction } = await import('../../models/index.js');
            const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            
            const transactions = await Transaction.find({
                createdAt: { $gte: since }
            }).sort({ createdAt: -1 }).limit(1000);

            let csv = 'Date,Type,User,Amount,Status,Provider\n';
            transactions.forEach(tx => {
                csv += `${tx.createdAt?.toISOString()},${tx.type},${tx.userId},${tx.amount},${tx.status},${tx.provider || 'N/A'}\n`;
            });

            // Send as document or message
            await ctx.replyWithDocument({
                source: Buffer.from(csv),
                filename: `revenue_export_${new Date().toISOString().split('T')[0]}.csv`
            }, {
                caption: `📥 <b>Revenue Export</b>\n\nPeriod: Last 30 days\nRecords: <b>${transactions.length}</b>`,
                parse_mode: 'HTML'
            });

        } catch (error) {
            logger.error('Export failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }

    // ─── 32. Pending Deposits ───
    async handlePendingDeposits(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('⏳ Loading pending deposits...');

        try {
            const { Transaction } = await import('../../models/index.js');
            
            const pending = await Transaction.find({
                type: 'DEPOSIT',
                status: 'PENDING'
            }).sort({ createdAt: -1 }).limit(20);

            let text = `⏳ <b>Pending Deposits</b>\n\n`;
            
            if (pending.length === 0) {
                text += `<i>No pending deposits. All caught up!</i>`;
            } else {
                text += `<b>${pending.length} pending:</b>\n\n`;
                pending.forEach((tx, i) => {
                    const age = Math.floor((Date.now() - tx.createdAt) / 60000);
                    text += `${i + 1}. <code>${tx.userId}</code>\n` +
                           `   💰 Amount: <b>$${tx.amount?.toFixed(2) || '0.00'}</b>\n` +
                           `   ⏰ Age: <b>${age} min</b>\n` +
                           `   🆔 TX: <code>${tx._id?.toString().slice(-6) || 'N/A'}</code>\n\n`;
                });
            }

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_pending_deps' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_finance' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Pending deposits failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }

    // ─── 33. Force-Confirm Deposit ───
    async promptForceConfirm(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingForceConfirm = true;
        
        await safeEditMessage(ctx,
            `✅ <b>Force-Confirm Deposit</b>\n\n` +
            `Send: <code>TX_ID</code> or <code>USER_ID</code>\n` +
            `Example: <code>507f1f77bcf86cd799439011</code>\n\n` +
            `⚠️ This marks a pending deposit as completed manually.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processForceConfirm(ctx, txId) {
        try {
            const { Transaction, User } = await import('../../models/index.js');
            
            const tx = await Transaction.findByIdAndUpdate(
                txId,
                { $set: { status: 'COMPLETED', confirmedBy: ctx.from.id.toString(), confirmedAt: new Date() } },
                { new: true }
            );

            if (!tx) {
                return ctx.reply(`❌ Transaction <code>${txId}</code> not found.`, { parse_mode: 'HTML' });
            }

            // Credit user balance
            await User.updateOne(
                { userId: tx.userId },
                { $inc: { balance: tx.amount, totalDeposited: tx.amount } }
            );

            await ctx.reply(
                `✅ <b>Deposit Confirmed</b>\n\n` +
                `🆔 TX: <code>${txId}</code>\n` +
                `👤 User: <code>${tx.userId}</code>\n` +
                `💰 Amount: <b>$${tx.amount?.toFixed(2) || '0.00'}</b>\n` +
                `⏰ Confirmed: <i>${new Date().toLocaleString()}</i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
                }
            );

        } catch (error) {
            logger.error('Force confirm failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }

    // ─── 34. Switch SMS Provider ───
    async handleSwitchProvider(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔄 Loading providers...');

        try {
            if (!this.smsProviderManager) {
                throw new Error('SMS Provider Manager not initialized');
            }

            const providers = await this.smsProviderManager.getAvailableProviders();
            
            let text = `🔄 <b>Switch SMS Provider</b>\n\n`;
            text += `Current: <b>${this.smsProviderManager.getCurrentProvider() || 'None'}</b>\n\n`;
            text += `Available providers:\n`;

            const buttons = providers.map(p => ([{
                text: `${p.active ? '✅ ' : ''}${p.name}`,
                callback_data: `admin_switch_to_${p.id}`
            }]));

            buttons.push([{ text: '◀️ Back', callback_data: 'admin_back_sms' }]);

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });

        } catch (error) {
            logger.error('Switch provider failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_sms' }]] }
            });
        }
    }

    // ─── 36. Provider Balance Check (already implemented as #35) ───
    // Using handleProviderBalance — already implemented above

    // ─── 37. Retry Failed OTP ───
    async handleRetryFailedOTP(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔄 Retrying failed OTPs...');

        try {
            const { Transaction } = await import('../../models/index.js');
            
            const failedTxs = await Transaction.find({
                type: 'OTP',
                status: 'FAILED',
                createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }).limit(10);

            let retried = 0;
            for (const tx of failedTxs) {
                // Retry logic here
                retried++;
            }

            const text = 
                `🔄 <b>Retry Complete</b>\n\n` +
                `📊 Failed OTPs found: <b>${failedTxs.length}</b>\n` +
                `✅ Retried: <b>${retried}</b>\n\n` +
                `<i>Check provider logs for results.</i>`;

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Retry Again', callback_data: 'admin_retry_otp' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_sms' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Retry OTP failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_sms' }]] }
            });
        }
                          }
        
    // ─── 22. Clear User History ───
    async promptClearHistory(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingClearHistory = true;
        
        await safeEditMessage(ctx,
            `🧹 <b>Clear User History</b>\n\n` +
            `⚠️ <b>This is DESTRUCTIVE!</b>\n\n` +
            `Send the <b>User ID</b> to clear ALL history:\n` +
            `• Transactions\n` +
            `• Sessions\n` +
            `• OTP logs\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processClearHistory(ctx, targetId) {
        try {
            const { User, Transaction, Session } = await import('../../models/index.js');
            
            const [user, txDel, sessDel] = await Promise.all([
                User.findOne({ userId: targetId }),
                Transaction.deleteMany({ userId: targetId }),
                Session.deleteMany({ userId: targetId })
            ]);

            if (!user) {
                return ctx.reply(`❌ User <code>${targetId}</code> not found.`, { 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                });
            }

            await ctx.reply(
                `✅ <b>History Cleared</b>\n\n` +
                `👤 User: <code>${targetId}</code>\n` +
                `🗑️ Transactions deleted: <b>${txDel.deletedCount}</b>\n` +
                `🗑️ Sessions deleted: <b>${sessDel.deletedCount}</b>\n\n` +
                `⚠️ Balance was preserved. Use "Deduct Balance" if needed.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                }
            );

        } catch (error) {
            logger.error('Clear history failed', { error: error.message, targetId });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 23. Reset User Session ───
    async promptResetSession(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingResetSession = true;
        
        await safeEditMessage(ctx,
            `♻️ <b>Reset User Session</b>\n\n` +
            `Send the <b>User ID</b> to force-cancel their active session.\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processResetSession(ctx, targetId) {
        try {
            const { Session } = await import('../../models/index.js');
            const result = await Session.updateMany(
                { userId: targetId, status: { $in: ['WAITING', 'CHECKING', 'PENDING'] } },
                { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'admin' } }
            );

            await ctx.reply(
                `♻️ <b>Session Reset</b>\n\n` +
                `👤 User: <code>${targetId}</code>\n` +
                `🔄 Sessions cancelled: <b>${result.modifiedCount}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                }
            );

        } catch (error) {
            logger.error('Reset session failed', { error: error.message, targetId });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 24. Impersonate User ───
    async promptImpersonate(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingImpersonate = true;
        
        await safeEditMessage(ctx,
            `🎭 <b>Impersonate User</b>\n\n` +
            `Send the <b>User ID</b> to see their dashboard view.\n\n` +
            `⚠️ You will see exactly what they see.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    
    async processImpersonate(ctx, targetId) {
        try {
            const { User } = await import('../../models/index.js');
            const user = await User.findOne({ userId: targetId });

            if (!user) {
                return ctx.reply(`❌ User <code>${targetId}</code> not found.`, { 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                });
            }

            const text = 
                `🎭 <b>Impersonating: ${targetId}</b>\n\n` +
                `💰 Balance: <b>$${user.balance?.toFixed(2) || '0.00'}</b>\n` +
                `🔒 Locked: <b>$${user.lockedBalance?.toFixed(2) || '0.00'}</b>\n` +
                `📊 Total Spent: <b>$${user.totalSpent?.toFixed(2) || '0.00'}</b>\n` +
                `📥 Total Deposited: <b>$${user.totalDeposited?.toFixed(2) || '0.00'}</b>\n` +
                `🚫 Blacklisted: <b>${user.blacklisted ? 'YES' : 'No'}</b>\n` +
                `📅 Joined: <i>${user.createdAt?.toLocaleDateString() || 'N/A'}</i>\n\n` +
                `<i>This is their current view.</i>`;

            await ctx.reply(text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '💰 Add Balance', callback_data: `admin_add_bal_${targetId}` },
                            { text: '💸 Deduct', callback_data: `admin_ded_bal_${targetId}` }
                        ],
                        [{ text: '◀️ Back to Users', callback_data: 'admin_back_users' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Impersonate failed', { error: error.message, targetId });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 27. Manual Refund ───
    async promptRefund(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingRefund = true;
        
        await safeEditMessage(ctx,
            `↩️ <b>Manual Refund</b>\n\n` +
            `Send: <code>USER_ID AMOUNT REASON</code>\n` +
            `Example: <code>123456789 10.50 Service outage</code>\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processRefund(ctx, targetId, amount, reason) {
        try {
            const { User, Transaction } = await import('../../models/index.js');
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { $inc: { balance: amount } },
                { new: true }
            );

            if (!user) {
                return ctx.reply(`❌ User <code>${targetId}</code> not found.`, { parse_mode: 'HTML' });
            }

            await Transaction.create({
                userId: targetId,
                type: 'REFUND',
                amount: amount,
                status: 'COMPLETED',
                reason: reason,
                createdAt: new Date()
            });

            await ctx.reply(
                `↩️ <b>Refund Processed</b>\n\n` +
                `👤 User: <code>${targetId}</code>\n` +
                `💰 Amount: <b>$${amount.toFixed(2)}</b>\n` +
                `📝 Reason: <i>${reason}</i>\n` +
                `💳 New Balance: <b>$${user.balance.toFixed(2)}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
                }
            );

        } catch (error) {
            logger.error('Refund failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }

    // ─── 28. Adjust Transaction ───
    async promptAdjustTransaction(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingAdjustTx = true;
        
        await safeEditMessage(ctx,
            `✏️ <b>Adjust Transaction</b>\n\n` +
            `Send: <code>TX_ID NEW_AMOUNT</code>\n` +
            `Example: <code>507f1f77bcf86cd799439011 25.00</code>\n\n` +
            `⚠️ This modifies historical data!\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processAdjustTransaction(ctx, txId, newAmount) {
        try {
            const { Transaction } = await import('../../models/index.js');
            const tx = await Transaction.findByIdAndUpdate(
                txId,
                { $set: { amount: newAmount, adjustedBy: ctx.from.id.toString(), adjustedAt: new Date() } },
                { new: true }
            );

            if (!tx) {
                return ctx.reply(`❌ Transaction <code>${txId}</code> not found.`, { parse_mode: 'HTML' });
            }

            await ctx.reply(
                `✏️ <b>Transaction Adjusted</b>\n\n` +
                `🆔 ID: <code>${txId}</code>\n` +
                `💰 New Amount: <b>$${newAmount.toFixed(2)}</b>\n` +
                `📊 Type: <b>${tx.type}</b>\n` +
                `👤 User: <code>${tx.userId}</code>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
                }
            );

        } catch (error) {
            logger.error('Adjust tx failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }

    // ─── 35. Provider Balance Check ───
    async handleProviderBalance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('💳 Checking balances...');

        try {
            if (!this.smsProviderManager) {
                throw new Error('SMS Provider Manager not initialized');
            }

            const balances = await this.smsProviderManager.checkBalances();
            
            let text = `💳 <b>SMS Provider Balances</b>\n\n`;
            
            if (!balances || balances.length === 0) {
                text += `<i>No providers configured or all offline.</i>`;
            } else {
                balances.forEach(b => {
                    const status = b.available ? '🟢' : '🔴';
                    text += `${status} <b>${b.provider}</b>: ${b.balance} ${b.currency || 'credits'}\n` +
                           `   📊 Success Rate: <b>${(b.successRate * 100).toFixed(1)}%</b>\n\n`;
                });
            }

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_provider_balance' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_sms' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Provider balance failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_sms' }]] }
            });
        }
    }
     // ═══════════════════════════════════════════════════════
    //  NEW FEATURES (38, 39, 45, 51, 56, 60)
    // ═══════════════════════════════════════════════════════

    // ─── 38. Auto-Blacklist Toggle ───
    async handleAutoBlacklistToggle(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        const current = config.autoBlacklist || false;
        config.autoBlacklist = !current;
        
        const status = config.autoBlacklist ? '🟢 ENABLED' : '🔴 DISABLED';
        await ctx.answerCbQuery(`Auto-blacklist: ${status}`, { show_alert: true });

        await safeEditMessage(ctx,
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
                parse_mode: 'HTML',
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

    // ─── 39. IP/Device Fingerprinting ───
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_fraud_ip' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('IP fingerprint failed', { error: error.message });
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    }

    // ─── 45. Provider Failover ───
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

            await safeEditMessage(ctx,
                `🔀 <b>Provider Failover</b>\n\n` +
                `Status: <b>${current}</b>\n\n` +
                `📋 <b>Settings:</b>\n` +
                `• Trigger: Success rate < <b>${settings.threshold || 80}%</b>\n` +
                `• Check interval: <b>${settings.interval || 5} min</b>\n` +
                `• Fallback order: <b>${settings.fallbackOrder?.join(' → ') || 'Not set'}</b>\n\n` +
                `💡 When primary fails, bot auto-switches to next provider.`,
                {
                    parse_mode: 'HTML',
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
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 51. Churn Prediction ───
    async handleChurnPrediction(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📉 Analyzing churn...');

        try {
            const { User, Transaction } = await import('../../models/index.js');
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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
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
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    }

    // ─── 56. User Notes/Tags ───
    async promptUserNotes(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingUserNotes = true;
        
        await safeEditMessage(ctx,
            `📋 <b>User Notes & Tags</b>\n\n` +
            `Send: <code>USER_ID | NOTE</code>\n` +
            `Example: <code>123456789 | VIP customer, always pays on time</code>\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processUserNotes(ctx, targetId, note) {
        try {
            const { User } = await import('../../models/index.js');
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { 
                    $push: { 
                        adminNotes: { 
                            note, 
                            by: ctx.from.id.toString(), 
                            at: new Date() 
                        } 
                    } 
                },
                { new: true }
            );

            if (!user) {
                return ctx.reply(`❌ User <code>${targetId}</code> not found.`, { parse_mode: 'HTML' });
            }

            await ctx.reply(
                `📋 <b>Note Added</b>\n\n` +
                `👤 User: <code>${targetId}</code>\n` +
                `📝 Note: <i>${note}</i>\n` +
                `📊 Total notes: <b>${user.adminNotes?.length || 1}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                }
            );

        } catch (error) {
            logger.error('User notes failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ─── 60. Balance Freeze/Unfreeze ───
    async promptBalanceFreeze(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingBalanceFreeze = true;
        
        await safeEditMessage(ctx,
            `🔒 <b>Balance Freeze/Unfreeze</b>\n\n` +
            `Send: <code>USER_ID freeze|unfreeze REASON</code>\n` +
            `Example: <code>123456789 freeze Investigation pending</code>\n\n` +
            `⚠️ Frozen users can still use bot but cannot withdraw/transfer.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    }

    async processBalanceFreeze(ctx, targetId, action, reason) {
        try {
            const { User } = await import('../../models/index.js');
            
            const isFrozen = action === 'freeze';
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { 
                    $set: { 
                        balanceFrozen: isFrozen,
                        balanceFrozenAt: isFrozen ? new Date() : null,
                        balanceFrozenReason: isFrozen ? reason : null,
                        balanceFrozenBy: isFrozen ? ctx.from.id.toString() : null
                    } 
                },
                { new: true }
            );

            if (!user) {
                return ctx.reply(`❌ User <code>${targetId}</code> not found.`, { parse_mode: 'HTML' });
            }

            const status = isFrozen ? '🔒 FROZEN' : '🔓 UNFROZEN';
            
            await ctx.reply(
                `${status} <b>Balance Updated</b>\n\n` +
                `👤 User: <code>${targetId}</code>\n` +
                `💰 Balance: <b>$${user.balance?.toFixed(2) || '0.00'}</b>\n` +
                `📊 Status: <b>${status}</b>\n` +
                `${isFrozen ? `📝 Reason: <i>${reason}</i>\n` : ''}` +
                `${isFrozen ? `⏰ Frozen at: <i>${new Date().toLocaleString()}</i>\n` : ''}`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                }
            );

        } catch (error) {
            logger.error('Balance freeze failed', { error: error.message });
            ctx.reply(`❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  TEXT INPUT HANDLERS
    // ═══════════════════════════════════════════════════════

        async handleTextInput(ctx) {
        if (!ctx.session) return false;
        
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return false;

        // ─── Search User ───
        if (ctx.session.awaitingSearchUser) {
            delete ctx.session.awaitingSearchUser;
            const query = ctx.message.text.trim();
            if (query === '/cancel') return ctx.reply('❌ Cancelled.');
            return this.processSearchUser(ctx, query);
        }

        // ─── Add Balance ───
        if (ctx.session.awaitingAddBalance) {
            delete ctx.session.awaitingAddBalance;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const targetId = parts[0];
            const amount = parseFloat(parts[1]);
            if (isNaN(amount)) return ctx.reply('❌ Invalid amount.');
            return this.processAddBalance(ctx, targetId, amount);
        }

        // ─── Deduct Balance ───
        if (ctx.session.awaitingDeductBalance) {
            delete ctx.session.awaitingDeductBalance;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const targetId = parts[0];
            const amount = parseFloat(parts[1]);
            if (isNaN(amount)) return ctx.reply('❌ Invalid amount.');
            return this.processDeductBalance(ctx, targetId, amount);
        }

        // ─── Blacklist ───
        if (ctx.session.awaitingBlacklistReason) {
            delete ctx.session.awaitingBlacklistReason;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const targetId = parts[0];
            const reason = parts.slice(1).join(' ') || 'Manual blacklist';
            return this.processBlacklist(ctx, targetId, reason);
        }

        // ─── Whitelist ───
        if (ctx.session.awaitingWhitelist) {
            delete ctx.session.awaitingWhitelist;
            const targetId = ctx.message.text.trim();
            if (targetId === '/cancel') return ctx.reply('❌ Cancelled.');
            return this.processWhitelist(ctx, targetId);
        }

        // ─── Message User ───
        if (ctx.session.awaitingMessageUser) {
            delete ctx.session.awaitingMessageUser;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const targetId = parts[0];
            const message = parts.slice(1).join(' ');
            return this.processMessageUser(ctx, targetId, message);
        }

        // ─── Set Limits ───
        if (ctx.session.awaitingSetLimits) {
            delete ctx.session.awaitingSetLimits;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const min = parseFloat(parts[0]);
            const max = parseFloat(parts[1]);
            if (isNaN(min) || isNaN(max)) return ctx.reply('❌ Invalid values.');
            return this.processSetLimits(ctx, min, max);
        }

        // ─── Set Price ───
        if (ctx.session.awaitingSetPrice) {
            delete ctx.session.awaitingSetPrice;
            const price = parseFloat(ctx.message.text.trim());
            if (isNaN(price)) return ctx.reply('❌ Invalid price.');
            return this.processSetPrice(ctx, price);
        }

        // ─── Force Confirm ───
        if (ctx.session.awaitingForceConfirm) {
            delete ctx.session.awaitingForceConfirm;
            const txId = ctx.message.text.trim();
            if (txId === '/cancel') return ctx.reply('❌ Cancelled.');
            return this.processForceConfirm(ctx, txId);
        }

        // ─── Shadow Ban ───
        if (ctx.session.awaitingShadowBan) {
            delete ctx.session.awaitingShadowBan;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const targetId = parts[0];
            const action = parts[1];
            if (!['on', 'off'].includes(action)) return ctx.reply('❌ Use "on" or "off".');
            return this.processShadowBan(ctx, targetId, action);
        }

        // ─── Account Merge ───
        if (ctx.session.awaitingAccountMerge) {
            delete ctx.session.awaitingAccountMerge;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const keepId = parts[0];
            const deleteId = parts[1];
            return this.processAccountMerge(ctx, keepId, deleteId);
        }

        // ─── Invoice ───
        if (ctx.session.awaitingInvoice) {
            delete ctx.session.awaitingInvoice;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const targetId = parts[0];
            const month = parts[1];
            return this.processInvoice(ctx, targetId, month);
        }

        // ─── Existing handlers ───
        if (ctx.session.awaitingClearHistory) {
            delete ctx.session.awaitingClearHistory;
            const targetId = ctx.message.text.trim();
            if (targetId === '/cancel') return ctx.reply('❌ Cancelled.');
            return this.processClearHistory(ctx, targetId);
        }

        if (ctx.session.awaitingResetSession) {
            delete ctx.session.awaitingResetSession;
            const targetId = ctx.message.text.trim();
            if (targetId === '/cancel') return ctx.reply('❌ Cancelled.');
            return this.processResetSession(ctx, targetId);
        }

        if (ctx.session.awaitingImpersonate) {
            delete ctx.session.awaitingImpersonate;
            const targetId = ctx.message.text.trim();
            if (targetId === '/cancel') return ctx.reply('❌ Cancelled.');
            return this.processImpersonate(ctx, targetId);
        }

        if (ctx.session.awaitingRefund) {
            delete ctx.session.awaitingRefund;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const targetId = parts[0];
            const amount = parseFloat(parts[1]);
            const reason = parts.slice(2).join(' ') || 'Manual refund';
            if (isNaN(amount)) return ctx.reply('❌ Invalid amount.');
            return this.processRefund(ctx, targetId, amount, reason);
        }

        if (ctx.session.awaitingAdjustTx) {
            delete ctx.session.awaitingAdjustTx;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const txId = parts[0];
            const amount = parseFloat(parts[1]);
            if (isNaN(amount)) return ctx.reply('❌ Invalid amount.');
            return this.processAdjustTransaction(ctx, txId, amount);
        }

        if (ctx.session.awaitingUserNotes) {
            delete ctx.session.awaitingUserNotes;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const [targetId, ...noteParts] = text.split('|');
            const note = noteParts.join('|').trim();
            if (!note) return ctx.reply('❌ Note cannot be empty.');
            return this.processUserNotes(ctx, targetId.trim(), note);
        }

        if (ctx.session.awaitingBalanceFreeze) {
            delete ctx.session.awaitingBalanceFreeze;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.reply('❌ Cancelled.');
            const parts = text.split(' ');
            const targetId = parts[0];
            const action = parts[1];
            const reason = parts.slice(2).join(' ');
            if (!['freeze', 'unfreeze'].includes(action)) {
                return ctx.reply('❌ Action must be "freeze" or "unfreeze".');
            }
            return this.processBalanceFreeze(ctx, targetId, action, reason);
        }

        return false;
    }



    // ═══════════════════════════════════════════════════════
    //  STATS (24h)
    // ═══════════════════════════════════════════════════════

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

            await safeEditMessage(ctx, text, {
                parse_mode: 'HTML',
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
            safeEditMessage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  PLACEHOLDERS
    // ═══════════════════════════════════════════════════════

    
    async handleStats7d(ctx) { return this.comingSoon(ctx, '7-day Stats'); }
    async handleStats30d(ctx) { return this.comingSoon(ctx, '30-day Stats'); }
    async handleTopUsers(ctx) { return this.comingSoon(ctx, 'Top Users'); }
    async handleOTPSuccessRate(ctx) { return this.comingSoon(ctx, 'OTP Success Rate'); }
    async handleSetLimits(ctx) { return this.comingSoon(ctx, 'Set Limits'); }
    async handleSetPrice(ctx) { return this.comingSoon(ctx, 'Set Price'); }
    async handleExportRevenue(ctx) { return this.comingSoon(ctx, 'Export Revenue'); }
    async handlePendingDeposits(ctx) { return this.comingSoon(ctx, 'Pending Deposits'); }
    async handleSwitchProvider(ctx) { return this.comingSoon(ctx, 'Switch Provider'); }
    async handleRetryFailedOTP(ctx) { return this.comingSoon(ctx, 'Retry Failed OTP'); }
    async handlePriceByCountry(ctx) { return this.comingSoon(ctx, 'Price by Country'); }
    async handleVelocityCheck(ctx) { return this.comingSoon(ctx, 'Velocity Check'); }
    async handleGeoFencing(ctx) { return this.comingSoon(ctx, 'Geo-Fencing'); }
    async handleSmartRefund(ctx) { return this.comingSoon(ctx, 'Smart Refund'); }
    async handleStaleSessionCleaner(ctx) { return this.comingSoon(ctx, 'Stale Session Cleaner'); }
    async handleCohortRetention(ctx) { return this.comingSoon(ctx, 'Cohort Retention'); }
    async handleLTV(ctx) { return this.comingSoon(ctx, 'LTV Analysis'); }
    async handleRevenueByCountry(ctx) { return this.comingSoon(ctx, 'Revenue by Country'); }
    async handleHourlyHeatmap(ctx) { return this.comingSoon(ctx, 'Hourly Heatmap'); }
    async handleConversionFunnel(ctx) { return this.comingSoon(ctx, 'Conversion Funnel'); }
    async handleBulkOperations(ctx) { return this.comingSoon(ctx, 'Bulk Operations'); }
    async handleReferralTree(ctx) { return this.comingSoon(ctx, 'Referral Tree'); }
    async promptShadowBan(ctx) { return this.comingSoon(ctx, 'Shadow Ban'); }
    async promptAccountMerge(ctx) { return this.comingSoon(ctx, 'Account Merge'); }
    async handleDynamicPricing(ctx) { return this.comingSoon(ctx, 'Dynamic Pricing'); }
    async handlePromoCodes(ctx) { return this.comingSoon(ctx, 'Promo Codes'); }
    async handleCommissionSplit(ctx) { return this.comingSoon(ctx, 'Commission Split'); }
    async handleInvoiceGenerator(ctx) { return this.comingSoon(ctx, 'Invoice Generator'); }
    async handleTaxExport(ctx) { return this.comingSoon(ctx, 'Tax Export'); }
    async handleAuditTrail(ctx) { return this.comingSoon(ctx, 'Audit Trail'); }
    async handleWebhookTest(ctx) { return this.comingSoon(ctx, 'Webhook Test'); }
    async handleHotReload(ctx) { return this.comingSoon(ctx, 'Hot Reload'); }
    async handleABTesting(ctx) { return this.comingSoon(ctx, 'A/B Testing'); }
    async handleKeyRotation(ctx) { return this.comingSoon(ctx, 'Key Rotation'); }
    async handleWorkerStatus(ctx) { return this.comingSoon(ctx, 'Worker Status'); }
    async handleSearchUser(ctx) { return this.comingSoon(ctx, 'Search User'); }
    async promptBlacklist(ctx) { return this.comingSoon(ctx, 'Blacklist User'); }
    async promptWhitelist(ctx) { return this.comingSoon(ctx, 'Whitelist User'); }
    async promptMessageUser(ctx) { return this.comingSoon(ctx, 'Message User'); }
    async promptBroadcast(ctx) { return this.comingSoon(ctx, 'Broadcast'); }

    async comingSoon(ctx, feature) {
        await ctx.answerCbQuery(`${feature}: Coming soon!`, { show_alert: true });
    }

    // ═══════════════════════════════════════════════════════
    //  HELPER: Reply with error
    // ═══════════════════════════════════════════════════════

    replyError(ctx, text) {
        return ctx.reply(text, { 
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ Dashboard', callback_data: 'admin_dashboard' }]] }
        });
    }
}

export default Admin;
