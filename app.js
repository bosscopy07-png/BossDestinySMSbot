// ═══════════════════════════════════════════════════════════════════════════════
// app.js — Unified Entry Point (Bot + Web Server)
// Mode: bot | server | both (set via APP_MODE env var)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
//  GLOBAL ERROR HANDLING (must be first)
// ═══════════════════════════════════════════════════════════════════════

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
    console.log('✅ Bot started');
    
    return bot;
}

async function startServer() {
    console.log('\n🌐 Initializing Web Server...');
    
    const { startServer } = await import('./api/index.js');
    const server = await startServer();
    
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
//  GRACEFUL SHUTDOWN (centralized)
// ═══════════════════════════════════════════════════════════════════════

let shutdownInProgress = false;
const activeServices = new Map();

async function shutdown(signal) {
    if (shutdownInProgress) {
        console.log('\n⚠️  Shutdown already in progress...');
        return;
    }
    shutdownInProgress = true;
    
    console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
    
    const timeouts = [];
    
    // Stop bot
    if (activeServices.has('bot')) {
        const bot = activeServices.get('bot');
        timeouts.push(
            Promise.race([
                bot.stop(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Bot stop timeout')), 5000)
                )
            ]).catch(err => console.error('Bot stop error:', err.message))
        );
    }
    
    // Stop server
    if (activeServices.has('server')) {
        const server = activeServices.get('server');
        timeouts.push(
            new Promise((resolve) => {
                server.close(resolve);
                setTimeout(resolve, 5000); // Force resolve after 5s
            })
        );
    }
    
    // Stop cron
    if (activeServices.has('cron')) {
        const cron = activeServices.get('cron');
        if (typeof cron.stop === 'function') {
            cron.stop();
        }
    }
    
    await Promise.all(timeouts);
    console.log('✅ All services stopped');
    process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ═══════════════════════════════════════════════════════════════════════
//  MAIN STARTUP
// ═══════════════════════════════════════════════════════════════════════

async function main() {
    try {
        // 1. Load config and connect database (always needed)
        console.log('\n📦 Loading configuration...');
        const { connectDatabase } = await import('./config/index.js');
        
        await connectDatabase();
        console.log('✅ Database connected');
        
        // 2. Start services based on mode
        if (MODE === 'bot' || MODE === 'both') {
            const bot = await startBot();
            activeServices.set('bot', bot);
        }
        
        if (MODE === 'server' || MODE === 'both') {
            const server = await startServer();
            activeServices.set('server', server);
        }
        
        if (MODE === 'both') {
            const cron = await startCron();
            activeServices.set('cron', cron);
        }
        
        console.log('\n🎉 All services started successfully');
        console.log(`   Mode: ${MODE}`);
        console.log(`   Time: ${new Date().toISOString()}`);
        
    } catch (error) {
        console.error('\n💥 FATAL STARTUP ERROR:');
        console.error(`   ${error.message}`);
        if (config.server.env !== 'production') {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

main();
