import { config, connectDatabase } from './config/index.js';
import logger from './utils/logger.js';
import TelegramBot from './bot/index.js';
import { startServer } from './api/index.js';
import CronJobs from './cron/index.js';

let bot;

const startApp = async () => {
    try {
        await connectDatabase();
        
        bot = new TelegramBot();
        await bot.launch();
        
        await startServer(config.server.port);
        
        const cronJobs = new CronJobs();
        cronJobs.start();

        logger.info('Application started successfully');

    } catch (error) {
        logger.error('Failed to start application', { error: error.message, stack: error.stack });
        process.exit(1);
    }
};

process.on('SIGINT', () => {
    if (bot) bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (bot) bot.stop();
    process.exit(0);
});

startApp();
