// ═══════════════════════════════════════════════════════════
//  bot/TelegramBot.js — Production-Grade Bot Bootstrap
// ═══════════════════════════════════════════════════════════

import { Telegraf, session as telegrafSession } from 'telegraf';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { initModels } from '../models/index.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import UserCommands from './commands/user.js';
import OTPCommands from './commands/otp.js';
import AdminCommands from './commands/admin.js';
import WalletService from '../services/wallet/index.js';

class TelegramBot {
    constructor() {
        if (!config.bot?.token) {
            throw new Error('BOT_TOKEN not configured. Set it in your environment variables.');
        }

        this.bot = new Telegraf(config.bot.token);
        this.walletService = new WalletService();
        
        // ─── State tracking ───
        this.isShuttingDown = false;
        this.isReady = false;
        this.commandModules = new Map();
        this.depositScannerInterval = null;
        this.shutdownTimeout = null;

        // ─── Initialize in order ───
        this.setupErrorHandling();   // First: catch everything
        this.setupMiddleware();      // Second: middleware stack
        this.setupCommands();        // Third: command handlers
    }

    // ═══════════════════════════════════════════════════════
    //  MIDDLEWARE SETUP
    // ═══════════════════════════════════════════════════════

    setupMiddleware() {
        // Session MUST be first — all other middleware depends on ctx.session
        // Using default in-memory session (resets on restart). For production persistence,
        // swap to @telegraf/session with Redis/MongoDB store [^11^]
        this.bot.use(telegrafSession({
            defaultSession: () => ({
                awaitingBroadcast: null,
                awaitingAddBalance: null,
                awaitingDeductBalance: null,
                awaitingBlacklistReason: null,
                awaitingMessageUser: null,
                broadcastMessage: null,
                broadcastTarget: null,
                broadcastFilter: null
            })
        }));

        // Rate limiting before auth — don't waste auth checks on throttled users
        this.bot.use(rateLimit({
            window: 60,
            max: 30,
            keyPrefix: 'bot_ratelimit',
            onLimitExceeded: async (ctx) => {
                logger.warn('Rate limit exceeded', { userId: ctx.from?.id });
                await ctx.reply('⏳ Too many requests. Please slow down.').catch(() => {});
            }
        }));

        // Auth middleware
        this.bot.use(requireAuth);

        // ─── Maintenance guard (injected after auth, before commands) ───
        this.bot.use(async (ctx, next) => {
            if (this.isShuttingDown) {
                return ctx.reply('🔴 Bot is shutting down. Please try again later.').catch(() => {});
            }
            return next();
        });
    }

    // ═══════════════════════════════════════════════════════
    //  COMMAND SETUP
    // ═══════════════════════════════════════════════════════

