import { Telegraf, session as telegrafSession } from 'telegraf';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit, sessionLock } from './middleware/rateLimit.js';
import UserCommands from './commands/user.js';
import OTPCommands from './commands/otp.js';
import AdminCommands from './commands/admin.js';
import WalletService from '../services/wallet/index.js';

class TelegramBot {
    constructor() {
        this.bot = new Telegraf(config.bot.token);
        this.walletService = new WalletService();
        this.setupMiddleware();
        this.setupCommands();
        this.setupErrorHandling();
    }

    setupMiddleware() {
        // Session middleware
        this.bot.use(telegrafSession());

        // Rate limiting
        this.bot.use(rateLimit({
            window: 60,
            max: 30,
            keyPrefix: 'bot_ratelimit'
        }));

        // Auth middleware for all commands
        this.bot.use(requireAuth);
    }

    setupCommands() {
        // Initialize command handlers
        new UserCommands(this.bot, this.walletService);
        new OTPCommands(this.bot);
        new AdminCommands(this.bot);

        // Global callbacks
        this.bot.action('menu', async (ctx) => {
            const userCmd = new UserCommands(this.bot, this.walletService);
            await userCmd.handleMenu(ctx);
        });

        this.bot.action('help', async (ctx) => {
            await ctx.reply(`
❓ Help & Commands

📱 /otp - Request OTP
💰 /balance - Check balance
💳 /deposit - Add funds
📜 /history - Transaction history
🎁 /referral - Referral program
📊 /stats - Your statistics
⚙️ /settings - Bot settings
❌ /cancel - Cancel active session

Admin Only:
🔐 /admin - Admin dashboard
            `);
        });

        // Handle text messages (service input)
        this.bot.on('text', async (ctx) => {
            // Handle any text-based flows here
            // Currently all flows use inline keyboards
        });
    }

    setupErrorHandling() {
        this.bot.catch((err, ctx) => {
            logger.error('Bot error', {
                error: err.message,
                stack: err.stack,
                update: ctx.updateType
            });

            ctx.reply('❌ An error occurred. Please try again or contact support.').catch(() => {});
        });

        // Graceful shutdown
        process.once('SIGINT', () => this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }

    async launch() {
        try {
            // Set webhook or start polling
            if (process.env.WEBHOOK_URL) {
                await this.bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`);
                logger.info('Webhook set', { url: process.env.WEBHOOK_URL });
            } else {
                await this.bot.launch();
                logger.info('Bot started in polling mode');
            }
        } catch (error) {
            logger.error('Failed to launch bot', { error: error.message });
            throw error;
        }
    }

    getInstance() {
        return this.bot;
    }
}

export default TelegramBot;
 
