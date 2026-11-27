// ═══════════════════════════════════════════════════════════
//  bot/commands/extra.js — Advanced Admin Dashboard
// ═══════════════════════════════════════════════════════════

import logger from '../../utils/logger.js';
import config from '../../config/env.js';
import { ADMIN_IMAGE_URL, safeEditWithImage } from './extra/helpers.js';
import { systemMethods } from './extra/system.js';
import { analyticsMethods } from './extra/analytics.js';
import { financeMethods } from './extra/finance.js';
import { userToolsMethods } from './extra/userTools.js';

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
        this.bot.action('admin_workers', (ctx) => this.handleWorkerStatus(ctx));

        // ─── Analytics ───
        this.bot.action('admin_stats', (ctx) => this.handleStats(ctx, 1));
        this.bot.action('admin_stats_7d', (ctx) => this.handleStats(ctx, 7));
        this.bot.action('admin_stats_30d', (ctx) => this.handleStats(ctx, 30));
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

        // ─── Fraud & Security ───
        this.bot.action('admin_fraud_velocity', (ctx) => this.handleVelocityCheck(ctx));

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
        this.bot.action('admin_user_notes', (ctx) => this.promptUserNotes(ctx));
        this.bot.action('admin_referral_tree', (ctx) => this.handleReferralTree(ctx));
        this.bot.action('admin_shadow_ban', (ctx) => this.promptShadowBan(ctx));
        this.bot.action('admin_account_merge', (ctx) => this.promptAccountMerge(ctx));
        this.bot.action('admin_balance_freeze', (ctx) => this.promptBalanceFreeze(ctx));

        // ─── Business ───
        this.bot.action('admin_invoice', (ctx) => this.handleInvoiceGenerator(ctx));
        this.bot.action('admin_tax_export', (ctx) => this.handleTaxExport(ctx));
        this.bot.action('admin_audit', (ctx) => this.handleAuditTrail(ctx));

        // ─── DevOps ───

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
                        { text: '📜 View Logs', callback_data: 'admin_logs' }
                    ],
                    [
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
                        { text: '📢 Broadcast', callback_data: 'admin_broadcast' }
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
            await ctx.answerCbQuery('📱 SMS').catch(() => {});
            const text = `📱 <b>SMS/OTP Management</b>\n\nControl SMS operations:`;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔄 Switch Provider', callback_data: 'admin_switch_provider' },
                        { text: '💳 Provider Bal', callback_data: 'admin_provider_balance' }
                    ],
                    [
                        { text: '🔄 Retry Failed', callback_data: 'admin_retry_otp' }
                    ],
                    [{ text: '◀️ Back', callback_data: 'admin_back' }]
                ]
            };
            await safeEditWithImage(ctx, text, { reply_markup: keyboard });
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
                        { text: '⚡ Velocity Check', callback_data: 'admin_fraud_velocity' }
                    ],
                    [{ text: '◀️ Back', callback_data: 'admin_back' }]
                ]
            };
            await safeEditWithImage(ctx, text, { reply_markup: keyboard });
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
            await safeEditWithImage(ctx, text, { reply_markup: keyboard });
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
                                                            [{ text: '◀️ Back', callback_data: 'admin_back' }]
                ]
            };
            await safeEditWithImage(ctx, text, { reply_markup: keyboard });
        } catch (err) {
            logger.error('showDevopsMenu error', { error: err.message });
            ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    }

    
