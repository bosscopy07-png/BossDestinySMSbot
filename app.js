process.on('uncaughtException', (err) => {
    console.error('💥 UNCAUGHT EXCEPTION:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION at:', promise);
    console.error('Reason:', reason);
    process.exit(1);
});

const safeImport = async (modulePath) => {
    console.log(`📦 Importing: ${modulePath}...`);
    try {
        const module = await import(modulePath);
        console.log(`✅ Imported: ${modulePath}`);
        return module;
    } catch (error) {
        console.error(`\n❌ FAILED to import: ${modulePath}`);
        console.error(`   Error: ${error.message}`);
        
        // SYNTAX ERROR: Show exact file and line
        if (error instanceof SyntaxError && error.stack) {
            const lines = error.stack.split('\n');
            console.error('\n🔍 SYNTAX ERROR LOCATION:');
            for (const line of lines) {
                if (line.includes('file://') || line.includes('.js:')) {
                    const match = line.match(/(file:\/\/[^\s]+|[^\s]+\.js:\d+:\d+)/);
                    if (match) {
                        console.error(`   📍 ${match[1]}`);
                    }
                }
            }
        }
        
        throw error;
    }
};

// DEEP TRACER: Follow the import chain to find the real culprit
const traceImportChain = async (modulePath, depth = 0) => {
    const indent = '  '.repeat(depth);
    console.log(`${indent}📂 Tracing: ${modulePath}`);
    
    try {
        const module = await import(modulePath);
        console.log(`${indent}✅ OK: ${modulePath}`);
        return module;
    } catch (error) {
        console.error(`${indent}❌ BROKEN: ${modulePath}`);
        
        // If it's a syntax error, we found it
        if (error instanceof SyntaxError) {
            console.error(`\n🎯 ROOT CAUSE FOUND at depth ${depth}:`);
            console.error(`   File: ${modulePath}`);
            console.error(`   Error: ${error.message}`);
            
            // Try to extract the exact line from stack
            const stackLines = error.stack.split('\n');
            for (const line of stackLines) {
                if (line.includes('.js:')) {
                    console.error(`   Stack: ${line.trim()}`);
                }
            }
            throw new Error(`SYNTAX ERROR in ${modulePath}: ${error.message}`);
        }
        
        // If it's a module not found, the missing file is the issue
        if (error.code === 'ERR_MODULE_NOT_FOUND') {
            console.error(`   Missing module: ${error.message}`);
            throw error;
        }
        
        // Otherwise, the error is in a dependency - trace deeper
        console.error(`${indent}   Error in dependency, tracing deeper...`);
        throw error;
    }
};

try {
    console.log('🚀 app.js starting...');
    console.log(`   Node: ${process.version}`);

    const { config, connectDatabase } = await safeImport('./config/index.js');
    const { default: logger } = await safeImport('./utils/logger.js');
    
    // USE DEEP TRACER for the problematic import
    const { default: TelegramBot } = await traceImportChain('./bot/index.js');
    
    const { startServer } = await safeImport('./api/index.js');
    const { default: CronJobs } = await safeImport('./cron/index.js');

    let bot = null;

    // ─── PORT CONFIGURATION ─────────────────────────────
    const port = config?.server?.port || process.env.PORT || 3000;

    const startApp = async () => {
        await connectDatabase();
        bot = new TelegramBot();
        await bot.launch();
        startServer(port);
        const cron = new CronJobs();
        cron.start();
        console.log(`🎉 App started on port ${port}`);
    };

    startApp();

} catch (err) {
    console.error('\n💥 FATAL ERROR:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
}


 
