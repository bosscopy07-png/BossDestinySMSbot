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
import { Worker } from 'worker_threads';
import { cpus } from 'os';

// ═══════════════════════════════════════════════════════
//  MANDATORY JOIN CONFIGURATION
// ═══════════════════════════════════════════════════════

const MANDATORY_CHANNELS = [
    { id: '@Swiftsmscommunity', name: 'SwiftSMS Community', url: 'https://t.me/Swiftsmscommunity' },
    { id: '@swiftsmstech', name: 'SwiftSMS Tech', url: 'https://t.me/swiftsmstech' }
];

const WELCOME_IMAGE_URL = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';

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

        // Error alert deduplication
        this.errorAlertCooldown = new Map();
        this.errorAlertInterval = 300000;

        // Cached admin IDs
        this._adminIds = null;
        this._adminIdsTimestamp = 0;

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
    //  ADMIN ERROR ALERTS
    // ═══════════════════════════════════════════════════════

    async alertAdmins(error, context = {}) {
        const adminIds = this.getAdminIds();
        if (!adminIds.length) return;

        const errorKey = `${error.name}:${error.message?.slice(0, 50)}`;
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
            `<b>Error:</b> <code>${error.name}</code>`,
            `<b>Message:</b> <code>${error.message?.slice(0, 400) || 'N/A'}</code>`,
            `<b>Time:</b> ${new Date().toISOString()}`,
            `<b>Env:</b> ${process.env.NODE_ENV || 'production'}`,
            context.userId ? `<b>User:</b> <code>${context.userId}</code>` : '',
            context.updateType ? `<b>Update:</b> ${context.updateType}` : '',
            context.command ? `<b>Command:</b> ${context.command}` : '',
            '',
            '<b>Stack:</b>',
            `<pre>${stack}</pre>`
        ].filter(Boolean).join('\n');

        adminIds.forEach(async (adminId) => {
            try {
                await this.bot.telegram.sendMessage(adminId, alertText, {
                    parse_mode: 'HTML',
                    disable_notification: false
                });
            } catch (sendErr) {
                logger.error('Failed to alert admin', { adminId, error: sendErr.message });
            }
        });
    }

    // ═══════════════════════════════════════════════════════
    //  JOIN VERIFICATION
    // ═══════════════════════════════════════════════════════

    async checkUserMembership(userId) {
        const results = await Promise.allSettled(
            MANDATORY_CHANNELS.map(async (channel) => {
                try {
                    const member = await this.bot.telegram.getChatMember(channel.id, userId);
                    const status = member.status;
                    return {
                        channel: channel.id,
                        joined: ['member', 'administrator', 'creator'].includes(status),
                        status
                    };
                } catch (err) {
                    logger.warn('Membership check failed', { 
                        channel: channel.id, 
                        userId, 
                        error: err.message,
                        code: err.code,
                        description: err.description
                    });
                    // If bot can't check, DON'T assume joined — this was the bug
                    return { channel: channel.id, joined: false, status: 'error', error: err.message };
                }
            })
        );

        const memberships = results.map(r => 
            r.status === 'fulfilled' ? r.value : { channel: 'unknown', joined: false, status: 'error' }
        );
        
        const allJoined = memberships.every(m => m.joined);

        return { allJoined, memberships };
    }

    async sendJoinRequirement(ctx) {
        const keyboard = {
            inline_keyboard: [
                ...MANDATORY_CHANNELS.map(ch => ([
                    { text: `📢 Join ${ch.name}`, url: ch.url }
                ])),
                [{ text: '✅ I\'ve Joined — Continue', callback_data: 'verify_join_status' }]
            ]
        };

        const caption = [
            '<b>👋 Welcome to SwiftSMS Bot!</b>',
            '',
            '📌 <b>To get started, please join our community:</b>',
            '',
            '1️⃣ <b>SwiftSMS Community</b> — Updates & announcements',
            '2️⃣ <b>SwiftSMS Tech</b> — Support & discussions',
            '',
            '<i>Click the buttons below, join both, then tap "I\'ve Joined".</i>'
        ].join('\n');

        try {
            await ctx.replyWithPhoto(WELCOME_IMAGE_URL, {
                caption,
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        } catch (photoErr) {
            logger.warn('Photo send failed, falling back to text', { error: photoErr.message });
            await ctx.reply(caption, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
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

        this.bot.use(requireAuth);

        this.bot.use(async (ctx, next) => {
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
        //  JOIN VERIFICATION CALLBACK
        // ═══════════════════════════════════════════════════

        this.bot.action('verify_join_status', async (ctx) => {
            try {
                await ctx.answerCbQuery('⏳ Checking...').catch(() => {});

                const userId = ctx.from?.id;
                if (!userId) return;

                const membership = await this.checkUserMembership(userId);

                if (membership.allJoined) {
                    ctx.session.joinVerified = true;

                    await ctx.deleteMessage().catch(() => {});
                    await ctx.reply('✅ <b>Welcome aboard!</b> You now have full access to the bot.', { parse_mode: 'HTML' });
                    
                    await userCommands.handleStart(ctx);
                } else {
                    const notJoined = membership.memberships
                        .filter(m => !m.joined)
                        .map(m => {
                            const ch = MANDATORY_CHANNELS.find(c => c.id === m.channel);
                            return ch ? ch.name : m.channel;
                        });

                    await ctx.answerCbQuery(`❌ Still missing: ${notJoined.join(', ')}`, { show_alert: true });
                }
            } catch (error) {
                logger.error('Join verification error', { error: error.message, userId: ctx.from?.id });
                this.alertAdmins(error, { userId: ctx.from?.id, updateType: 'callback_query', command: 'verify_join_status' });
                await ctx.answerCbQuery('❌ Error checking. Please try again.', { show_alert: true }).catch(() => {});
            }
        });

        // ═══════════════════════════════════════════════════
        //  START HANDLER WITH JOIN CHECK
        // ═══════════════════════════════════════════════════

        this.bot.start(async (ctx) => {
            this.trackEvent('command_start', ctx.from?.id);
            
            try {
                const userId = ctx.from?.id;

                // Admins bypass join check
                if (!this.isAdmin(userId) && !ctx.session?.joinVerified) {
                    const membership = await this.checkUserMembership(userId);
                    
                    if (!membership.allJoined) {
                        return this.sendJoinRequirement(ctx);
                    }
                    
                    ctx.session.joinVerified = true;
                }

                await userCommands.handleStart(ctx);
            } catch (error) {
                logger.error('Start handler error', { error: error.message, userId: ctx.from?.id });
                this.alertAdmins(error, { userId: ctx.from?.id, updateType: 'message', command: '/start' });
                ctx.reply('❌ Failed to start. Please try /start again.').catch(() => {});
            }
        });

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
                this.alertAdmins(error, { userId: ctx.from?.id, updateType: 'callback_query', command: 'help' });
            }
        });

        this.bot.action('menu', async (ctx) => {
            try {
                ctx.answerCbQuery().catch(() => {});
                await userCommands.handleMenu(ctx);
            } catch (error) {
                logger.error('Menu action error', { error: error.message });
                this.alertAdmins(error, { userId: ctx.from?.id, updateType: 'callback_query', command: 'menu' });
            }
        });

        this.bot.action('open_admin_dashboard', async (ctx) => {
            if (!this.isAdmin(ctx.from?.id)) {
                return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
            }
            
            await advancedAdmin.showDashboard(ctx, true);
        });

        this.bot.on(message('text'), async (ctx, next) => {
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
        });
    }

    setupErrorHandling() {
        this.bot.catch((err, ctx) => {
            this
