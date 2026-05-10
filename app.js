// ═══════════════════════════════════════════════════════════════════════════════
// app.js — Entry Point with Deep Error Tracing for Tier Integration
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
//  DEEP IMPORT TRACER — Pinpoints exact file causing SyntaxError
// ═══════════════════════════════════════════════════════════════════════

const safeImport = async (modulePath) => {
    console.log(`📦 Importing: ${modulePath}...`);
    try {
        const module = await import(modulePath);
        console.log(`✅ Imported: ${modulePath}`);
        return module;
    } catch (error) {
        console.error(`\n❌ FAILED to import: ${modulePath}`);
        console.error(`   Error: ${error.message}`);
        
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

// ═══════════════════════════════════════════════════════════════════════
//  TIER-SPECIFIC DEEP TRACER — Traces into sub-imports of tier files
// ═══════════════════════════════════════════════════════════════════════

const traceTierImport = async (modulePath, depth = 0) => {
    const indent = '  '.repeat(depth);
    console.log(`${indent}📂 Tracing: ${modulePath}`);
    
    try {
        const module = await import(modulePath);
        console.log(`${indent}✅ OK: ${modulePath}`);
        return module;
    } catch (error) {
        console.error(`${indent}❌ BROKEN: ${modulePath}`);
        
        if (error instanceof SyntaxError) {
            console.error(`\n🎯 SYNTAX ERROR FOUND at depth ${depth}:`);
            console.error(`   File: ${modulePath}`);
            console.error(`   Message: ${error.message}`);
            
            // Deep scan: read file and find corrupted chars / brace mismatches
            try {
                const fs = await import('fs');
                const path = await import('path');
                const { fileURLToPath } = await import('url');
                
                let fullPath = modulePath;
                if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
                    fullPath = path.resolve(process.cwd(), modulePath);
                }
                
                if (fs.existsSync(fullPath)) {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const lines = content.split('\n');
                    
                    console.error(`\n🔍 SCANNING ${fullPath} for "Unexpected end of input"...`);
                    
                    // Check brace balance per line
                    let braceDepth = 0;
                    let parenDepth = 0;
                    let bracketDepth = 0;
                    let maxLine = 0;
                    
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        for (const char of line) {
                            if (char === '{') braceDepth++;
                            if (char === '}') braceDepth--;
                            if (char === '(') parenDepth++;
                            if (char === ')') parenDepth--;
                            if (char === '[') bracketDepth++;
                            if (char === ']') bracketDepth--;
                        }
                        if (braceDepth < 0 || parenDepth < 0 || bracketDepth < 0) {
                            console.error(`   ❌ MISMATCH at line ${i + 1}: negative depth`);
                            console.error(`      ${line.slice(0, 80)}`);
                        }
                        maxLine = i + 1;
                    }
                    
                    console.error(`   Total lines: ${maxLine}`);
                    console.error(`   Braces/Parens/Brackets still open at EOF: ${braceDepth > 0 ? braceDepth : 0}/${parenDepth > 0 ? parenDepth : 0}/${bracketDepth > 0 ? bracketDepth : 0}`);
                    
                    if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0) {
                        console.error(`   ❌ MISMATCHED CLOSING TOKENS: ${braceDepth + parenDepth + bracketDepth}`);
                        // Find last closing brace that doesn't match
                        for (let i = lines.length - 1; i >= 0; i--) {
                            const line = lines[i];
                            if (line.includes('}') && braceDepth > 0) {
                                console.error(`   Line ${i + 1}: found '}' but expected '{'`);
                                break;
                            }
                        }
                    }
                    
                    // Check for corrupted characters
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        for (let j = 0; j < line.length; j++) {
                            const cp = line.codePointAt(j);
                            const bad = [0x2018, 0x2019, 0x201B, 0x201C, 0x201D, 0x200B, 0x200C, 0x200D, 0xFEFF];
                            if (bad.includes(cp)) {
                                console.error(`   💥 CORRUPTED CHAR at line ${i + 1}, col ${j + 1}: U+${cp.toString(16).toUpperCase()}`);
                                console.error(`      Context: ${line.slice(Math.max(0, j - 5), j + 6)}`);
                            }
                        }
                    }
                }
            } catch (scanErr) {
                console.error(`   (Deep scan failed: ${scanErr.message})`);
            }
            
            throw new Error(`SYNTAX ERROR in ${modulePath}: ${error.message}`);
        }
        
        if (error.code === 'ERR_MODULE_NOT_FOUND') {
            console.error(`   Missing module: ${error.message}`);
            throw error;
        }
        
        throw error;
    }
};

// ═══════════════════════════════════════════════════════════════════════
//  MAIN STARTUP — Tier Integration Focused
// ═══════════════════════════════════════════════════════════════════════

try {
    console.log('🚀 app.js starting...');
    console.log(`   Node: ${process.version}`);

    const { config, connectDatabase } = await safeImport('./config/index.js');
    const { default: logger } = await safeImport('./utils/logger.js');
    
    // ═══════════════════════════════════════════════════════════════════════
    //  TIER INTEGRATION IMPORTS — Deep trace these specifically
    // ═══════════════════════════════════════════════════════════════════════
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  TIER INTEGRATION IMPORTS — Deep Tracing');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    // Trace each tier-related import individually
    let TierIntegrationService;
    let TierFlowMiddleware;
    let TelegramBot;
    
    try {
        console.log('1️⃣  TierIntegrationService...');
        const tierMod = await traceTierImport('./services/TierIntegrationService.js', 0);
        TierIntegrationService = tierMod.default || tierMod.TierIntegrationService || tierMod;
        console.log('   ✅ TierIntegrationService loaded\n');
    } catch (tierErr) {
        console.error('\n💥 TIER INTEGRATION SERVICE FAILED');
        console.error('   This is the new file you added — check for:');
        console.error('   - Missing closing braces }');
        console.error('   - Smart quotes instead of straight quotes');
        console.error('   - Missing imports (Markup, logger, etc.)');
        throw tierErr;
    }
    
    try {
        console.log('2️⃣  TierFlowMiddleware...');
        const flowMod = await traceTierImport('./bot/middleware/TierFlowMiddleware.js', 0);
        TierFlowMiddleware = flowMod.default || flowMod.TierFlowMiddleware || flowMod;
        console.log('   ✅ TierFlowMiddleware loaded\n');
    } catch (flowErr) {
        console.error('\n💥 TIER FLOW MIDDLEWARE FAILED');
        console.error('   This is the new file you added — check for:');
        console.error('   - Missing closing braces }');
        console.error('   - Smart quotes in template literals');
        console.error('   - Missing imports');
        throw flowErr;
    }
    
    // Now trace the main bot file (which imports the above)
    try {
        console.log('3️⃣  TelegramBot (bot/index.js)...');
        const botMod = await traceTierImport('./bot/index.js', 0);
        TelegramBot = botMod.default || botMod.TelegramBot || botMod;
        console.log('   ✅ TelegramBot loaded\n');
    } catch (botErr) {
        console.error('\n💥 TELEGRAM BOT FAILED');
        console.error('   The bot file imports TierIntegrationService and TierFlowMiddleware');
        console.error('   If they have syntax errors, this import fails');
        throw botErr;
    }
    
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ALL TIER IMPORTS SUCCESSFUL');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const { startServer } = await safeImport('./api/index.js');
    const { default: CronJobs } = await safeImport('./cron/index.js');

    let bot = null;
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
            
