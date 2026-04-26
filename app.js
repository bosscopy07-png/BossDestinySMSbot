process.on('uncaughtException', (err) => {
    console.error('💥 UNCAUGHT EXCEPTION:', err.message);
    console.error('Stack:', err.stack);
    console.error('Type:', err.name);
    console.error('Code:', err.code || 'N/A');
    if (err.cause) console.error('Cause:', err.cause);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION at:', promise);
    console.error('Reason:', reason);
    if (reason instanceof Error) {
        console.error('Stack:', reason.stack);
    }
    process.exit(1);
});

process.on('warning', (warning) => {
    console.warn('⚠️  NODE WARNING:', warning.name);
    console.warn('Message:', warning.message);
    console.warn('Stack:', warning.stack);
});

const logImportAttempt = (modulePath) => {
    console.log(`📦 Importing: ${modulePath}...`);
};

const logImportSuccess = (modulePath, exports) => {
    console.log(`✅ Imported: ${modulePath}`);
    console.log(`   Exports: ${Object.keys(exports || {}).join(', ') || 'default only'}`);
};

const logImportError = (modulePath, error) => {
    console.error(`❌ FAILED to import: ${modulePath}`);
    console.error(`   Error: ${error.message}`);
    console.error(`   Type: ${error.name}`);
    if (error.stack) {
        const relevantStack = error.stack.split('\n').slice(0, 5).join('\n');
        console.error(`   Stack:\n${relevantStack}`);
    }
};

const safeImport = async (modulePath) => {
    logImportAttempt(modulePath);
    try {
        const module = await import(modulePath);
        logImportSuccess(modulePath, module);
        return module;
    } catch (error) {
        logImportError(modulePath, error);
        throw error;
    }
};

try {
    console.log('🚀 app.js starting...');
    console.log(`   Node version: ${process.version}`);
    console.log(`   Platform: ${process.platform}`);
    console.log(`   CWD: ${process.cwd()}`);

    const { config, connectDatabase } = await safeImport('./config/index.js');
    const { default: logger } = await safeImport('./utils/logger.js');
    const { default: TelegramBot } = await safeImport('./bot/index.js');
    const { startServer } = await safeImport('./api/index.js');
    const { default: CronJobs } = await safeImport('./cron/index.js');

    let bot = null;
    let isShuttingDown = false;

    const gracefulShutdown = (signal) => {
        if (isShuttingDown) {
            console.log('⚡ Forced exit (already shutting down)...');
            process.exit(1);
        }
        isShuttingDown = true;
        console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
        if (bot && typeof bot.stop === 'function') {
            try {
                bot.stop(signal);
                console.log('   Bot stopped');
            } catch (e) {
                console.error('   Error stopping bot:', e.message);
            }
        }
        setTimeout(() => {
            console.log('⏱️  Forcing exit after timeout');
            process.exit(0);
        }, 5000);
    };

    const startApp = async () => {
        const steps = [
            { name: 'Database', fn: () => connectDatabase() },
            { name: 'Bot instance', fn: () => { bot = new TelegramBot(); return Promise.resolve(); } },
            { name: 'Bot launch', fn: () => bot.launch() },
            { name: 'API server', fn: () => startServer(config?.server?.port || 3000) },
            { name: 'Cron jobs', fn: () => { const cron = new CronJobs(); cron.start(); return Promise.resolve(); } }
        ];

        try {
            console.log('🟢 Starting app initialization...');
            
            for (const step of steps) {
                console.log(`🔧 ${step.name}...`);
                try {
                    await step.fn();
                    console.log(`✅ ${step.name} completed`);
                } catch (stepError) {
                    console.error(`❌ ${step.name} FAILED:`, stepError.message);
                    console.error('   Stack:', stepError.stack?.split('\n').slice(0, 3).join('\n'));
                    throw new Error(`${step.name} failed: ${stepError.message}`);
                }
            }

            if (logger && typeof logger.info === 'function') {
                logger.info('Application started successfully');
            } else {
                console.warn('⚠️  Logger not available for final success log');
            }

            console.log('🎉 Application fully started and operational');

        } catch (error) {
            console.error('💥 startApp FAILED:', error.message);
            console.error('Full stack:', error.stack);
            if (logger && typeof logger.error === 'function') {
                logger.error('Failed to start application', { 
                    error: error.message, 
                    stack: error.stack 
                });
            }
            process.exit(1);
        }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('exit', (code) => {
        console.log(`👋 Process exiting with code ${code}`);
    });

    console.log('🟢 All imports successful, calling startApp()...');
    startApp();

} catch (err) {
    console.error('💥 IMPORT CRASH:', err.message);
    console.error('Error type:', err.name);
    console.error('Error code:', err.code || 'N/A');
    console.error('Stack trace:');
    console.error(err.stack);
    
    if (err.url) console.error('Module URL:', err.url);
    if (err instanceof SyntaxError) {
        console.error('\n🔍 SYNTAX ERROR DETECTED');
        console.error('This usually means:');
        console.error('  - Missing/extra braces, parentheses, or quotes');
        console.error('  - Invalid character (check for hidden unicode)');
        console.error('  - Using unsupported syntax for your Node version');
        console.error(`  - Current Node ${process.version} may not support certain features`);
    }
    
    process.exit(1);
    }
