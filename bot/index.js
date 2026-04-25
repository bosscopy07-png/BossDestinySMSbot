import { Telegraf, session as telegrafSession } from 'telegraf';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import UserCommands from './commands/user.js';
import OTPCommands from './commands/otp.js';
import AdminCommands from './commands/admin.js';
import WalletService from '../services/wallet/index.js';

class TelegramBot {
    constructor() {
        if (!config.bot?.token) {
            throw new Error('BOT_TOKEN not configured');
        }

        this.bot = new Telegraf(config.bot.token);
        this.walletService = new WalletService();

        this.setupMiddleware();
        this.setupCommands();
        this.setupErrorHandling();
    }

    setupMiddleware() {
        this.bot.use(telegrafSession());
        this.bot.use(rateLimit({ window: 60, max: 30, keyPrefix: 'bot_ratelimit' }));
        this.bot.use(requireAuth);
    }

    setupCommands() {
        // Start command
        this.bot.start(async (ctx) => {
            await ctx.reply('👋 Welcome! Use /menu to get started.');
        });

        new UserCommands(this.bot, this.walletService);
        new OTPCommands(this.bot);
        new AdminCommands(this.bot);

        this.bot.action('menu', async (ctx) => {
            const userCmd = new UserCommands(this.bot, this.walletService);
            await userCmd.handleMenu(ctx);
        });

        this.bot.action('help', async (ctx) => {
            await ctx.reply('❓ Help & Commands\n\n📱 /otp - Request OTP\n💰 /balance - Check balance\n💳 /deposit - Add funds\n📜 /history - Transaction history\n🎁 /referral - Referral program\n📊 /stats - Your statistics\n⚙️ /settings - Bot settings\n❌ /cancel - Cancel active session\n\nAdmin Only:\n🔐 /admin - Admin dashboard');
        });
    }

    setupErrorHandling() {
        this.bot.catch((err, ctx) => {
            logger.error('Bot error', { error: err.message });
            ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
        });
    }

    async launch() {
        try {
            // Delete any existing webhook to ensure polling works
            await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
            
            await this.bot.launch();
            logger.info('Bot started in polling mode');
        } catch (error) {
            logger.error('Failed to launch bot', { error: error.message });
            throw error;
        }
    }

    stop() {
        this.bot.stop();
    }
}

export default TelegramBot;
