process.on('uncaughtException', (err) => {
    console.error('💥 UNCAUGHT:', err.message);
    console.error(err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 UNHANDLED:', reason);
    process.exit(1);
});

try {
    const { config, connectDatabase } = await import('./config/index.js');
    const { default: logger } = await import('./utils/logger.js');
    const { default: TelegramBot } = await import('./bot/index.js');
    const { startServer } = await import('./api/index.js');
    const { default: CronJobs } = await import('./cron/index.js');

    let bot;

    const startApp = async () => {
        try {
            console.log('🟢 Starting app...');
            
            console.log('🔧 Connecting DB...');
            await connectDatabase();
            console.log('✅ DB connected');

            console.log('🔧 Creating bot...');
            bot = new TelegramBot();
            console.log('✅ Bot created');

            console.log('🔧 Launching bot...');
            await bot.launch();
            console.log('✅ Bot launched');

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
            logger.error('Failed to start application', { error: error.message, stack: error.stack });
            process.exit(1);
        }
    };

    process.on('SIGINT', () => {
        if (bot) bot.stop('SIGINT');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        if (bot) bot.stop('SIGTERM');
        process.exit(0);
    });

    console.log('🟢 app.js loaded, calling startApp()...');
    startApp();

} catch (err) {
    console.error('💥 IMPORT CRASH:', err.message);
    console.error(err.stack);
    process.exit(1);
                }
