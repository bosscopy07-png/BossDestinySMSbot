import { config, connectDatabase } from './config/index.js';
import logger from './utils/logger.js';
import TelegramBot from './bot/index.js';
import { startServer } from './api/index.js';
import CronJobs from './cron/index.js';

// Catch ALL errors immediately
process.on('uncaughtException', (error) => {
    console.error('💥 UNCAUGHT:', error.message);
    console.error(error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 UNHANDLED:', reason);
    process.exit(1);
});

const startApp = async () => {
    try {
        console.log('🟢 Starting app...');
        
        console.log('🔧 Connecting DB...');
        await connectDatabase();
        console.log('✅ DB connected');

        console.log('🔧 Creating bot...');
        const bot = new TelegramBot();
        console.log('✅ Bot created');

        console.log('🔧 Launching bot...');
        await bot.launch();
        console.log('✅ Bot launched - should be responding now');

        console.log('🔧 Starting API...');
        await startServer(config.server.port);
        console.log('✅ API started');

        console.log('🔧 Starting cron...');
        const cronJobs = new CronJobs();
        cronJobs.start();
        console.log('✅ Cron started');

        logger.info('Application started successfully');

    } catch (error) {
        console.error('💥 startApp FAILED:', error.message);
        console.error(error.stack);
        logger.error('Failed to start application', { error: error.message });
        process.exit(1);
    }
};

startApp();
