// ═══════════════════════════════════════════════════════════════════════════════
// bot/TelegramBot.js — High-Performance Production Bot
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
import TierFlowMiddleware from './middleware/tierFlowMiddleware.js';
import { Worker } from 'worker_threads';
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
        this.walletService = new WalletService(this.referralService);
        this.smsProviderManager = null;
        this.referralService = new ReferralService(this.walletService);
        this.freeNumberController = null;

        // ═════════════════════════════════════════════════════════════════
        //  NEW: Tier System Integration
        // ═════════════════════════════════════════════════════════════════
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

        // STRICT: Read from process.env.ADMIN_ID first, then fallback to config
        const raw = process.env.ADMIN_ID || config.bot?.adminId || '';

        this._adminIds = raw
            .toString()
            .split(',')
            .map(id => id.trim())
            .filter(Boolean)
            .filter(id => {
                const num = parseInt(id, 10);
                // Must be positive integer (user ID), reject group IDs (negative) and non-numeric
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
                    // Verify this is a private chat with a real user
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
                    // Don't alert on alert failures — infinite loop risk
                    logger.error('Failed to alert admin', { adminId, error: sendErr.message });
                }
            }));

        } catch (alertErr) {
            logger.error('alertAdmins itself crashed', { error: alertErr.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  WORKER POOL
    // ═══════════════════════════════════════════════════════════════════════

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
                // Give alert time to send before exit
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
    //  END OF PART 1/3 — Continues in Part 2/3 below
    // ═══════════════════════════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════════════════════════
    // bot/TelegramBot.js — Part 2/3
    // Middleware Stack, Command Setup, Tier Integration & Free Tier Handlers
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
                captchaBlockedUntil: null,
                // ═════════════════════════════════════════════════════════════════
                //  NEW: Tier flow session state
                // ═════════════════════════════════════════════════════════════════
                otpMode: null,
                otpService: null,
                selectedTier: null,
                selectedCountry: null,
                tierOperator: null,
                tierKey: null,
                tierFlowStep: null,
                searchType: null,
                searchQuery: null,
                cheapDisplayPrice: null
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
                    return next();
                }

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
                    source: 'middleware.startInterceptor',
                    note: 'Start interceptor crash'
                });
                return ctx.reply('❌ Failed to start. Please try /start again.').catch(() => {});
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
                    return next();
                }

                if (this.isEffectiveAdmin(ctx)) {
                    return next();
                }

                if (ctx.callbackQuery?.data && /^captcha_(-?\d+)$/.test(ctx.callbackQuery.data)) {
                    return next();
                }

                if (ctx.callbackQuery?.data === 'verify_join_status') {
                    return next();
                }

                if (ctx.session?.joinVerified !== true) {
                    await ctx.reply(
                        '⛔ <b>Access Denied</b>\n\n' +
                        'You must complete verification before using this bot.\n\n' +
                        'Please tap /start to begin.',
                        { parse_mode: 'HTML' }
                    );
                    return;
                }

                const isFresh = ctx.session?.joinVerifiedAt &&
                                (Date.now() - ctx.session.joinVerifiedAt < VERIFICATION_TTL_MS);

                if (!isFresh && this.startVerification) {
                    const stillJoined = await this.startVerification.reverifyUser(ctx.from?.id, ctx);
                    if (!stillJoined) {
                        return;
                    }
                }

                return next();

            } catch (err) {
                logger.error('Global verification middleware error', { error: err.message, userId: ctx.from?.id });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: ctx.updateType,
                    command: ctx.message?.text || ctx.callbackQuery?.data,
                    source: 'middleware.joinVerification',
                    note: 'Global join verification middleware crash'
                });
            }
        });

        // Maintenance mode middleware
        this.bot.use(async (ctx, next) => {
            try {
                if (this.isShuttingDown) {
                    return ctx.reply('🔴 Bot is restarting. Please try again in a moment.').catch(() => {});
                }

                const isAdmin = this.isEffectiveAdmin(ctx);

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
                    source: 'middleware.maintenance',
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

    // ═══════════════════════════════════════════════════════════════════════
    //  COMMAND SETUP — Initialize all modules and wire handlers
    // ═══════════════════════════════════════════════════════════════════════

    async setupCommands() {
        try {
            this.smsProviderManager = new SMSProviderManager();
            await this.smsProviderManager.initialize();
            logger.info('SMS Provider Manager initialized in bot');
        } catch (error) {
            logger.error('Failed to initialize SMS Provider Manager', { error: error.message });
            this.smsProviderManager = null;
            await this.alertAdmins(error, {
                source: 'setup.setupCommands',
                note: 'SMS Provider Manager init failed'
            });
        }

        // ═════════════════════════════════════════════════════════════════
        //  NEW: Initialize Tier Integration Service
        // ═════════════════════════════════════════════════════════════════
        try {
            this.tierIntegrationService = new TierIntegrationService(this.smsProviderManager);
            await this.tierIntegrationService.initialize();
            logger.info('Tier Integration Service initialized', {
                available: this.tierIntegrationService.isAvailable(),
                metrics: this.tierIntegrationService.getMetrics()
            });
        } catch (error) {
            logger.error('Failed to initialize Tier Integration Service', { error: error.message });
            this.tierIntegrationService = null;
            await this.alertAdmins(error, {
                source: 'setup.setupCommands',
                note: 'Tier Integration Service init failed — CHEAP mode will use legacy flow'
            });
        }

        // Initialize command modules
        const userCommands = new UserCommands(this.bot, this.walletService);
        
        // ═════════════════════════════════════════════════════════════════
        //  NEW: Pass tier integration to OTPCommands
        // ═════════════════════════════════════════════════════════════════
        const otpCommands = new OTPCommands(
            this.bot, 
            this.walletService, 
            this.smsProviderManager,
            this.tierIntegrationService
        );
        
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

        // ═════════════════════════════════════════════════════════════════
        //  NEW: Register Tier Flow Middleware
        // ═════════════════════════════════════════════════════════════════
        if (this.tierIntegrationService && this.tierIntegrationService.isAvailable()) {
            this.tierFlowMiddleware = new TierFlowMiddleware(this.tierIntegrationService, otpCommands);
            this.tierFlowMiddleware.register(this.bot);
            logger.info('Tier Flow Middleware registered');
        } else {
            logger.warn('Tier Flow Middleware NOT registered — tier system unavailable');
        }

        // Initialize StartVerification
        this.startVerification = new StartVerification(
            this.bot,
            userCommands,
            (userId) => this.isAdmin(userId),
            (err, ctx) => this.alertAdmins(err, ctx)
        );

        // ═══════════════════════════════════════════════════════════════════════
        //  FREE TIER CONTROLLER — Wire all free mode handlers
        // ═══════════════════════════════════════════════════════════════════════

        this.freeNumberController = new FreeNumberController(this.bot);

        // Main free mode entry point
        this.bot.action('mode_free', async (ctx) => {
            try {
                ctx.answerCbQuery().catch(() => {});
                await this.freeNumberController.handleFreeRequest(ctx);
            } catch (error) {
                logger.error('mode_free action error', { error: error.message, userId: ctx.from?.id });
                await this.alertAdmins(error, {
                    userId: ctx.from?.id,
                    updateType: 'callback_query',
                    command: 'mode_free',
                    source: 'action.mode_free',
                    note: 'Free mode entry crash'
                });
            }
        });

        // Ad watching handlers
        this.bot.action(/watch_ad_(.+)/, async (ctx) => {
            try {
                await this.freeNumberController.handleWatchAd(ctx, ctx.match[1]);
            } catch (error) {
                logger.error('watch_ad action error', { error: error.message, userId: ctx.from?.id });
                await ctx.answerCbQuery('❌ Ad unavailable').catch(() => {});
            }
        });

        // Ad verification handlers
        this.bot.action(/verify_ad_(.+)/, async (ctx) => {
            try {
                await this.freeNumberController.handleVerifyAd(ctx, ctx.match[1]);
            } catch (error) {
                logger.error('verify_ad action error', { error: error.message, userId: ctx.from?.id });
                await ctx.answerCbQuery('❌ Verification failed').catch(() => {});
            }
        });

        // Cancel free session
        this.bot.action(/cancel_free_(.+)/, async (ctx) => {
            try {
                await this.freeNumberController.handleCancel(ctx, ctx.match[1]);
            } catch (error) {
                logger.error('cancel_free action error', { error: error.message, userId: ctx.from?.id });
                await ctx.answerCbQuery('❌ Cancel failed').catch(() => {});
            }
        });

        // Manual check now
        this.bot.action(/check_free_(.+)/, async (ctx) => {
            try {
                await this.freeNumberController.handleCheckNow(ctx, ctx.match[1]);
            } catch (error) {
                logger.error('check_free action error', { error: error.message, userId: ctx.from?.id });
                await ctx.answerCbQuery('❌ Check failed').catch(() => {});
            }
        });

        // ═══════════════════════════════════════════════════════════════════════
        //  GLOBAL ACTION HANDLERS
        // ═══════════════════════════════════════════════════════════════════════

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
                    command: 'help',
                    source: 'action.help',
                    note: 'Help action crash'
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
                    command: 'menu',
                    source: 'action.menu',
                    note: 'Menu action crash'
                });
            }
        });

        this.bot.action('open_admin_dashboard', async (ctx) => {
            try {
                if (!this.isEffectiveAdmin(ctx)) {
                    return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
                }
                await advancedAdmin.showDashboard(ctx, true);
            } catch (err) {
                logger.error('Admin dashboard action error', { error: err.message });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: 'callback_query',
                    command: 'open_admin_dashboard',
                    source: 'action.openAdminDashboard',
                    note: 'Admin dashboard action crash'
                });
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TEXT MESSAGE HANDLER — Admin inputs, broadcast, tier search, etc.
    // ═══════════════════════════════════════════════════════════════════════

    setupTextHandler() {
        this.bot.on(message('text'), async (ctx, next) => {
            try {
                if (!ctx.session) return next();

                const isAdmin = this.isEffectiveAdmin(ctx);

                // ═════════════════════════════════════════════════════════════════
                //  NEW: Tier search input handler (non-admin users)
                //  Must run BEFORE admin handlers to avoid conflicts
                // ═════════════════════════════════════════════════════════════════
                if (!isAdmin && ctx.session?.tierFlowStep?.startsWith('searching_')) {
                    const otpCommands = this.commandModules.get('otp');
                    if (otpCommands?.handleTierSearchInput) {
                        const handled = await otpCommands.handleTierSearchInput(ctx);
                        if (handled) return;
                    }
                }

                if (isAdmin) {
                    const advancedAdmin = this.commandModules.get('advancedAdmin');
                    const adminCommands = this.commandModules.get('admin');

                    const handled = await advancedAdmin.handleTextInput(ctx);
                    if (handled) return;

                    if (ctx.session.awaitingBroadcast) {
                        const { target, filter, label } = ctx.session.awaitingBroadcast;
                  // ═══════════════════════════════════════════════════════════════════════════════
    // bot/TelegramBot.js — Part 3/3
    // Launch Sequence, Deposit Scanner, Metrics, Health & Graceful Shutdown
    // ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  DEPOSIT SCANNER
    // ═══════════════════════════════════════════════════════════════════════

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
                await this.alertAdmins(error, {
                    source: 'scanner.depositScanner',
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

    // ═══════════════════════════════════════════════════════════════════════
    //  LAUNCH SEQUENCE
    // ═══════════════════════════════════════════════════════════════════════

    async launch() {
        try {
            logger.info('Initializing database...');
            await initModels();

            await this.setupCommands();
            this.setupTextHandler();

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
                source: 'launch.botLaunch',
                note: 'Bot failed to launch — critical'
            });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  GRACEFUL SHUTDOWN
    // ═══════════════════════════════════════════════════════════════════════

    async gracefulShutdown(signal) {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        logger.info(`Shutting down (${signal})`);

        try {
            this.bot.stop(signal);
        } catch (e) {}

        this.stopDepositScanner();

        // ═════════════════════════════════════════════════════════════════
        //  NEW: Shutdown tier integration service
        // ═════════════════════════════════════════════════════════════════
        if (this.tierIntegrationService) {
            try {
                this.tierIntegrationService.clearCaches();
                logger.info('Tier integration caches cleared');
            } catch (e) {
                logger.warn('Tier integration shutdown error', { error: e.message });
            }
        }

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

        // Exit with delay to allow final logs/alerts to flush
        setTimeout(() => process.exit(0), 2000);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  METRICS & HEALTH
    // ═══════════════════════════════════════════════════════════════════════

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
            walletScanMode: this.walletService?.scanMode || 'unknown',
            walletRpcType: this.walletService?.currentProviderType || 'none',
            smsProviderReady: !!this.smsProviderManager?.isInitialized,
            freeTierReady: !!this.freeNumberController?.provider?.isActive,
            // ═════════════════════════════════════════════════════════════════
            //  NEW: Tier system health
            // ═════════════════════════════════════════════════════════════════
            tierSystemReady: !!this.tierIntegrationService?.isAvailable(),
            tierSystemHealth: this.tierIntegrationService?.getHealth() || null,
            timestamp: new Date().toISOString()
        };
    }
}

export default TelegramBot;
                    
