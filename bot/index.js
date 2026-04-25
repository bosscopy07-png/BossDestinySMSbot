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
        
        // Store command instances to reuse
        this.userCommands = null;
        this.otpCommands = null;
        this.adminCommands = null;

        this.setupMiddleware();
        this.setupCommands();
        this.setupErrorHandling();
        this.startDepositScanner();
    }

    setupMiddleware() {
        this.bot.use(telegrafSession());
        this.bot.use(rateLimit({ window: 60, max: 30, keyPrefix: 'bot_ratelimit' }));
        this.bot.use(requireAuth);
    }

    setupCommands() {
        // Create command instances once
        this.userCommands = new UserCommands(this.bot, this.walletService);
        this.otpCommands = new OTPCommands(this.bot, this.walletService);
        this.adminCommands = new AdminCommands(this.bot);

        // Override start to use proper welcome from UserCommands
        this.bot.start(async (ctx) => {
            await this.userCommands.handleStart(ctx);
        });

        // Help action
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

        // Menu action - reuse instance
        this.bot.action('menu', async (ctx) => {
            await this.userCommands.handleMenu(ctx);
        });
    }

    startDepositScanner() {
        // Wait for wallet to be ready, then start scanning
        const checkAndStart = () => {
            if (this.walletService.isReady) {
                this.walletService.startDepositScanner(30000); // Every 30 seconds
                logger.info('Deposit scanner started');
            } else {
                logger.warn('Wallet not ready, retrying scanner in 10s...');
                setTimeout(checkAndStart, 10000);
            }
        };

        // Give wallet 5 seconds to initialize first
        setTimeout(checkAndStart, 5000);
    }

    setupErrorHandling() {
        this.bot.catch((err, ctx) => {
            logger.error('Bot error', { 
                error: err.message, 
                userId: ctx.from?.id,
                updateType: ctx.updateType 
            });
            
            // Don't crash on user errors
            if (err.message?.includes('WALLET_NOT_READY')) {
                ctx.reply('⏳ Blockchain connection is warming up. Please try again in 30 seconds.').catch(() => {});
            } else {
                ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
            }
        });
    }

    async launch() {
        try {
            // Delete any existing webhook to ensure polling works
            await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
            
            await this.bot.launch();
            logger.info('Bot started in polling mode');

            // Enable graceful stop
            process.once('SIGINT', () => this.stop('SIGINT'));
            process.once('SIGTERM', () => this.stop('SIGTERM'));

        } catch (error) {
            logger.error('Failed to launch bot', { error: error.message });
            throw error;
        }
    }

    stop(reason = 'manual') {
        logger.info(`Stopping bot (${reason})`);
        this.bot.stop(reason);
        
        // Stop deposit scanner if running
        if (this.walletService) {
            // Clear any intervals
            // (add clearInterval in wallet service if you store the interval ID)
        }
    }
}

export default TelegramBot;
    