async handleTextInput(ctx) {
        if (!ctx.session) return false;
        
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return false;

        if (ctx.session.awaitingSearchUser) {
            delete ctx.session.awaitingSearchUser;
            const query = ctx.message.text.trim();
            if (query === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            return this.processSearchUser(ctx, query);
        }

        if (ctx.session.awaitingAddBalance) {
            delete ctx.session.awaitingAddBalance;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const targetId = parts[0];
            const amount = parseFloat(parts[1]);
            if (isNaN(amount)) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Invalid amount.' });
            return this.processAddBalance(ctx, targetId, amount);
        }

        if (ctx.session.awaitingDeductBalance) {
            delete ctx.session.awaitingDeductBalance;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const targetId = parts[0];
            const amount = parseFloat(parts[1]);
            if (isNaN(amount)) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Invalid amount.' });
            return this.processDeductBalance(ctx, targetId, amount);
        }

        if (ctx.session.awaitingBlacklistReason) {
            delete ctx.session.awaitingBlacklistReason;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const targetId = parts[0];
            const reason = parts.slice(1).join(' ') || 'Manual blacklist';
            return this.processBlacklist(ctx, targetId, reason);
        }

        if (ctx.session.awaitingWhitelist) {
            delete ctx.session.awaitingWhitelist;
            const targetId = ctx.message.text.trim();
            if (targetId === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            return this.processWhitelist(ctx, targetId);
        }

        if (ctx.session.awaitingMessageUser) {
            delete ctx.session.awaitingMessageUser;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const targetId = parts[0];
            const message = parts.slice(1).join(' ');
            return this.processMessageUser(ctx, targetId, message);
        }

        if (ctx.session.awaitingBroadcast) {
            delete ctx.session.awaitingBroadcast;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            return this.processBroadcast(ctx, text);
        }

        if (ctx.session.awaitingSetLimits) {
            delete ctx.session.awaitingSetLimits;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const min = parseFloat(parts[0]);
            const max = parseFloat(parts[1]);
            if (isNaN(min) || isNaN(max)) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Invalid values.' });
            return this.processSetLimits(ctx, min, max);
        }

        if (ctx.session.awaitingSetPrice) {
            delete ctx.session.awaitingSetPrice;
            const price = parseFloat(ctx.message.text.trim());
            if (isNaN(price)) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Invalid price.' });
            return this.processSetPrice(ctx, price);
        }

        if (ctx.session.awaitingForceConfirm) {
            delete ctx.session.awaitingForceConfirm;
            const txId = ctx.message.text.trim();
            if (txId === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            return this.processForceConfirm(ctx, txId);
        }

        if (ctx.session.awaitingShadowBan) {
            delete ctx.session.awaitingShadowBan;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const targetId = parts[0];
            const action = parts[1];
            if (!['on', 'off'].includes(action)) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Use "on" or "off".' });
            return this.processShadowBan(ctx, targetId, action);
        }

        if (ctx.session.awaitingAccountMerge) {
            delete ctx.session.awaitingAccountMerge;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const keepId = parts[0];
            const deleteId = parts[1];
            return this.processAccountMerge(ctx, keepId, deleteId);
        }

        if (ctx.session.awaitingInvoice) {
            delete ctx.session.awaitingInvoice;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const targetId = parts[0];
            const month = parts[1];
            return this.processInvoice(ctx, targetId, month);
        }

        if (ctx.session.awaitingRefund) {
            delete ctx.session.awaitingRefund;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const targetId = parts[0];
            const amount = parseFloat(parts[1]);
            const reason = parts.slice(2).join(' ') || 'Manual refund';
            if (isNaN(amount)) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Invalid amount.' });
            return this.processRefund(ctx, targetId, amount, reason);
        }

        if (ctx.session.awaitingAdjustTx) {
            delete ctx.session.awaitingAdjustTx;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const txId = parts[0];
            const amount = parseFloat(parts[1]);
            if (isNaN(amount)) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Invalid amount.' });
            return this.processAdjustTransaction(ctx, txId, amount);
        }

        if (ctx.session.awaitingUserNotes) {
            delete ctx.session.awaitingUserNotes;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const [targetId, ...noteParts] = text.split('|');
            const note = noteParts.join('|').trim();
            if (!note) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Note cannot be empty.' });
            return this.processUserNotes(ctx, targetId.trim(), note);
        }

        if (ctx.session.awaitingBalanceFreeze) {
            delete ctx.session.awaitingBalanceFreeze;
            const text = ctx.message.text.trim();
            if (text === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            const parts = text.split(' ');
            const targetId = parts[0];
            const action = parts[1];
            const reason = parts.slice(2).join(' ');
            if (!['freeze', 'unfreeze'].includes(action)) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Action must be "freeze" or "unfreeze".' });
            }
            return this.processBalanceFreeze(ctx, targetId, action, reason);
        }

        if (ctx.session.awaitingClearHistory) {
            delete ctx.session.awaitingClearHistory;
            const targetId = ctx.message.text.trim();
            if (targetId === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            return this.processClearHistory(ctx, targetId);
        }

        if (ctx.session.awaitingResetSession) {
            delete ctx.session.awaitingResetSession;
            const targetId = ctx.message.text.trim();
            if (targetId === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            return this.processResetSession(ctx, targetId);
        }

        if (ctx.session.awaitingImpersonate) {
            delete ctx.session.awaitingImpersonate;
            const targetId = ctx.message.text.trim();
            if (targetId === '/cancel') return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { caption: '❌ Cancelled.' });
            return this.processImpersonate(ctx, targetId);
        }

        return false;
    }

    replyError(ctx, text) {
        return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
            caption: text, 
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ Dashboard', callback_data: 'admin_dashboard' }]] }
        });
    }
}

// ─── Mix the split modules into the class (methods keep working unchanged via `this`) ───
Object.assign(Admin.prototype, systemMethods, analyticsMethods, financeMethods, userToolsMethods);

export default Admin;
