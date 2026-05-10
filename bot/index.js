// ═══════════════════════════════════════════════════════════════════════════════
// bot/TelegramBot.js — High-Performance Production Bot
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

        this.walletService = new WalletService(this.referralService);
        this.referralService = new ReferralService(this.walletService);
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
                if (err.message?.includes('ETELEGRAM') && err.message?.includes('403')) return;
                if (err.message?.includes('ETELEGRAM') && err.message?.includes('429')) {
                    logger.warn('Telegram rate limit', { userId: ctx.from?.id });
                    return;
                }
                logger.error('Bot error', { error: err.message, userId: ctx.from?.id, updateType: ctx.updateType });
                ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
            } catch (catchErr) {
                logger.error('Error inside bot.catch', { error: catchErr.message });
            }
        });

        process.on('uncaughtException', async (err) => {
            try {
                logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
                await this.alertAdmins(err, { source: 'process.uncaughtException', note: 'Process crash' });
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
                await this.alertAdmins(err, { source: 'process.unhandledRejection', note: 'Unhandled promise rejection' });
            } catch (alertErr) {
                logger.error('Failed to alert on unhandledRejection', { error: alertErr.message });
            }
            if (!this.isShuttingDown) {
                setTimeout(() => this.gracefulShutdown('unhandledRejection'), 1500);
            }
        });
    }

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

        this.bot.use(async (ctx, next) => {
            try {
                const text = ctx.message?.text || '';
                const isStartCommand = text === '/start' || /^\/start@/.test(text);
                if (!isStartCommand) {
                    return next();
                }
                if (!this.startVerification) {
                    logger.error('[StartInterceptor] StartVerification not initialized');
                    return ctx.reply('⏳ Bot is still starting. Please try again.').catch(() => {});
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

        this.bot.use(async (ctx, next) => {
            try {
                if (this.isShuttingDown) {
                    return ctx.reply('🔴 Bot is restarting. Please try again.').catch(() => {});
                }
                const isAdmin = this.isEffectiveAdmin(ctx);
                if (config.maintenance && !isAdmin) {
                    return ctx.reply(
                        '🔧 <b>Maintenance Mode</b>\n\nThe bot is currently under maintenance. Please try again later.',
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
                logger.debug(`Handler took ${Date.now() - start}ms`, { updateType: ctx.updateType, userId: ctx.from?.id });
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
            this.smsProviderManager = null;
            await this.alertAdmins(error, { source: 'setup.setupCommands', note: 'SMS Provider Manager init failed' });
        }

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
            await this.alertAdmins(error, { source: 'setup.setupCommands', note: 'Tier Integration Service init failed' });
        }

        const userCommands = new UserCommands(this.bot, this.walletService);
        const otpCommands = new OTPCommands(this.bot, this.walletService, this.smsProviderManager, this.tierIntegrationService);
        const adminCommands = new AdminCommands(this.bot, this.walletService, this.referralService, this.smsProviderManager);
        const advancedAdmin = new Admin(this.bot, this.walletService, this.referralService, this.smsProviderManager);

        this.commandModules.set('user', userCommands);
        this.commandModules.set('otp', otpCommands);
        this.commandModules.set('admin', adminCommands);
        this.commandModules.set('advancedAdmin', advancedAdmin);

        if (this.tierIntegrationService && this.tierIntegrationService.isAvailable()) {
            this.tierFlowMiddleware = new TierFlowMiddleware(this.tierIntegrationService, otpCommands);
            this.tierFlowMiddleware.register(this.bot);
            logger.info('Tier Flow Middleware registered');
        } else {
            logger.warn('Tier Flow Middleware NOT registered');
        }

        this.startVerification = new StartVerification(
            this.bot,
            userCommands,
            (userId) => this.isAdmin(userId),
            (err, ctx) => this.alertAdmins(err, ctx)
        );

        this.freeNumberController = new FreeNumberController(this.bot);

        this.bot.action('mode_free', async (ctx) => {
            try {
                ctx.answerCbQuery().catch(() => {});
                await this.freeNumberController.handleFreeRequest(ctx);
            } catch (error) {
                logger.error('mode_free action error', { error: error.message, userId: ctx.from?.id });
                await this.
