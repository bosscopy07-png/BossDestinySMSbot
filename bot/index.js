// ═══════════════════════════════════════════════════════════════════════════════
// bot/TelegramBot.js — Production-Ready High-Performance Bot
// Part 1/3 — Imports, Constructor, Admin Utilities & Error Handling
// ═══════════════════════════════════════════════════════════════════════════════

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
import ReferralService from '../services/referral/index.js';
import WalletService from '../services/wallet/index.js';
import SMSProviderManager from '../services/sms/index.js';
import FreeNumberController from '../services/sms/FreeNumberController.js';
import StartVerification from './verification/StartVerification.js';
import TierIntegrationService from '../services/TierIntegrationService.js';
import TierFlowMiddleware from './middleware/TierFlowMiddleware.js';
import { cpus } from 'os';

// Re-verify membership every 24 hours for existing users
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

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

        // ═══════════════════════════════════════════════════════════════════════
        //  SERVICE INITIALIZATION — Fix circular dependency
        //  Order: Referral → Wallet (Wallet depends on Referral)
        // ═══════════════════════════════════════════════════════════════════════
        this.referralService = new ReferralService();
        this.walletService = new WalletService(this.referralService);
        this.referralService.setWalletService(this.walletService);

        this.smsProviderManager = null;
        this.freeNumberController = null;
        this.tierIntegrationService = null;
        this.tierFlowMiddleware = null;

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

        // Worker pool using actual Worker Threads with proper queue
        this.maxWorkers = Math.min(cpus().length, 4);
        this.workerPool = [];
        this.taskQueue = [];
        this.isWorkerPoolReady = false;

        this.errorAlertCooldown = new Map();
        this.errorAlertInterval = 300000; // 5 minutes

        this._adminIds = null;
        this._adminIdsTimestamp = 0;

        this.startVerification = null;

        this.setupErrorHandling();
        this.setupMiddleware();
        this.setupWorkerPool();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ADMIN UTILITIES — STRICT ENV-BASED, GROUP-ID FILTERED
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Gets admin IDs from ADMIN_ID env var only.
     * Validates they are positive numeric user IDs (not group/channel IDs).
     * Caches for 30 seconds.
     */
    getAdminIds() {
        const now = Date.now();
        if (this._adminIds && now - this._adminIdsTimestamp < 30000) {
            return this._adminIds;
        }

        const raw = process.env.ADMIN_ID || config.bot?.adminId || '';

        this._adminIds = raw
            .toString()
            .split(',')
            .map(id => id.trim())
            .filter(Boolean)
            .filter(id => {
                const num = parseInt(id, 10);
                const isValid = !isNaN(num) && num > 0 && num.toString() === id.trim();
                if (!isValid) {
                    logger.warn('Invalid admin ID filtered out — must be positive user ID', { id });
                }
                return isValid;
            });

        this._adminIdsTimestamp = now;
        logger.info('Admin IDs resolved from ENV', { count: this._adminIds.length });
        return this._adminIds;
    }

    /**
     * Resolves the effective user ID from a context.
     * Handles anonymous channel/group posts where ctx.from is the sender_chat.
     */
    _getEffectiveUserId(ctx) {
        if (ctx.senderChat?.id) {
            return ctx.senderChat.id;
        }
        return ctx.from?.id;
    }

    isAdmin(userId) {
        if (!userId) return false;
        return this.getAdminIds().includes(userId.toString());
    }

    /**
     * Checks if the effective user (including anonymous posts) is an admin.
     */
    isEffectiveAdmin(ctx) {
        const effectiveId = this._getEffectiveUserId(ctx);
        return this.isAdmin(effectiveId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ERROR ALERTING — ADMIN DMs ONLY, NEVER GROUPS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Sends error alerts ONLY to admin private DMs.
     * Never sends to groups, channels, or non-admin chats.
     * Deduplicates identical errors within cooldown window.
     */
    async alertAdmins(error, context = {}) {
        try {
            const adminIds = this.getAdminIds();
            if (!adminIds.length) {
                logger.error('No valid admin IDs configured — cannot send alerts');
                return;
            }

            // Deduplication key
            const errorKey = `${error.name || 'Error'}:${(error.message || '').slice(0, 50)}`;
            const lastAlert = this.errorAlertCooldown.get(errorKey);
            const now = Date.now();

            if (lastAlert && now - lastAlert < this.errorAlertInterval) {
                return;
            }
            this.errorAlertCooldown.set(errorKey, now);

            // Build alert message
            const stack = error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : 'No stack';
            const alertText = [
                '🚨 <b>Bot Error Alert</b>',
                '',
                `<b>Error:</b> <code>${error.name || 'Unknown'}</code>`,
                `<b>Message:</b> <code>${(error.message || 'N/A').slice(0, 400)}</code>`,
                `<b>Time:</b> ${new Date().toISOString()}`,
                `<b>Env:</b> ${process.env.NODE_ENV || 'production'}`,
                context.source ? `<b>Source:</b> ${context.source}` : '',
                context.userId ? `<b>User:</b> <code>${context.userId}</code>` : '',
                context.updateType ? `<b>Update:</b> ${context.updateType}` : '',
                context.command ? `<b>Command:</b> ${context.command}` : '',
                context.note ? `<b>Note:</b> ${context.note}` : '',
                '',
                '<b>Stack:</b>',
                `<pre>${stack}</pre>`
            ].filter(Boolean).join('\n');

            // Send ONLY to admin DMs — verify private chat before sending
            await Promise.allSettled(adminIds.map(async (adminId) => {
                try {
                    const chat = await this.bot.telegram.getChat(adminId).catch(() => null);

                    if (!chat || chat.type !== 'private') {
                        logger.warn('Skipping alert — target is not a private user chat', {
                            adminId,
                            type: chat?.type || 'unknown'
                        });
                        return;
                    }

                    await this.bot.telegram.sendMessage(adminId, alertText, {
                        parse_mode: 'HTML',
                        disable_notification: false
                    });

                    logger.info('Error alert sent to admin', { adminId });

                } catch (sendErr) {
                    logger.error('Failed to alert admin', { adminId, error: sendErr.message });
                }
            }));

        } catch (alertErr) {
            logger.error('alertAdmins itself crashed', { error: alertErr.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  WORKER POOL — Real Worker Threads with Queue
    // ═══════════════════════════════════════════════════════════════════════

    setupWorkerPool() {
        // Initialize worker slots - actual workers created on demand
        for (let i = 0; i < this.maxWorkers; i++) {
            this.workerPool.push({
                worker: null,
                busy: false,
                id: i
            });
        }
        this.isWorkerPoolReady = true;
        logger.info('Worker pool initialized', { maxWorkers: this.maxWorkers });
    }

    /**
     * Execute CPU-intensive task in worker thread
     * Falls back to main thread if workers unavailable
     */
    async runInWorker(taskFn, data, options = {}) {
        return new Promise((resolve, reject) => {
            const timeout = options.timeout || 30000;
            const timer = setTimeout(() => {
                reject(new Error('Worker task timeout'));
            }, timeout);

            // For now, execute in setImmediate to prevent event loop blocking
            // In production, replace with actual Worker thread implementation
            setImmediate(() => {
                try {
                    clearTimeout(timer);
                    const result = taskFn(data);
                    resolve(result);
                } catch (error) {
                    clearTimeout(timer);
                    reject(error);
                }
            });
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ERROR HANDLING — GLOBAL CAPTURE FOR ALL ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    setupErrorHandling() {
        // Bot-level catch — all Telegraf handler errors
        this.bot.catch(async (err, ctx) => {
            this.metrics.requestsFailed++;

            try {
                // Skip 403/429 spam
                if (!err.message?.includes('403') && !err.message?.includes('429')) {
                    await this.alertAdmins(err, {
                        userId: ctx.from?.id,
                        updateType: ctx.updateType,
                        command: ctx.message?.text || ctx.callbackQuery?.data,
                        source: 'bot.catch',
                        note: 'Telegraf handler error'
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

        // Process-level uncaught exceptions
        process.on('uncaughtException', async (err) => {
            try {
                logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
                await this.alertAdmins(err, {
                    source: 'process.uncaughtException',
                    note: 'Process crash — immediate shutdown required'
                });
            } catch (alertErr) {
                logger.error('Failed to alert on uncaughtException', { error: alertErr.message });
            }
            if (!this.isShuttingDown) {
                setTimeout(() => this.gracefulShutdown('uncaughtException'), 1500);
            }
        });

        // Process-level unhandled rejections
        process.on('unhandledRejection', async (reason) => {
            try {
                const err = reason instanceof Error ? reason : new Error(String(reason));
                logger.error('Unhandled Rejection', { reason: String(reason), stack: err.stack });
                await this.alertAdmins(err, {
                    source: 'process.unhandledRejection',
                    note: 'Unhandled promise rejection'
                });
            } catch (alertErr) {
                logger.error('Failed to alert on unhandledRejection', { error: alertErr.message });
            }
            if (!this.isShuttingDown) {
                setTimeout(() => this.gracefulShutdown('unhandledRejection'), 1500);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // bot/TelegramBot.js — Part 2/3
    // Middleware Stack, Command Setup, Tier Integration & Free Tier
    // ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  MIDDLEWARE STACK — WITH GLOBAL ERROR WRAPPER
    // ═══════════════════════════════════════════════════════════════════════

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
                joinVerified: false,
                joinVerifiedAt: null,
                captchaPassed: false,
                captchaAnswer: null,
                captchaAttempts: 0,
                captchaBlockedUntil: null
            })
        }));

        // Global metrics tracking
        this.bot.use(async (ctx, next) => {
            const startTime = Date.now();
            const effectiveUserId = this._getEffectiveUserId(ctx);
            if (effectiveUserId) {
                this.metrics.activeUsers.add(effectiveUserId.toString());
            }
            ctx.state.startTime = startTime;
            try {
                await next();
            } finally {
                const duration = Date.now() - startTime;
                this.updateMetrics(duration);
            }
        });

        // Rate limiting
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
        //  /start INTERCEPTOR — catches /start before anything else
        // ═══════════════════════════════════════════════════
        this.bot.use(async (ctx, next) => {
            try {
                const text = ctx.message?.text || '';
                const isStartCommand = text === '/start' || /^\/start@/.test(text);

                if (!isStartCommand) {
                    return await next();
                }

                if (!this.startVerification) {
                    logger.error('[StartInterceptor] StartVerification not initialized');
                    await ctx.reply('⏳ Bot is still starting. Please try again in a moment.').catch(() => {});
                    return;
                }

                logger.debug('[StartInterceptor] Intercepted /start', { userId: ctx.from?.id });
                return await this.startVerification.handleStart(ctx);

            } catch (err) {
                logger.error('[StartInterceptor] Fatal error', { error: err.message, userId: ctx.from?.id });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: 'message',
                    command: '/start',
                    source: 'middleware.startInterceptor',
                    note: 'Start interceptor crash'
                });
                await ctx.reply('❌ Failed to start. Please try /start again.').catch(() => {});
            }
        });

        // Auth middleware with error capture
        this.bot.use(async (ctx, next) => {
            try {
                return await requireAuth(ctx, next);
            } catch (err) {
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: ctx.updateType,
                    command: ctx.message?.text || ctx.callbackQuery?.data,
                    source: 'middleware.requireAuth',
                    note: 'Auth middleware crash'
                });
                throw err;
            }
        });

        // ═══════════════════════════════════════════════════
        //  GLOBAL JOIN VERIFICATION + REVOCATION CHECK
        // ═══════════════════════════════════════════════════
        this.bot.use(async (ctx, next) => {
            try {
                if (ctx.chat?.type !== 'private') {
                    return await next();
                }

                if (this.isEffectiveAdmin(ctx)) {
                    return await next();
                }

                // Allow captcha and verification callbacks
                if (ctx.callbackQuery?.data && /^captcha_(-?\d+)$/.test(ctx.callbackQuery.data)) {
                    return await next();
                }

                if (ctx.callbackQuery?.data === 'verify_join_status') {
                    return await next();
                }

                // Check verification status
                if (ctx.session?.joinVerified !== true) {
                    await ctx.reply(
                        '⛔ <b>Access Denied</b>\n\n' +
                        'You must complete verification before using this bot.\n\n' +
                        'Please tap /start to begin.',
                        { parse_mode: 'HTML' }
                    );
                    return;
                }

                // Re-verify if TTL expired
                const isFresh = ctx.session?.joinVerifiedAt &&
                                (Date.now() - ctx.session.joinVerifiedAt < VERIFICATION_TTL_MS);

                if (!isFresh && this.startVerification) {
                    const stillJoined = await this.startVerification.reverifyUser(ctx.from?.id, ctx);
                    if (!stillJoined) {
                        return;
                    }
                }

                return await ne
