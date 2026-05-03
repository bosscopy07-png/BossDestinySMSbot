// ═══════════════════════════════════════════════════════════
//  bot/TelegramBot.js — High-Performance Production Bot
//  Integrates existing admin + new advanced admin dashboard
//  + Mandatory Channel/Group Join + Admin Error Alerts
// ═══════════════════════════════════════════════════════════

import { Telegraf, session as telegrafSession } from 'telegraf';
import { message } from 'telegraf/filters';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { initModels } from '../models/index.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import UserCommands from './commands/user.js';
import OTPCommands from './commands/otp.js';
import AdminCommands from './commands/admin.js';
import Admin from './commands/extra.js';
import WalletService from '../services/wallet/index.js';
import SMSProviderManager from '../services/sms/index.js';
import StartVerification from './verification/StartVerification.js';
import { Worker } from 'worker_threads';
import { cpus } from 'os';

class TelegramBot {
    constructor() {
        if (!config.bot?.token) {
            throw new Error('BOT_TOKEN not configured. Set it in your environment variables.');
        }

        this.bot = new Telegraf(config.bot.token, {
            telegram: {
                agent: null,
                retryAfter: 1,
                handle429: true
            },
            handlerTimeout: 90000
        });

        this.walletService = new WalletService();
        this.smsProviderManager = null;
        this.referralService = null;

        this.metrics = {
            requestsHandled: 0,
            requestsFailed: 0,
            avgResponseTime: 0,
            activeUsers: new Set(),
            startTime: Date.now()
        };

        this.isShuttingDown = false;
        this.isReady = false;
        this.commandModules = new Map();
        this.workerPool = [];
        this.maxWorkers = Math.min(cpus().length, 4);

        this.errorAlertCooldown = new Map();
        this.errorAlertInterval = 300000;

        this._adminIds = null;
        this._adminIdsTimestamp = 0;

        this.startVerification = null;

        this.setupErrorHandling();
        this.setupMiddleware();
        this.setupWorkerPool();
    }

