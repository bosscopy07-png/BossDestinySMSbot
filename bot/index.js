// ═══════════════════════════════════════════════════════════
//  bot/TelegramBot.js — High-Performance Production Bot
//  Button-Based Admin Dashboard Edition
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

// ─── Worker pool for CPU-intensive tasks ───
import { Worker } from 'worker_threads';
import { cpus } from 'os';

class TelegramBot {
    constructor() {
        if (!config.bot?.token) {
            throw new Error('BOT_TOKEN not configured. Set it in your environment variables.');
        }

        // ─── Initialize Telegraf with optimized config ───
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
        this.referralService = null; // Add if you have one
        
        // ─── Performance tracking ───
        this.metrics = {
            requestsHandled: 0,
            requestsFailed: 0,
            avgResponseTime: 0,
            activeUsers: new Set(),
            startTime: Date.now()
        };

        // ─── State tracking ───
        this.isShuttingDown = false;
        this.isReady = false;
        this.commandModules = new Map();
        this.workerPool = [];
        this.maxWorkers = Math.min(cpus().length, 4);

        // ─── Initialize in order ───
        this.setupErrorHandling();
        this.setupMiddleware();
        this.setupWorkerPool();
    }

    // ═══════════════════════════════════════════════════════
    //  WORKER POOL (for CPU-intensive tasks)
    // ═══════════════════════════════════════════════════════

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
    //  MIDDLEWARE SETUP — Optimized for speed
    // ═══════════════════════════════════════════════════════