    setupCommands() {
        // ─── Initialize command modules ───
        const userCommands = new UserCommands(this.bot, this.walletService);
        const otpCommands = new OTPCommands(this.bot, this.walletService);
        const adminCommands = new AdminCommands(this.bot, this.walletService);

        this.commandModules.set('user', userCommands);
        this.commandModules.set('otp', otpCommands);
        this.commandModules.set('admin', adminCommands);

        // ─── Global start handler ───
        this.bot.start(async (ctx) => {
            try {
                await userCommands.handleStart(ctx);
            } catch (error) {
                logger.error('Start handler error', { error: error.message, userId: ctx.from?.id });
                await ctx.reply('❌ Failed to start. Please try /start again.').catch(() => {});
            }
        });

        // ─── Help action ───
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
            }
        });

        // ─── Menu action ───
        this.bot.action('menu', async (ctx) => {
            try {
                await ctx.answerCbQuery().catch(() => {});
                await userCommands.handleMenu(ctx);
            } catch (error) {
                logger.error('Menu action error', { error: error.message });
            }
        });

        // ─── Admin maintenance guard (applied AFTER AdminCommands registers its handlers) ───
        // This runs for ALL updates, blocking non-admins when maintenance is on
        this.bot.use(async (ctx, next) => {
            // Skip if no session or not a message/callback
            if (!ctx.from) return next();

            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            const isAdmin = adminIds.includes(ctx.from.id.toString());

            // If maintenance mode is ON and user is NOT admin → block
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
    }

    // ═══════════════════════════════════════════════════════
    //  ERROR HANDLING
    // ═══════════════════════════════════════════════════════

    setupErrorHandling() {
        // ─── Global Telegraf error catcher ───
        this.bot.catch((err, ctx) => {
            const errorInfo = {
                error: err.message,
                stack: err.stack,
                userId: ctx.from?.id,
                chatId: ctx.chat?.id,
                updateType: ctx.updateType,
                updateId: ctx.update?.update_id
            };

            logger.error('Bot error caught', errorInfo);

            // Specific error responses
            if (err.message?.includes('WALLET_NOT_READY')) {
                ctx.reply('⏳ Blockchain connection is warming up. Please try again in 30 seconds.').catch(() => {});
                return;
            }

            if (err.message?.includes('ETELEGRAM') && err.message?.includes('403')) {
                // User blocked the bot — don't spam logs
                logger.warn('User blocked bot', { userId: ctx.from?.id });
                return;
            }

            if (err.message?.includes('ETELEGRAM') && err.message?.includes('429')) {
                // Rate limited by Telegram
                logger.warn('Telegram rate limit hit', { userId: ctx.from?.id });
                return;
            }

            // Generic fallback
            ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
        });

        // ─── Process-level error handlers ───
        // These prevent crashes from taking down the entire process [^2^][^4^]

        process.on('uncaughtException', (err) => {
            logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
            if (!this.isShuttingDown) {
                this.gracefulShutdown('uncaughtException');
            }
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection', { reason: String(reason) });
            if (!this.isShuttingDown) {
                this.gracefulShutdown('unhandledRejection');
            }
        });
    }

    // ═══════════════════════════════════════════════════════
    //  DEPOSIT SCANNER
    // ═══════════════════════════════════════════════════════

    startDepositScanner() {
        const checkAndStart = async () => {
            if (this.isShuttingDown) return;

            try {
                if (this.walletService?.isReady) {
                    this.walletService.startDepositScanner(30000); // 30s interval
                    logger.info('Deposit scanner started');
                } else {
                    logger.warn('Wallet not ready, retrying scanner in 10s...');
                    setTimeout(checkAndStart, 10000);
                }
            } catch (error) {
                logger.error('Deposit scanner error', { error: error.message });
                setTimeout(checkAndStart, 30000); // Retry after longer delay on error
            }
        };

        // Initial delay to let wallet initialize
        setTimeout(checkAndStart, 5000);
    }

    stopDepositScanner() {
        try {
            if (this.walletService?.stopDepositScanner) {
                this.walletService.stopDepositScanner();
                logger.info('Deposit scanner stopped');
            }
        } catch (error) {
            logger.error('Error stopping deposit scanner', { error: error.message });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  LAUNCH
    // ═══════════════════════════════════════════════════════

    async launch() {
        try {
            // ─── Initialize database models ───
            logger.info('Initializing database models...');
            await initModels();
            logger.info('Database models initialized');

            // ─── Start deposit scanner ───
            this.startDepositScanner();

            // ─── Delete webhook and start polling ───
            await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
            await this.bot.launch();

            this.isReady = true;
            logger.info('Bot started successfully in polling mode');

            // ─── Register graceful shutdown signals ───
            // Use process.once to avoid duplicate handlers on hot reload [^10^]
            process.once('SIGINT', () => this.gracefulShutdown('SIGINT'));
            process.once('SIGTERM', () => this.gracefulShutdown('SIGTERM'));

        } catch (error) {
            logger.error('Failed to launch bot', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════
    //  GRACEFUL SHUTDOWN
    // ═══════════════════════════════════════════════════════

    async gracefulShutdown(signal) {
        if (this.isShuttingDown) {
            logger.info('Shutdown already in progress, ignoring signal', { signal });
            return;
        }

        this.isShuttingDown = true;
        logger.info(`Graceful shutdown initiated (${signal})`);

        // ─── Stop accepting new updates ───
        try {
            this.bot.stop(signal);
            logger.info('Bot polling stopped');
        } catch (error) {
            logger.error('Error stopping bot', { error: error.message });
        }

        // ─── Stop deposit scanner ───
        this.stopDepositScanner();

        // ─── Cleanup wallet service ───
        try {
            if (this.walletService?.disconnect) {
                await Promise.race([
                    this.walletService.disconnect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Wallet disconnect timeout')), 5000))
                ]);
                logger.info('Wallet service disconnected');
            }
        } catch (error) {
            logger.error('Wallet disconnect error', { error: error.message });
        }

        // ─── Hard timeout failsafe ───
        const SHUTDOWN_TIMEOUT = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 15000;
        this.shutdownTimeout = setTimeout(() => {
            logger.error(`Shutdown timeout (${SHUTDOWN_TIMEOUT}ms) exceeded. Forcing exit.`);
            process.exit(1);
        }, SHUTDOWN_TIMEOUT);

        // ─── Clear timeout and exit cleanly ───
        clearTimeout(this.shutdownTimeout);
        logger.info('Graceful shutdown complete');
        process.exit(0);
    }

    // ═══════════════════════════════════════════════════════
    //  HEALTH CHECK
    // ═══════════════════════════════════════════════════════

    getHealth() {
        return {
            status: this.isShuttingDown ? 'shutting_down' : this.isReady ? 'healthy' : 'starting',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            walletReady: this.walletService?.isReady || false,
            timestamp: new Date().toISOString()
        };
    }
}

export default TelegramBot;
            
