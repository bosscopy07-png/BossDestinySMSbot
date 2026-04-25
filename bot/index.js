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
        console.log('🔧 [DEBUG] TelegramBot constructor starting...');
        
        // Validate bot token first
        if (!config.bot?.token) {
            console.error('❌ [DEBUG] BOT_TOKEN is missing!');
            throw new Error('BOT_TOKEN not configured');
        }
        console.log('✅ [DEBUG] BOT_TOKEN is set');

        this.bot = new Telegraf(config.bot.token);
        console.log('✅ [DEBUG] Telegraf instance created');

        this.walletService = new WalletService();
        console.log('✅ [DEBUG] WalletService initialized');

        this.setupMiddleware();
        console.log('✅ [DEBUG] Middleware setup complete');

        this.setupCommands();
        console.log('✅ [DEBUG] Commands setup complete');

        this.setupErrorHandling();
        console.log('✅ [DEBUG] Error handling setup complete');
    }

    setupMiddleware() {
        this.bot.use(telegrafSession());
        this.bot.use(rateLimit({
            window: 60,
            max: 30,
            keyPrefix: 'bot_ratelimit'
        }));
        this.bot.use(requireAuth);
    }

    setupCommands() {
        new UserCommands(this.bot, this.walletService);
        new OTPCommands(this.bot);
        new AdminCommands(this.bot);

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

        this.bot.on('text', async (ctx) => {
            // Handle text-based flows
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

        process.once('SIGINT', () => this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }

    async launch() {
        console.log('🚀 [DEBUG] launch() called');
        
        try {
            if (process.env.WEBHOOK_URL) {
                console.log('🔧 [DEBUG] Using webhook mode');
                await this.bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`);
                logger.info('Webhook set', { url: process.env.WEBHOOK_URL });
            } else {
                console.log('🔧 [DEBUG] Using polling mode');
                await this.bot.launch();
                console.log('✅ [DEBUG] bot.launch() succeeded');
                logger.info('Bot started in polling mode');
            }
        } catch (error) {
            console.error('❌ [DEBUG] Failed to launch bot:', error.message);
            logger.error('Failed to launch bot', { error: error.message });
            throw error;
        }
    }

    getInstance() {
        return this.bot;
    }
}

export default TelegramBot;
