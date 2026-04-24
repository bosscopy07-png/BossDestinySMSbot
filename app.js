import { config, connectDatabase } from './config/index.js';
import logger from './utils/logger.js';
import TelegramBot from './bot/index.js';
import { startServer } from './api/index.js';

const startApp = async () => {
    try {
        // Connect to database
        await connectDatabase();

        // Start Telegram bot
        const bot = new TelegramBot();
        await bot.launch();

        // Start API server
        await startServer(config.server.port);

        logger.info('Application started successfully', {
            env: config.server.env,
            port: config.server.port
        });

    } catch (error) {
        logger.error('Failed to start application', { error: error.message });
        process.exit(1);
    }
};

startApp();
 
