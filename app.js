// ═══════════════════════════════════════════════════════════════════════════════
// app.js — Unified Entry Point (Bot + Web Server)
// Mode: bot | server | both (set via APP_MODE env var)
// ═══════════════════════════════════════════════════════════════════════════════

process.on('uncaughtException', (err) => {
    console.error('💥 UNCAUGHT EXCEPTION:', err.message);
    console.error(err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION at:', promise);
    console.error('Reason:', reason);
    process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════════
//  MODE DETECTION
// ═══════════════════════════════════════════════════════════════════════

const MODE = process.env.APP_MODE || 'bot';

const VALID_MODES = ['bot', 'server', 'both'];
if (!VALID_MODES.includes(MODE)) {
    console.error(`❌ Invalid APP_MODE: "${MODE}"`);
    console.error(`   Valid modes: ${VALID_MODES.join(' | ')}`);
    process.exit(1);
}

console.log(`🚀 Starting in mode: ${MODE.toUpperCase()}`);
console.log(`   Node: ${process.version}`);
console.log(`   Platform: ${process.platform}`);

// ═══════════════════════════════════════════════════════════════════════
//  DYNAMIC IMPORTS BASED ON MODE
// ═══════════════════════════════════════════════════════════════════════

async function startBot() {
    console.log('\n🤖 Initializing Bot...');
    
    const { default: TelegramBot } = await import('./bot/index.js');
    const bot = new TelegramBot();
    
    // Make available globally for webhook notifications
    global.telegramBot = bot;
    
    await bot.launch();
    console.log('✅ Bot started (polling mode)');
    
    // Graceful shutdown
    const stopBot = () => {
        console.log('\n🛑 Stopping bot...');
        bot.stop();
    };
    process.once('SIGINT', stopBot);
    process.once('SIGTERM', stopBot);
    
    return bot;
}

async function startServer() {
    console.log('\n🌐 Initializing Web Server...');
    
    const { default: createServer } = await import('./api/index.js');
    const app = createServer();
    
    const PORT = process.env.PORT || 3000;
    const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
    
    const server = app.listen(PORT, () => {
        console.log(`✅ Server listening on port ${PORT}`);
        console.log(`   Health: ${BASE_URL}/health`);
        console.log(`   Webhooks: ${BASE_URL}/webhooks`);
    });
    
    // Graceful shutdown
    const stopServer = () => {
        console.log('\n🛑 Stopping server...');
        server.close();
    };
    process.once('SIGINT', stopServer);
    process.once('SIGTERM', stopServer);
    
    return server;
}

async function startCron() {
    console.log('\n⏰ Initializing Cron Jobs...');
    
    const { default: CronJobs } = await import('./cron/index.js');
    const cron = new CronJobs();
    cron.start();
    console.log('✅ Cron jobs started');
    
    return cron;
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN STARTUP
// ═══════════════════════════════════════════════════════════════════════

async function main() {
    try {
        // 1. Load config and connect database (always needed)
        console.log('\n📦 Loading configuration...');
        const { config, connectDatabase } = await import('./config/index.js');
        const { default: logger } = await import('./utils/logger.js');
        
        await connectDatabase();
        console.log('✅ Database connected');
        
        // 2. Start services based on mode
        const services = [];
        
        if (MODE === 'bot' || MODE === 'both') {
            services.push(startBot());
        }
        
        if (MODE === 'server' || MODE === 'both') {
            services.push(startServer());
        }
        
        if (MODE === 'both') {
            services.push(startCron());
        }
        
        await Promise.all(services);
        
        console.log('\n🎉 All services started successfully');
        console.log(`   Mode: ${MODE}`);
        console.log(`   Time: ${new Date().toISOString()}`);
        
    } catch (error) {
        console.error('\n💥 FATAL STARTUP ERROR:');
        console.error(`   ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
