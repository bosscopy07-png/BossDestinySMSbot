import { config, connectDatabase } from './config/index.js';
import logger from './utils/logger.js';
import TelegramBot from './bot/index.js';
import { startServer } from './api/index.js';
import CronJobs from './cron/index.js';

const startApp = async () => {
    console.log('🟢 [DEBUG] startApp() called');
    
    try {
        // Connect to database
        console.log('🔧 [DEBUG] Connecting to database...');
        await connectDatabase();
        console.log('✅ [DEBUG] Database connected');

        // Start Telegram bot
        console.log('🔧 [DEBUG] Creating TelegramBot...');
        const bot = new TelegramBot();
        console.log('✅ [DEBUG] TelegramBot created');
        
        console.log('🔧 [DEBUG] Launching bot...');
        await bot.launch();
        console.log('✅ [DEBUG] Bot launched');

        // Start API server
        console.log('🔧 [DEBUG] Starting API server...');
        await startServer(config.server.port);
        console.log('✅ [DEBUG] API server started');

        // Start cron jobs
        console.log('🔧 [DEBUG] Starting cron jobs...');
        const cronJobs = new CronJobs();
        cronJobs.start();
        console.log('✅ [DEBUG] Cron jobs started');

        logger.info('Application started successfully', {
            env: config.server.env,
            port: config.server.port
        });

    } catch (error) {
        console.error('💥 [DEBUG] startApp() FAILED:', error.message);
        console.error(error.stack);
        logger.error('Failed to start application', { error: error.message });
        process.exit(1);
    }
};

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('💥 [DEBUG] UNCAUGHT EXCEPTION:', error.message);
    console.error(error.stack);
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 [DEBUG] UNHANDLED REJECTION:', reason);
    logger.error('Unhandled rejection', { reason, promise });
});

console.log('🟢 [DEBUG] Script loaded, calling startApp()...');
startApp();