    getAdminIds() {
        const now = Date.now();
        if (this._adminIds && now - this._adminIdsTimestamp < 30000) {
            return this._adminIds;
        }
        this._adminIds = (config.bot?.adminId || '')
            .toString()
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);
        this._adminIdsTimestamp = now;
        return this._adminIds;
    }

    isAdmin(userId) {
        if (!userId) return false;
        return this.getAdminIds().includes(userId.toString());
    }

    // ═══════════════════════════════════════════════════════
    //  ADMIN ERROR ALERTS — Catches EVERY single error
    //  Wrapped in try-catch so alerting never crashes the bot
    // ═══════════════════════════════════════════════════════

    async alertAdmins(error, context = {}) {
        try {
            const adminIds = this.getAdminIds();
            if (!adminIds.length) return;

            const errorKey = `${error.name || 'Error'}:${(error.message || '').slice(0, 50)}`;
            const lastAlert = this.errorAlertCooldown.get(errorKey);
            const now = Date.now();

            if (lastAlert && now - lastAlert < this.errorAlertInterval) {
                return;
            }
            this.errorAlertCooldown.set(errorKey, now);

            const stack = error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : 'No stack';
            const alertText = [
                '🚨 <b>Bot Error Alert</b>',
                '',
                `<b>Error:</b> <code>${error.name || 'Unknown'}</code>`,
                `<b>Message:</b> <code>${(error.message || 'N/A').slice(0, 400)}</code>`,
                `<b>Time:</b> ${new Date().toISOString()}`,
                `<b>Env:</b> ${process.env.NODE_ENV || 'production'}`,
                context.userId ? `<b>User:</b> <code>${context.userId}</code>` : '',
                context.updateType ? `<b>Update:</b> ${context.updateType}` : '',
                context.command ? `<b>Command:</b> ${context.command}` : '',
                context.note ? `<b>Note:</b> ${context.note}` : '',
                '',
                '<b>Stack:</b>',
                `<pre>${stack}</pre>`
            ].filter(Boolean).join('\n');

            await Promise.allSettled(adminIds.map(async (adminId) => {
                try {
                    await this.bot.telegram.sendMessage(adminId, alertText, {
                        parse_mode: 'HTML',
                        disable_notification: false
                    });
                } catch (sendErr) {
                    logger.error('Failed to alert admin', { adminId, error: sendErr.message });
                }
            }));
        } catch (alertErr) {
            logger.error('alertAdmins itself crashed', { error: alertErr.message });
        }
    }

    setupWorkerPool() {
        for (let i = 0; i < this.maxWorkers; i++) {
            this.workerPool.push(null);
        }
    }

    async runInWorker(task, data) {
        return new Promise((resolve, reject) => {
            setImmediate(() => {
                try {
                    const result = task(data);
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
        });
    }
        // ═══════════════════════════════════════════════════════
    //  MIDDLEWARE SETUP — ORDER IS CRITICAL
    //  1. Session
    //  2. Metrics
    //  3. Rate limit
    //  4. /start INTERCEPTOR — catches /start BEFORE requireAuth
    //     and BEFORE any command handlers (including UserCommands)
    //  5. requireAuth
    //  6. Global join verification (blocks non-start commands)
    //  7. Maintenance mode
    //  8. Dev logging
    // ═══════════════════════════════════════════════════════

    setupMiddleware() {
        this.bot.use(telegrafSession({
            defaultSession: () => ({
                awaitingBroadcast: null,
                awaitingAddBalance: null,
                awaitingDeductBalance: null,
                awaitingBlacklistReason: null,
                awaitingMessageUser: null,
                broadcastMessage: null,
                broadcastTarget: null,
                broadcastFilter: null,
                lastCommand: null,
                commandTimestamp: null,
                adminState: { state: 'none', data: {}, timestamp: null },
                poolPurchase: null,
                awaitingClearHistory: null,
                awaitingResetSession: null,
                awaitingImpersonate: null,
                awaitingRefund: null,
                awaitingAdjustTx: null,
                awaitingUserNotes: null,
                awaitingBalanceFreeze: null,
                joinVerified: false
            })
        }));

        this.bot.use(async (ctx, next) => {
            const startTime = Date.now();
            if (ctx.from?.id) {
                this.metrics.activeUsers.add(ctx.from.id.toString());
            }
            ctx.state.startTime = startTime;
            try {
                await next();
            } finally {
                const duration = Date.now() - startTime;
                this.updateMetrics(duration);
            }
        });

        this.bot.use(rateLimit({
            window: 60,
            max: 50,
            keyPrefix: 'bot_ratelimit',
            onLimitExceeded: async (ctx) => {
                logger.warn('Rate limit exceeded', { userId: ctx.from?.id });
                ctx.reply('⏳ Too many requests. Please slow down.').catch(() => {});
            }
        }));

        // ═══════════════════════════════════════════════════
        //  CRITICAL: /start INTERCEPTOR
        //  This middleware runs BEFORE requireAuth and BEFORE
        //  any command handlers. It catches /start and routes
        //  it to StartVerification. It does NOT call next(),
        //  so the update never reaches UserCommands' handlers.
        // ═══════════════════════════════════════════════════

        this.bot.use(async (ctx, next) => {
            try {
                const text = ctx.message?.text || '';
                const isStartCommand = text === '/start' || /^\/start@/.test(text);

                if (!isStartCommand) {
                    return next();
                }

                // /start detected — route to verification module
                if (!this.startVerification) {
                    logger.error('[StartInterceptor] StartVerification not initialized');
                    return ctx.reply('⏳ Bot is still starting. Please try again in a moment.').catch(() => {});
                }

                logger.debug('[StartInterceptor] Intercepted /start', { userId: ctx.from?.id });
                return await this.startVerification.handleStart(ctx);

            } catch (err) {
                logger.error('[StartInterceptor] Fatal error', { error: err.message, userId: ctx.from?.id });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: 'message',
                    command: '/start',
                    note: 'Start interceptor crash — this should never happen'
                });
                return ctx.reply('❌ Failed to start. Please try /start again.').catch(() => {});
            }
        });

        this.bot.use(requireAuth);

        // ═══════════════════════════════════════════════════
        //  GLOBAL JOIN VERIFICATION MIDDLEWARE
        //  Blocks ALL commands/actions for unverified users.
        //  Allows: admins, verify_join_status callback, and
        //  anything that passed the start interceptor (which
        //  only lets /start through to verification).
        // ═══════════════════════════════════════════════════

        this.bot.use(async (ctx, next) => {
            try {
                if (this.isAdmin(ctx.from?.id)) {
                    return next();
                }

                if (ctx.callbackQuery?.data === 'verify_join_status') {
                    return next();
                }

                if (ctx.session?.joinVerified === true) {
                    return next();
                }

                await ctx.reply(
                    '⛔ <b>Access Denied</b>\n\n' +
                    'You must join our community channels before using this bot.\n\n' +
                    'Please tap /start to complete verification.',
                    { parse_mode: 'HTML' }
                );
            } catch (err) {
                logger.error('Global verification middleware error', { error: err.message, userId: ctx.from?.id });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: ctx.updateType,
                    command: ctx.message?.text || ctx.callbackQuery?.data,
                    note: 'Global join verification middleware crash'
                });
            }
        });

        this.bot.use(async (ctx, next) => {
            try {
                if (this.isShuttingDown) {
                    return ctx.reply('🔴 Bot is restarting. Please try again in a moment.').catch(() => {});
                }

                const isAdmin = this.isAdmin(ctx.from?.id);

                if (config.maintenance && !isAdmin) {
                    return ctx.reply(
                        '🔧 <b>Maintenance Mode</b>\n\n' +
                        'The bot is currently under maintenance. Please try again later.\n\n' +
                        '<i>We apologize for any inconvenience.</i>',
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }

                return next();
            } catch (err) {
                logger.error('Maintenance middleware error', { error: err.message });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: ctx.updateType,
                    note: 'Maintenance middleware crash'
                });
            }
        });

        if (process.env.NODE_ENV === 'development') {
            this.bot.use(async (ctx, next) => {
                const start = Date.now();
                await next();
                logger.debug(`Handler took ${Date.now() - start}ms`, {
                    updateType: ctx.updateType,
                    userId: ctx.from?.id
                });
            });
        }
    }
        async setupCommands() {
        try {
            this.smsProviderManager = new SMSProviderManager();
            await this.smsProviderManager.initialize();
            logger.info('SMS Provider Manager initialized in bot');
        } catch (error) {
            logger.error('Failed to initialize SMS Provider Manager', { error: error.message });
            this.smsProviderManager = null;
            await this.alertAdmins(error, {
                updateType: 'setup',
                command: 'setupCommands',
                note: 'SMS Provider Manager init failed — bot continues without SMS'
            });
        }

        const userCommands = new UserCommands(this.bot, this.walletService);
        const otpCommands = new OTPCommands(this.bot, this.walletService, this.smsProviderManager);
        const adminCommands = new AdminCommands(this.bot, this.walletService, this.referralService, this.smsProviderManager);
        const advancedAdmin = new Admin(
            this.bot,
            this.walletService,
            this.referralService,
            this.smsProviderManager
        );

        this.commandModules.set('user', userCommands);
        this.commandModules.set('otp', otpCommands);
        this.commandModules.set('admin', adminCommands);
        this.commandModules.set('advancedAdmin', advancedAdmin);

        // ═══════════════════════════════════════════════════
        //  INITIALIZE START VERIFICATION MODULE
        //  This handles /start routing and verify_join_status.
        //  The interceptor middleware (setup earlier) delegates
        //  /start to this module. UserCommands NO LONGER
        //  registers bot.start() — it was removed.
        // ═══════════════════════════════════════════════════

        this.startVerification = new StartVerification(
            this.bot,
            userCommands,
            (userId) => this.isAdmin(userId),
            (err, ctx) => this.alertAdmins(err, ctx)
        );

        // DO NOT register bot.start() here — the interceptor handles it.
        // DO NOT register bot.action('verify_join_status') here —
        // StartVerification registers it internally.

        this.bot.action('help', async (ctx) => {
            try {
                ctx.answerCbQuery().catch(() => {});
                const helpMessage = [
                    "<b>❓ Help & Commands</b>",
                    "",
                    "📱 <code>/otp</code> — Request OTP",
                    "💰 <code>/balance</code> — Check balance",
                    "💳 <code>/deposit</code> — Add funds",
                    "📜 <code>/history</code> — Transaction history",
                    "🎁 <code>/referral</code> — Referral program",
                    "📊 <code>/stats</code> — Your statistics",
                    "⚙️ <code>/settings</code> — Bot settings",
                    "❌ <code>/cancel</code> — Cancel active session",
                    "",
                    "<b>Admin Only:</b>",
                    "🔐 <code>/admin</code> — Admin dashboard"
                ].join("\n");
                await ctx.reply(helpMessage, { parse_mode: 'HTML' });
            } catch (error) {
                logger.error('Help action error', { error: error.message });
                await this.alertAdmins(error, {
                    userId: ctx.from?.id,
                    updateType: 'callback_query',
                    command: 'help'
                });
            }
        });

        this.bot.action('menu', async (ctx) => {
            try {
                ctx.answerCbQuery().catch(() => {});
                await userCommands.handleMenu(ctx);
            } catch (error) {
                logger.error('Menu action error', { error: error.message });
                await this.alertAdmins(error, {
                    userId: ctx.from?.id,
                    updateType: 'callback_query',
                    command: 'menu'
                });
            }
        });

        this.bot.action('open_admin_dashboard', async (ctx) => {
            try {
                if (!this.isAdmin(ctx.from?.id)) {
                    return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
                }
                await advancedAdmin.showDashboard(ctx, true);
            } catch (err) {
                logger.error('Admin dashboard action error', { error: err.message });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: 'callback_query',
                    command: 'open_admin_dashboard'
                });
            }
        });

        this.bot.on(message('text'), async (ctx, next) => {
            try {
                if (!ctx.session) return next();

                const isAdmin = this.isAdmin(ctx.from?.id);

                if (isAdmin) {
                    const handled = await advancedAdmin.handleTextInput(ctx);
                    if (handled) return;
                }

                if (isAdmin) {
                    if (ctx.session.awaitingBroadcast) {
                        const { target, filter, label } = ctx.session.awaitingBroadcast;
                        delete ctx.session.awaitingBroadcast;
                        return adminCommands.executeBroadcast(ctx, filter, label, ctx.message.text);
                    }

                    if (ctx.session.awaitingAddBalance) {
                        const targetId = ctx.session.awaitingAddBalance;
                        delete ctx.session.awaitingAddBalance;
                        const amount = parseFloat(ctx.message.text);
                        if (isNaN(amount) || amount <= 0) {
                            return adminCommands.replyError(ctx, '❌ <b>Invalid amount.</b>');
                        }
                        return adminCommands.processAddBalance(ctx, targetId, amount, 'Admin credit via inline');
                    }

                    if (ctx.session.awaitingDeductBalance) {
                        const targetId = ctx.session.awaitingDeductBalance;
                        delete ctx.session.awaitingDeductBalance;
                        const amount = parseFloat(ctx.message.text);
                        if (isNaN(amount) || amount <= 0) {
                            return adminCommands.replyError(ctx, '❌ <b>Invalid amount.</b>');
                        }
                        return adminCommands.processDeductBalance(ctx, targetId, amount, 'Admin deduction via inline');
                    }

                    if (ctx.session.awaitingBlacklistReason) {
                        const targetId = ctx.session.awaitingBlacklistReason;
                        delete ctx.session.awaitingBlacklistReason;
                        const reason = ctx.message.text.trim().toLowerCase() === 'skip'
                            ? 'Manual blacklist'
                            : ctx.message.text.trim();
                        return adminCommands.processBlacklist(ctx, targetId, reason);
                    }

                    if (ctx.session.awaitingMessageUser) {
                        const targetId = ctx.session.awaitingMessageUser;
                        delete ctx.session.awaitingMessageUser;
                        return adminCommands.processMessageUser(ctx, targetId, ctx.message.text);
                    }
                }

                return next();
            } catch (err) {
                logger.error('Text message handler error', { error: err.message, userId: ctx.from?.id });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: 'message',
                    command: ctx.message?.text,
                    note: 'Text handler crash'
                });
            }
        });
    }

    setupErrorHandling() {
        this.bot.catch(async (err, ctx) => {
            this.metrics.requestsFailed++;

            try {
                if (!err.message?.includes('403') && !err.message?.includes('429')) {
                    await this.alertAdmins(err, {
                        userId: ctx.from?.id,
                        updateType: ctx.updateType,
                        command: ctx.message?.text || ctx.callbackQuery?.data,
                        note: 'bot.catch triggered'
                    });
                }

                if (err.message?.includes('ETELEGRAM') && err.message?.includes('403')) {
                    return;
                }
                if (err.message?.includes('ETELEGRAM') && err.message?.includes('429')) {
                    logger.warn('Telegram rate limit', { userId: ctx.from?.id });
                    return;
                }

                logger.error('Bot error', {
                    error: err.message,
                    userId: ctx.from?.id,
                    updateType: ctx.updateType
                });

                if (err.message?.includes('WALLET_NOT_READY')) {
                    ctx.reply('⏳ Blockchain connection warming up. Try again shortly.').catch(() => {});
                } else {
                    ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
                }
            } catch (catchErr) {
                logger.error('Error inside bot.catch', { error: catchErr.message });
            }
        });

        process.on('uncaughtException', async (err) => {
            try {
                logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
                await this.alertAdmins(err, {
                    updateType: 'process',
                    command: 'uncaughtException',
                    note: 'Process crash — immediate shutdown required'
                });
            } catch (alertErr) {
                logger.error('Failed to alert on uncaughtException', { error: alertErr.message });
            }
            if (!this.isShuttingDown) this.gracefulShutdown('uncaughtException');
        });

        process.on('unhandledRejection', async (reason) => {
            try {
                const err = reason instanceof Error ? reason : new Error(String(reason));
                logger.error('Unhandled Rejection', { reason: String(reason), stack: err.stack });
                await this.alertAdmins(err, {
                    updateType: 'process',
                    command: 'unhandledRejection',
                    note: 'Unhandled promise rejection'
                });
            } catch (alertErr) {
                logger.error('Failed to alert on unhandledRejection', { error: alertErr.message });
            }
            if (!this.isShuttingDown) this.gracefulShutdown('unhandledRejection');
        });
    }

    startDepositScanner() {
        let retryDelay = 5000;
        const maxRetryDelay = 60000;

        const checkAndStart = async () => {
            if (this.isShuttingDown) return;

            try {
                if (this.walletService?.isReady) {
                    this.walletService.startDepositScanner(30000);
                    logger.info('Deposit scanner started');
                    retryDelay = 5000;
                } else {
                    logger.warn('Wallet not ready, retrying...');
                    setTimeout(checkAndStart, retryDelay);
                    retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
                }
            } catch (error) {
                logger.error('Deposit scanner error', { error: error.message });
                this.alertAdmins(error, {
                    updateType: 'scanner',
                    command: 'deposit_scanner',
                    note: 'Deposit scanner retry loop error'
                });
                setTimeout(checkAndStart, retryDelay);
                retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
            }
        };

        setTimeout(checkAndStart, 3000);
    }

    stopDepositScanner() {
        try {
            this.walletService?.stopDepositScanner?.();
        } catch (error) {
            logger.error('Error stopping scanner', { error: error.message });
        }
    }

    async launch() {
        try {
            logger.info('Initializing database...');
            await initModels();

            await this.setupCommands();

            this.startDepositScanner();

            await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
            await this.bot.launch();

            this.isReady = true;
            logger.info('Bot launched successfully');

            process.once('SIGINT', () => this.gracefulShutdown('SIGINT'));
            process.once('SIGTERM', () => this.gracefulShutdown('SIGTERM'));

            setInterval(() => this.logMetrics(), 300000);

        } catch (error) {
            logger.error('Launch failed', { error: error.message });
            await this.alertAdmins(error, {
                updateType: 'launch',
                command: 'bot_launch',
                note: 'Bot failed to launch — critical'
            });
            throw error;
        }
    }

    async gracefulShutdown(signal) {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        logger.info(`Shutting down (${signal})`);

        try {
            this.bot.stop(signal);
        } catch (e) {}

        this.stopDepositScanner();

        if (this.smsProviderManager) {
            try {
                await this.smsProviderManager.shutdown();
            } catch (e) {
                logger.warn('SMS Provider Manager shutdown failed', { error: e.message });
            }
        }

        try {
            await Promise.race([
                this.walletService?.disconnect?.(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
            ]);
        } catch (e) {}

        setTimeout(() => process.exit(1), 10000);
        process.exit(0);
    }

    updateMetrics(duration) {
        this.metrics.requestsHandled++;
        this.metrics.avgResponseTime =
            (this.metrics.avgResponseTime * (this.metrics.requestsHandled - 1) + duration)
            / this.metrics.requestsHandled;
    }

    trackEvent(event, userId) {
        setImmediate(() => {
            logger.debug('Event tracked', { event, userId });
        });
    }

    logMetrics() {
        const uptime = (Date.now() - this.metrics.startTime) / 1000;
        logger.info('Bot metrics', {
            uptime: `${Math.floor(uptime / 60)}m`,
            requestsHandled: this.metrics.requestsHandled,
            requestsFailed: this.metrics.requestsFailed,
            avgResponseTime: `${Math.round(this.metrics.avgResponseTime)}ms`,
            activeUsers: this.metrics.activeUsers.size
        });
    }

    getHealth() {
        return {
            status: this.isShuttingDown ? 'shutting_down' : this.isReady ? 'healthy' : 'starting',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            metrics: {
                requests: this.metrics.requestsHandled,
                failed: this.metrics.requestsFailed,
                avgResponseTime: Math.round(this.metrics.avgResponseTime),
                activeUsers: this.metrics.activeUsers.size
            },
            walletReady: this.walletService?.isReady || false,
            smsProviderReady: !!this.smsProviderManager?.isInitialized,
            timestamp: new Date().toISOString()
        };
    }
}

export default TelegramBot;
                    
