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
//  MAIN STARTUP
// ═══════════════════════════════════════════════════════════════════════

async function main() {
    try {
        // 1. Load config and connect database (always needed)
        console.log('\n📦 Loading configuration...');
        const configModule = await import('./config/index.js');
        const config = configModule.config || configModule.default?.config || configModule.default;
        const connectDatabase = configModule.connectDatabase || configModule.default?.connectDatabase;
        
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

// ═══════════════════════════════════════════════════════════════════════
//  SERVICE STARTERS
// ═══════════════════════════════════════════════════════════════════════

async function startBot() {
    console.log('\n🤖 Initializing Bot...');
    
    const { default: TelegramBot } = await import('./bot/index.js');
    const bot = new TelegramBot();
    
    global.telegramBot = bot;
    
    await bot.launch();
    console.log('✅ Bot started');
    
    process.once('SIGINT', () => bot.gracefulShutdown('SIGINT'));
    process.once('SIGTERM', () => bot.gracefulShutdown('SIGTERM'));
    
    return bot;
}

async function startServer() {
    console.log('\n🌐 Initializing Web Server...');
    
    const apiModule = await import('./api/index.js');
    const createServer = apiModule.default || apiModule.createServer;
    
    if (typeof createServer !== 'function') {
        throw new Error('api/index.js must export a default function or named export "createServer"');
    }
    
    const app = createServer();
    
    const PORT = process.env.PORT || 3000;
    const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
    
    const server = app.listen(PORT, () => {
        console.log(`✅ Server listening on port ${PORT}`);
        console.log(`   Health: ${BASE_URL}/health`);
        console.log(`   Webhooks: ${BASE_URL}/webhooks`);
    });
    
    process.once('SIGINT', () => server.close());
    process.once('SIGTERM', () => server.close());
    
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

main();