    setupMiddleware() {
        // ─── 1. Session (in-memory with LRU-like behavior) ───
        this.bot.use(telegrafSession({
            defaultSession: () => ({
                awaitingBroadcast: null,
                awaitingAddBalance: null,
                awaitingDeductBalance: null,
                awaitingBlacklistReason: null,
                awaitingMessageUser: null,
                awaitingClearHistory: null,
                awaitingResetSession: null,
                awaitingImpersonate: null,
                awaitingRefund: null,
                awaitingAdjustTx: null,
                awaitingUserNotes: null,
                awaitingBalanceFreeze: null,
                broadcastMessage: null,
                broadcastTarget: null,
                broadcastFilter: null,
                lastCommand: null,
                commandTimestamp: null,
                adminState: { state: 'none', data: {}, timestamp: null },
                poolPurchase: null
            })
        }));

        // ─── 2. Fast-path for common operations ───
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

        // ─── 3. Rate limiting ───
        this.bot.use(rateLimit({
            window: 60,
            max: 50,
            keyPrefix: 'bot_ratelimit',
            onLimitExceeded: async (ctx) => {
                logger.warn('Rate limit exceeded', { userId: ctx.from?.id });
                ctx.reply('⏳ Too many requests. Please slow down.').catch(() => {});
            }
        }));

        // ─── 4. Auth middleware ───
        this.bot.use(requireAuth);

        // ─── 5. Maintenance guard ───
        this.bot.use(async (ctx, next) => {
            if (this.isShuttingDown) {
                return ctx.reply('🔴 Bot is restarting. Please try again in a moment.').catch(() => {});
            }

            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            const isAdmin = adminIds.includes(ctx.from?.id?.toString());

            if (config.maintenance && !isAdmin) {
                return ctx.reply(
                    '🔧 <b>Maintenance Mode</b>\n\n' +
                    'The bot is currently under maintenance. Please try again later.\n\n' +
                    '<i>We apologize for any inconvenience.</i>',
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }

            return next();
        });

        // ─── 6. Response time logging (development only) ───
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

    // ═══════════════════════════════════════════════════════
    //  COMMAND SETUP — Async with SMS Provider Init
    // ═══════════════════════════════════════════════════════

    async setupCommands() {
        // ─── Initialize SMS Provider Manager FIRST ───
        try {
            this.smsProviderManager = new SMSProviderManager();
            await this.smsProviderManager.initialize();
            logger.info('SMS Provider Manager initialized in bot');
        } catch (error) {
            logger.error('Failed to initialize SMS Provider Manager', { error: error.message });
            this.smsProviderManager = null;
        }

        // ─── Initialize command modules ───
        const userCommands = new UserCommands(this.bot, this.walletService);
        const otpCommands = new OTPCommands(this.bot, this.walletService, this.smsProviderManager);
        
        // FIXED: Pass all dependencies to AdminCommands
        const adminCommands = new AdminCommands(
            this.bot, 
            this.walletService, 
            this.referralService,
            this.smsProviderManager
        );

        this.commandModules.set('user', userCommands);
        this.commandCommands.set('otp', otpCommands);
        this.commandModules.set('admin', adminCommands);

        // ─── Global start handler ───
        this.bot.start(async (ctx) => {
            this.trackEvent('command_start', ctx.from?.id);
            
            try {
                await userCommands.handleStart(ctx);
            } catch (error) {
                logger.error('Start handler error', { error: error.message, userId: ctx.from?.id });
                ctx.reply('❌ Failed to start. Please try /start again.').catch(() => {});
            }
        });

        // ─── Admin Dashboard Entry Point ───
        // Admin opens dashboard via /admin or button from existing menu
        this.bot.command('admin', async (ctx) => {
            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);
            
            if (!adminIds.includes(ctx.from?.id?.toString())) {
                return ctx.reply('⛔ <b>Admin only.</b>', { parse_mode: 'HTML' });
            }
            
            await adminCommands.showDashboard(ctx, false);
        });

        // ─── Help action ───
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
            }
        });

        // ─── Menu action ───
        this.bot.action('menu', async (ctx) => {
            try {
                ctx.answerCbQuery().catch(() => {});
                await userCommands.handleMenu(ctx);
            } catch (error) {
                logger.error('Menu action error', { error: error.message });
            }
        });

        // ─── Admin Dashboard Button (add to your existing menu) ───
        this.bot.action('open_admin_dashboard', async (ctx) => {
            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);
            
            if (!adminIds.includes(ctx.from?.id?.toString())) {
                return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
            }
            
            await adminCommands.showDashboard(ctx, true);
        });

        // ─── Text message handler for session-based inputs ───
        this.bot.on(message('text'), async (ctx, next) => {
            if (!ctx.session) return next();

            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            const isAdmin = adminIds.includes(ctx.from?.id?.toString());

            // ─── Admin text inputs (NEW: handles all admin prompts) ───
            if (isAdmin) {
                const handled = await adminCommands.handleTextInput(ctx);
                if (handled) return;
            }

            // ─── Legacy admin awaiting inputs (keep for backward compat) ───
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
        });
    }

    // ═══════════════════════════════════════════════════════
    //  ERROR HANDLING — Graceful degradation
    // ═══════════════════════════════════════════════════════

    setupErrorHandling() {
        this.bot.catch((err, ctx) => {
            this.metrics.requestsFailed++;

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
        });

        process.on('uncaughtException', (err) => {
            logger.error('Uncaught Exception', { error: err.message });
            if (!this.isShuttingDown) this.gracefulShutdown('uncaughtException');
        });

        process.on('unhandledRejection', (reason) => {
            logger.error('Unhandled Rejection', { reason: String(reason) });
            if (!this.isShuttingDown) this.gracefulShutdown('unhandledRejection');
        });
    }

    // ═══════════════════════════════════════════════════════
    //  DEPOSIT SCANNER — Robust with backoff
    // ═══════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════
    //  LAUNCH — With health checks
    // ═══════════════════════════════════════════════════════

    async launch() {
        try {
            logger.info('Initializing database...');
            await initModels();

            // FIXED: Initialize commands AFTER SMSProviderManager is ready
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
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════
    //  GRACEFUL SHUTDOWN — Fast & clean
    // ═══════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════
    //  METRICS & HEALTH
    // ═══════════════════════════════════════════════════════

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
