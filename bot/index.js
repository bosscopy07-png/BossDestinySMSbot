// ═══════════════════════════════════════════════════════════════════════════════
// bot/index.js (TelegramBot.js) — COMPLETE REWRITE
// Part 1/3 — Imports, Constructor, Core Utilities
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
import SessionManager from '../services/otp/SessionManager.js';
import RetryEngine from '../services/otp/RetryEngine.js'; 
import ReferralService from '../services/referral/index.js';
import WalletService from '../services/wallet/index.js';
import SMSProviderManager from '../services/sms/index.js';
import FreeNumberController from '../services/sms/FreeNumberController.js';
import StartVerification from './verification/StartVerification.js';
import TierIntegrationService from '../services/TierIntegrationService.js';
import TierFlowMiddleware from './middleware/TierFlowMiddleware.js';
import NotificationService from '../services/NotificationService.js';
import { cpus } from 'os';

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
        //  SERVICE INITIALIZATION — Fixed: Proper initialization order
        //  Order: NotificationService → ReferralService → WalletService
        // ═══════════════════════════════════════════════════════════════════════
        this.notificationService = new NotificationService(this.bot.telegram);
        this.referralService = new ReferralService(null, this.notificationService);
        this.walletService = new WalletService(this.referralService);
        // Back-reference after WalletService is created
        this.referralService.walletService = this.walletService;

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

        this.maxWorkers = Math.min(cpus().length, 4);
        this.workerPool = [];
        this.taskQueue = [];
        this.isWorkerPoolReady = false;

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
                    logger.warn('Invalid admin ID filtered out', { id });
                }
                return isValid;
            });

        this._adminIdsTimestamp = now;
        logger.info('Admin IDs resolved', { count: this._adminIds.length });
        return this._adminIds;
    }

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

    isEffectiveAdmin(ctx) {
        const effectiveId = this._getEffectiveUserId(ctx);
        return this.isAdmin(effectiveId);
    }

    async alertAdmins(error, context = {}) {
        try {
            const adminIds = this.getAdminIds();
            if (!adminIds.length) {
                logger.error('No valid admin IDs configured');
                return;
            }

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
                context.source ? `<b>Source:</b> ${context.source}` : '',
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
                    const chat = await this.bot.telegram.getChat(adminId).catch(() => null);

                    if (!chat || chat.type !== 'private') {
                        logger.warn('Skipping alert — not a private chat', { adminId, type: chat?.type });
                        return;
                    }

                    await this.bot.telegram.sendMessage(adminId, alertText, {
                        parse_mode: 'HTML',
                        disable_notification: false
                    });

                    logger.info('Error alert sent', { adminId });
                } catch (sendErr) {
                    logger.error('Failed to alert admin', { adminId, error: sendErr.message });
                }
            }));
        } catch (alertErr) {
            logger.error('alertAdmins crashed', { error: alertErr.message });
        }
    }

    setupWorkerPool() {
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

    async runInWorker(taskFn, data, options = {}) {
        return new Promise((resolve, reject) => {
            const timeout = options.timeout || 30000;
            const timer = setTimeout(() => {
                reject(new Error('Worker task timeout'));
            }, timeout);

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

    setupErrorHandling() {
        this.bot.catch(async (err, ctx) => {
            this.metrics.requestsFailed++;

            try {
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
// bot/index.js (TelegramBot.js) — Part 2/3
// Middleware Stack, Command Setup, Tier Integration & Free Tier
// ═══════════════════════════════════════════════════════════════════════════════

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
                // FIXED: Added referral persistence fields
                pendingReferralCode: null,
                pendingReferralCodeAt: null
            })
        }));

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

        this.bot.use(rateLimit({
            window: 60,
            max: 50,
            keyPrefix: 'bot_ratelimit',
            onLimitExceeded: async (ctx) => {
                logger.warn('Rate limit exceeded', { userId: ctx.from?.id });
                ctx.reply('⏳ Too many requests. Please slow down.').catch(() => {});
            }
        }));

        // ═══════════════════════════════════════════════════════════════════════
        //  START INTERCEPTOR — FIXED: Proper regex for all /start variants
        //  Matches: /start, /start@botname, /start REFCODE, /start@botname REFCODE
        // ═══════════════════════════════════════════════════════════════════════
        this.bot.use(async (ctx, next) => {
            try {
                const text = ctx.message?.text || '';
                // FIXED: Regex now matches /start, /start REFCODE, /start@botname, /start@botname REFCODE
                const isStartCommand = /^\/start(?:@\w+)?(?:\s+(.+))?$/.test(text);

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

        this.bot.use(async (ctx, next) => {
            try {
                if (ctx.chat?.type !== 'private') {
                    return await next();
                }

                if (this.isEffectiveAdmin(ctx)) {
                    return await next();
                }

                if (ctx.callbackQuery?.data && /^captcha_(-?\d+)$/.test(ctx.callbackQuery.data)) {
                    return await next();
                }

                if (ctx.callbackQuery?.data === 'verify_join_status') {
                    return await next();
                }

                if (ctx.session?.joinVerified !== true) {
                    await ctx.reply(
                        '⛔ <b>Access Denied</b>\n\nYou must complete verification before using this bot.\n\nPlease tap /start to begin.',
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

                return await next();
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

        this.bot.use(async (ctx, next) => {
            try {
                if (this.isShuttingDown) {
                    await ctx.reply('🔴 Bot is restarting. Please try again in a moment.').catch(() => {});
                    return;
                }

                const isAdmin = this.isEffectiveAdmin(ctx);

                if (config.maintenance && !isAdmin) {
                    await ctx.reply(
                        '🔧 <b>Maintenance Mode</b>\n\nThe bot is currently under maintenance. Please try again later.\n\n<i>We apologize for any inconvenience.</i>',
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                    return;
                }

                return await next();
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

         async setupCommands() {
        try {
            this.smsProviderManager = new SMSProviderManager();
            await this.smsProviderManager.initialize();
            logger.info('SMS Provider Manager initialized');
        } catch (error) {
            logger.error('Failed to initialize SMS Provider Manager', { error: error.message });
            await this.alertAdmins(error, {
                source: 'setup.setupCommands',
                note: 'SMS Provider Manager init failed — bot continues with degraded SMS'
            });
        }

        try {
            this.tierIntegrationService = new TierIntegrationService(this.smsProviderManager);
            await this.tierIntegrationService.initialize();
            logger.info('Tier Integration Service initialized');
        } catch (error) {
            logger.error('Failed to initialize Tier Integration Service', { error: error.message });
            await this.alertAdmins(error, {
                source: 'setup.tierIntegration',
                note: 'Tier Integration Service init failed — legacy CHEAP flow will be used'
            });
        }

        // ═══════════════════════════════════════════════════════════════════════
        //  DEBUG — Check tier system health (REMOVE AFTER FIXING)
        // ═══════════════════════════════════════════════════════════════════════
        console.log('=== TIER DEBUG ===');
        console.log('smsProviderManager exists:', !!this.smsProviderManager);
        console.log('smsProviderManager.isInitialized:', this.smsProviderManager?.isInitialized);
        console.log('CHEAP_PANEL provider:', this.smsProviderManager?.getProvider('CHEAP_PANEL')?.name);
        console.log('CHEAP_PANEL isActive:', this.smsProviderManager?.getProvider('CHEAP_PANEL')?.isActive);
        console.log('ProviderRouter hasAvailable:', this.smsProviderManager?.getProviderRouter()?.hasAvailableProvider());
        console.log('tierIntegrationService exists:', !!this.tierIntegrationService);
        console.log('tierIntegrationService._enabled:', this.tierIntegrationService?._enabled);
        console.log('tierIntegrationService._cheapProvider:', this.tierIntegrationService?._cheapProvider?.name);
        console.log('tierIntegrationService.isAvailable():', this.tierIntegrationService?.isAvailable?.());
        console.log('==================');

        // ═══════════════════════════════════════════════════════════════════════
        //  SESSION MANAGER — MUST be created BEFORE OTPCommands
        //  Pass this.bot (full Telegraf instance) for auto OTP delivery
        // ═══════════════════════════════════════════════════════════════════════
        let SessionManager, RetryEngine;
        try {
            const sessionManagerModule = await import('../services/otp/SessionManager.js');
            SessionManager = sessionManagerModule.default;
        } catch (err) {
            logger.error('Failed to import SessionManager', { error: err.message });
            // Create a stub so OTPCommands doesn't crash
            SessionManager = class StubSessionManager {
                constructor() { logger.warn('Using stub SessionManager'); }
                async createSession() { throw new Error('SessionManager not available'); }
            };
        }

        try {
            const retryModule = await import('../services/otp/RetryEngine.js');
            RetryEngine = retryModule.default;
        } catch (err) {
            logger.warn('RetryEngine not found, using inline stub', { error: err.message });
            RetryEngine = class RetryEngine {
                async execute(fn, options = {}) {
                    const maxRetries = options.maxRetries || 0;
                    let lastError;
                    for (let i = 0; i <= maxRetries; i++) {
                        try { return await fn(); } 
                        catch (error) { 
                            lastError = error; 
                            if (i < maxRetries) await new Promise(r => setTimeout(r, options.delay || 1000));
                        }
                    }
                    throw lastError;
                }
            };
        }

        const retryEngine = new RetryEngine();

        // Build service catalog if tierIntegrationService is available
        let serviceCatalog = null;
        if (this.tierIntegrationService?._serviceCatalog) {
            serviceCatalog = this.tierIntegrationService._serviceCatalog;
        }

        // Pass this.bot (the Telegraf instance) — NOT this.bot.telegram
        this.sessionManager = new SessionManager(
            this.smsProviderManager,
            retryEngine,
            this.walletService,
            this.notificationService,
            null,                    // numberPoolManager — add if you have one
            serviceCatalog,          // serviceCatalog from tier system
            this.bot                 // <-- FULL Telegraf bot instance for auto-delivery
        );
        logger.info('Session Manager initialized', { 
            hasBot: !!this.bot,
            botType: this.bot?.constructor?.name,
            hasServiceCatalog: !!serviceCatalog
        });

        // ═══════════════════════════════════════════════════════════════════════
        //  COMMAND MODULES — Now sessionManager exists and can be passed
        // ═══════════════════════════════════════════════════════════════════════
        const userCommands = new UserCommands(
            this.bot, 
            this.walletService, 
            this.referralService, 
            this.notificationService
        );

        // Pass arguments in correct order: bot, walletService, sessionManager, smsProviderManager, tierIntegrationService
        const otpCommands = new OTPCommands(
            this.bot, 
            this.walletService, 
            this.sessionManager,           // 3rd = sessionManager (now properly initialized)
            this.smsProviderManager,         // 4th = smsProviderManager
            this.tierIntegrationService      // 5th = tierIntegrationService (may be null)
        );

        const adminCommands = new AdminCommands(
            this.bot, 
            this.walletService, 
            this.referralService, 
            this.smsProviderManager
        );

        const advancedAdmin = new Admin(
            this.bot,
            this.walletService,
            this.referralService,
            this.smsProviderManager
        );

        // ═══════════════════════════════════════════════════════════════════════
        //  Inject tier services into OTPCommands if available
        // ═══════════════════════════════════════════════════════════════════════
        if (this.tierIntegrationService && typeof this.tierIntegrationService.isAvailable === 'function') {
            if (this.tierIntegrationService.isAvailable()) {
                otpCommands.tierService = this.tierIntegrationService;
                otpCommands.tierSelector = this.tierIntegrationService._tierSelector;
                otpCommands.serviceCatalog = this.tierIntegrationService._serviceCatalog;
                otpCommands.countryCatalog = this.tierIntegrationService._countryCatalog;
                logger.info('Tier services injected into OTPCommands', {
                    hasTierSelector: !!otpCommands.tierSelector,
                    hasServiceCatalog: !!otpCommands.serviceCatalog,
                    hasCountryCatalog: !!otpCommands.countryCatalog
                });
            } else {
                logger.warn('Tier Integration Service available but not enabled');
            }
        } else {
            logger.warn('Tier system not available, OTPCommands will use legacy flow');
        }

        this.commandModules.set('user', userCommands);
        this.commandModules.set('otp', otpCommands);
        this.commandModules.set('admin', adminCommands);
        this.commandModules.set('advancedAdmin', advancedAdmin);
            
        // ═══════════════════════════════════════════════════════════════════════
        //  StartVerification — FIXED: Injected with all required services
        // ═══════════════════════════════════════════════════════════════════════
        this.startVerification = new StartVerification(
            this.bot,
            userCommands,
            (userId) => this.isAdmin(userId),
            (err, ctx) => this.alertAdmins(err, ctx),
            {
                referralService: this.referralService,
                notificationService: this.notificationService,
                config: config
            }
        );

        if (this.tierIntegrationService && otpCommands) {
            this.tierFlowMiddleware = new TierFlowMiddleware(this.tierIntegrationService, otpCommands);
            this.tierFlowMiddleware.register(this.bot);
            logger.info('Tier Flow Middleware registered');
        }

        this.freeNumberController = new FreeNumberController(this.bot);

        this.bot.action('mode_free', async (ctx) => {
            try {
                await ctx.answerCbQuery().catch(() => {});
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

        this.bot.action(/watch_ad_(.+)/, async (ctx) => {
            try {
                await this.freeNumberController.handleWatchAd(ctx, ctx.match[1]);
            } catch (error) {
                logger.error('watch_ad action error', { error: error.message, userId: ctx.from?.id });
                await ctx.answerCbQuery('❌ Ad unavailable').catch(() => {});
            }
        });

        this.bot.action(/verify_ad_(.+)/, async (ctx) => {
            try {
                await this.freeNumberController.handleVerifyAd(ctx, ctx.match[1]);
            } catch (error) {
                logger.error('verify_ad action error', { error: error.message, userId: ctx.from?.id });
                await ctx.answerCbQuery('❌ Verification failed').catch(() => {});
            }
        });

        this.bot.action(/cancel_free_(.+)/, async (ctx) => {
            try {
                await this.freeNumberController.handleCancel(ctx, ctx.match[1]);
            } catch (error) {
                logger.error('cancel_free action error', { error: error.message, userId: ctx.from?.id });
                await ctx.answerCbQuery('❌ Cancel failed').catch(() => {});
            }
        });

        this.bot.action(/check_free_(.+)/, async (ctx) => {
            try {
                await this.freeNumberController.handleCheckNow(ctx, ctx.match[1]);
            } catch (error) {
                logger.error('check_free action error', { error: error.message, userId: ctx.from?.id });
                await ctx.answerCbQuery('❌ Check failed').catch(() => {});
            }
        });

        this.bot.action('help', async (ctx) => {
            try {
                await ctx.answerCbQuery().catch(() => {});
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
                await ctx.answerCbQuery().catch(() => {});
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
                    
       
        setupTextHandler() {
        this.bot.on(message('text'), async (ctx, next) => {
            try {
                const isAdmin = this.isEffectiveAdmin(ctx);

                if (isAdmin) {
                    const advancedAdmin = this.commandModules.get('advancedAdmin');
                    const adminCommands = this.commandModules.get('admin');

                    if (advancedAdmin) {
                        const handled = await advancedAdmin.handleTextInput(ctx);
                        if (handled) return;
                    }

                    if (ctx.session?.awaitingBroadcast) {
                        const { target, filter, label } = ctx.session.awaitingBroadcast;
                        delete ctx.session.awaitingBroadcast;
                        if (adminCommands) {
                            await adminCommands.executeBroadcast(ctx, filter, label, ctx.message.text);
                        }
                        return;
                    }

                    if (ctx.session?.awaitingAddBalance) {
                        const targetId = ctx.session.awaitingAddBalance;
                        delete ctx.session.awaitingAddBalance;
                        const amount = parseFloat(ctx.message.text);
                        if (isNaN(amount) || amount <= 0) {
                            if (adminCommands?.replyError) {
                                await adminCommands.replyError(ctx, '❌ <b>Invalid amount.</b>');
                            }
                            return;
                        }
                        if (adminCommands) {
                            await adminCommands.processAddBalance(ctx, targetId, amount, 'Admin credit via inline');
                        }
                        return;
                    }

                    if (ctx.session?.awaitingDeductBalance) {
                        const targetId = ctx.session.awaitingDeductBalance;
                        delete ctx.session.awaitingDeductBalance;
                        const amount = parseFloat(ctx.message.text);
                        if (isNaN(amount) || amount <= 0) {
                            if (adminCommands?.replyError) {
                                await adminCommands.replyError(ctx, '❌ <b>Invalid amount.</b>');
                            }
                            return;
                        }
                        if (adminCommands) {
                            await adminCommands.processDeductBalance(ctx, targetId, amount, 'Admin deduction via inline');
                        }
                        return;
                    }

                    if (ctx.session?.awaitingBlacklistReason) {
                        const targetId = ctx.session.awaitingBlacklistReason;
                        delete ctx.session.awaitingBlacklistReason;
                        const reason = ctx.message.text.trim().toLowerCase() === 'skip'
                            ? 'Manual blacklist'
                            : ctx.message.text.trim();
                        if (adminCommands) {
                            await adminCommands.processBlacklist(ctx, targetId, reason);
                        }
                        return;
                    }

                    if (ctx.session?.awaitingMessageUser) {
                        const targetId = ctx.session.awaitingMessageUser;
                        delete ctx.session.awaitingMessageUser;
                        if (adminCommands) {
                            await adminCommands.processMessageUser(ctx, targetId, ctx.message.text);
                        }
                        return;
                    }
                }

                return await next();
            } catch (err) {
                logger.error('Text message handler error', { error: err.message, userId: ctx.from?.id });
                await this.alertAdmins(err, {
                    userId: ctx.from?.id,
                    updateType: 'message',
                    command: ctx.message?.text,
                    source: 'handler.textMessage',
                    note: 'Text handler crash'
                });
            }
        });
        }
    // ═══════════════════════════════════════════════════════════════════════════════
// bot/index.js (TelegramBot.js) — Part 3/3
// Launch Sequence, Deposit Scanner, Metrics & Graceful Shutdown
// ═══════════════════════════════════════════════════════════════════════════════

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

    async gracefulShutdown(signal) {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        logger.info('Shutting down (' + signal + ')');

        try {
            this.bot.stop(signal);
        } catch (e) {
            logger.warn('Error stopping bot', { error: e.message });
        }

        this.stopDepositScanner();

        if (this.tierIntegrationService) {
            try {
                await this.tierIntegrationService.shutdown?.();
                logger.info('Tier Integration Service shut down');
            } catch (e) {
                logger.warn('Tier Integration Service shutdown failed', { error: e.message });
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
        } catch (e) {
            logger.warn('Wallet disconnect timeout or error', { error: e.message });
        }

        setTimeout(() => process.exit(0), 2000);
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
            walletScanMode: this.walletService?.scanMode || 'unknown',
            walletRpcType: this.walletService?.currentProviderType || 'none',
            smsProviderReady: !!this.smsProviderManager?.isInitialized,
            tierIntegrationReady: !!this.tierIntegrationService?.isInitialized,
            freeTierReady: !!this.freeNumberController?.provider?.isActive,
            timestamp: new Date().toISOString()
        };
    }
}

export default TelegramBot;
