import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

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

/**
 * Extract line context from a file around a specific line number
 */
const getLineContext = (filePath, lineNum, context = 3) => {
    try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, lineNum - context - 1);
        const end = Math.min(lines.length, lineNum + context);
        
        let result = `\n📄 FILE: ${filePath}\n`;
        result += '─'.repeat(60) + '\n';
        
        for (let i = start; i < end; i++) {
            const marker = i === lineNum - 1 ? '>>> ' : '    ';
            const lineStr = String(i + 1).padStart(4, ' ');
            result += `${marker}${lineStr} | ${lines[i]}\n`;
        }
        
        result += '─'.repeat(60);
        return result;
    } catch (e) {
        return `Could not read file: ${filePath} (${e.message})`;
    }
};

/**
 * Parse stack trace to find the exact file, line, and column
 */
const parseStackTrace = (stack) => {
    const lines = stack.split('\n');
    const locations = [];
    
    for (const line of lines) {
        // Match: at ... (file:///path/to/file.js:123:45)
        // Or:    at file:///path/to/file.js:123:45
        // Or:    /path/to/file.js:123:45
        const match = line.match(/(?:at\s+)?(?:\(?)(file:\/\/[^\s)]+|[^\s(]+\.js:\d+:\d+)(?:\)?)/);
        if (match) {
            const rawPath = match[1];
            let filePath = rawPath;
            let lineNum = 0;
            let colNum = 0;
            
            // Extract line:column from end
            const posMatch = rawPath.match(/:(\d+):(\d+)$/);
            if (posMatch) {
                lineNum = parseInt(posMatch[1], 10);
                colNum = parseInt(posMatch[2], 10);
                filePath = rawPath.slice(0, -posMatch[0].length);
            }
            
            // Convert file:// URLs to paths
            if (filePath.startsWith('file://')) {
                try {
                    filePath = new URL(filePath).pathname;
                } catch (e) {
                    // Keep as-is
                }
            }
            
            locations.push({ filePath, lineNum, colNum, raw: rawPath });
        }
    }
    
    return locations;
};

/**
 * Safe import with detailed error reporting
 */
const safeImport = async (modulePath) => {
    console.log(`📦 Importing: ${modulePath}...`);
    try {
        const module = await import(modulePath);
        console.log(`✅ Imported: ${modulePath}`);
        return module;
    } catch (error) {
        console.error(`\n❌ FAILED to import: ${modulePath}`);
        console.error(`   Error Type: ${error.constructor.name}`);
        console.error(`   Message: ${error.message}`);
        
        if (error instanceof SyntaxError && error.stack) {
            console.error('\n🔍 SYNTAX ERROR DETECTED');
            const locations = parseStackTrace(error.stack);
            
            if (locations.length > 0) {
                const primary = locations[0];
                console.error(`\n🎯 PRIMARY LOCATION:`);
                console.error(`   File: ${primary.filePath}`);
                console.error(`   Line: ${primary.lineNum}`);
                console.error(`   Column: ${primary.colNum}`);
                
                if (primary.lineNum > 0) {
                    console.error(getLineContext(primary.filePath, primary.lineNum, 2));
                }
            }
            
            // Show all locations in chain
            if (locations.length > 1) {
                console.error('\n📍 FULL STACK LOCATIONS:');
                locations.forEach((loc, i) => {
                    console.error(`   ${i + 1}. ${loc.filePath}:${loc.lineNum}:${loc.colNum}`);
                });
            }
        }
        
        if (error.code === 'ERR_MODULE_NOT_FOUND') {
            console.error(`\n📦 MODULE NOT FOUND:`);
            console.error(`   ${error.message}`);
            // Try to extract the missing module
            const match = error.message.match(/Cannot find module '([^']+)'/);
            if (match) {
                console.error(`   Missing: ${match[1]}`);
            }
        }
        
        throw error;
    }
};

/**
 * DEEP TRACER: Recursively follows import chains to find the real culprit
 * Uses a manual approach to catch errors at each level
 */
const traceImportChain = async (modulePath, depth = 0, visited = new Set()) => {
    const indent = '  '.repeat(depth);
    
    // Prevent infinite loops
    if (visited.has(modulePath)) {
        console.log(`${indent}♻️  Already visited: ${modulePath}`);
        return null;
    }
    visited.add(modulePath);
    
    console.log(`${indent}📂 Tracing: ${modulePath}`);
    
    try {
        const module = await import(modulePath);
        console.log(`${indent}✅ OK: ${modulePath}`);
        return module;
    } catch (error) {
        console.error(`${indent}❌ BROKEN: ${modulePath}`);
        
        // SYNTAX ERROR: Show exact location with context
        if (error instanceof SyntaxError) {
            console.error(`\n${indent}🎯 SYNTAX ERROR FOUND at depth ${depth}:`);
            console.error(`${indent}   File: ${modulePath}`);
            console.error(`${indent}   Message: ${error.message}`);
            
            const locations = parseStackTrace(error.stack);
            
            // The first location is usually where the syntax error is
            // But for "Unexpected end of input", it might be the file itself
            const primaryLoc = locations.find(l => l.filePath.includes(modulePath.replace('./', ''))) 
                            || locations[0] 
                            || { filePath: modulePath, lineNum: 0, colNum: 0 };
            
            console.error(`${indent}   Location: ${primaryLoc.filePath}:${primaryLoc.lineNum}:${primaryLoc.colNum}`);
            
            if (primaryLoc.lineNum > 0) {
                console.error(getLineContext(primaryLoc.filePath, primaryLoc.lineNum, 3));
            } else if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
                // Try to read the file anyway to show the end
                try {
                    const resolvedPath = new URL(modulePath, import.meta.url).pathname;
                    const content = readFileSync(resolvedPath, 'utf-8');
                    const lines = content.split('\n');
                    console.error(`\n${indent}📄 FILE END (last 10 lines):`);
                    console.error('─'.repeat(60));
                    const start = Math.max(0, lines.length - 10);
                    for (let i = start; i < lines.length; i++) {
                        console.error(`${indent}   ${String(i + 1).padStart(4)} | ${lines[i]}`);
                    }
                    console.error('─'.repeat(60));
                    console.error(`${indent}⚠️  Total lines: ${lines.length}`);
                    console.error(`${indent}💡 HINT: File may be truncated — check for missing closing braces`);
                } catch (e) {
                    // Can't read file
                }
            }
            
            throw new Error(`SYNTAX ERROR in ${modulePath}: ${error.message}`);
        }
        
        // MODULE NOT FOUND: Show what's missing
        if (error.code === 'ERR_MODULE_NOT_FOUND') {
            console.error(`${indent}📦 MODULE NOT FOUND:`);
            console.error(`${indent}   ${error.message}`);
            
            // Try to find which import statement caused it
            try {
                const resolvedPath = new URL(modulePath, import.meta.url).pathname;
                const content = readFileSync(resolvedPath, 'utf-8');
                const importMatches = content.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g);
                console.error(`${indent}   Imports in ${modulePath}:`);
                for (const match of importMatches) {
                    console.error(`${indent}     → ${match[1]}`);
                }
            } catch (e) {
                // Can't read file
            }
            
            throw error;
        }
        
        // OTHER ERRORS: Try to trace deeper by reading the file's imports
        console.error(`${indent}   Error: ${error.message}`);
        console.error(`${indent}   Type: ${error.constructor.name}`);
        
        // For non-syntax errors in imports, try to find which sub-import failed
        if (error.stack) {
            const locations = parseStackTrace(error.stack);
            const relevantLoc = locations.find(l => !l.filePath.includes('node_modules'));
            if (relevantLoc) {
                console.error(`${indent}   Stack points to: ${relevantLoc.filePath}:${relevantLoc.lineNum}`);
            }
        }
        
        throw error;
    }
};

/**
 * Verify a file is complete (not truncated) by checking brace balance
 */
const verifyFileComplete = (filePath) => {
    try {
        const content = readFileSync(filePath, 'utf-8');
        let braceCount = 0;
        let inString = false;
        let stringChar = null;
        let inComment = false;
        let lineComment = false;
        
        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            const nextChar = content[i + 1];
            
            // Handle comments
            if (!inString && !inComment && char === '/' && nextChar === '*') {
                inComment = true;
                i++;
                continue;
            }
            if (inComment && char === '*' && nextChar === '/') {
                inComment = false;
                i++;
                continue;
            }
            if (!inString && !inComment && char === '/' && nextChar === '/') {
                lineComment = true;
                continue;
            }
            if (lineComment && char === '\n') {
                lineComment = false;
                continue;
            }
            if (inComment || lineComment) continue;
            
            // Handle strings
            if (!inString && (char === '"' || char === "'" || char === '`')) {
                inString = true;
                stringChar = char;
                continue;
            }
            if (inString && char === stringChar && content[i - 1] !== '\\') {
                inString = false;
                stringChar = null;
                continue;
            }
            if (inString) continue;
            
            // Count braces
            if (char === '{') braceCount++;
            if (char === '}') braceCount--;
        }
        
        return {
            complete: braceCount === 0,
            braceBalance: braceCount,
            totalChars: content.length,
            lastChar: content.slice(-1)
        };
    } catch (e) {
        return { complete: false, error: e.message };
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

try {
    console.log('🚀 app.js starting...');
    console.log(`   Node: ${process.version}`);
    console.log(`   CWD: ${process.cwd()}`);

    const { config, connectDatabase } = await safeImport('./config/index.js');
    const { default: logger } = await safeImport('./utils/logger.js');
    
    // Pre-verify critical files before importing
    console.log('\n🔍 Pre-verifying critical files...');
    const criticalFiles = [
        './bot/index.js',
        './bot/commands/otp.js`
        
    ];
    
    for (const file of criticalFiles) {
        try {
            const url = new URL(file, import.meta.url);
            const check = verifyFileComplete(url.pathname);
            const status = check.complete ? '✅' : '❌';
            console.log(`   ${status} ${file} (balance: ${check.braceBalance}, chars: ${check.totalChars})`);
            if (!check.complete && check.braceBalance !== undefined) {
                console.log(`      ⚠️  Brace imbalance: ${check.braceBalance} (positive = missing closing braces)`);
            }
        } catch (e) {
            console.log(`   ⚪ ${file} (not found)`);
        }
    }
    
    // Use deep tracer for the problematic import
    console.log('\n📂 Starting deep import trace...');
    const { default: TelegramBot } = await traceImportChain('./bot/index.js');
    
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
    if (err.stack) {
        console.error('\nStack:');
        const locations = parseStackTrace(err.stack);
        locations.forEach((loc, i) => {
            console.error(`  ${i + 1}. ${loc.filePath}:${loc.lineNum}:${loc.colNum}`);
        });
    }
    process.exit(1);
        }
                                           
