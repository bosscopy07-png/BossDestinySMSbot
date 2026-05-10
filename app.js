import { pathToFileURL } from 'url';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

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
        const match = line.match(
            /(?:at\s+)?(?:\(?)(file:\/\/[^\s)]+|[^\s(]+\.js:\d+:\d+)(?:\)?)/
        );

        if (match) {
            const rawPath = match[1];

            let filePath = rawPath;
            let lineNum = 0;
            let colNum = 0;

            const posMatch = rawPath.match(/:(\d+):(\d+)$/);

            if (posMatch) {
                lineNum = parseInt(posMatch[1], 10);
                colNum = parseInt(posMatch[2], 10);
                filePath = rawPath.slice(0, -posMatch[0].length);
            }

            if (filePath.startsWith('file://')) {
                try {
                    filePath = new URL(filePath).pathname;
                } catch {}
            }

            locations.push({
                filePath,
                lineNum,
                colNum,
                raw: rawPath
            });
        }
    }

    return locations;
};

/**
 * Verify a file is complete (not truncated)
 */
const verifyFileComplete = (filePath) => {
    try {
        const content = readFileSync(filePath, 'utf-8');

        let braceCount = 0;
        let inString = false;
        let stringChar = null;

        for (let i = 0; i < content.length; i++) {
            const char = content[i];

            if (
                !inString &&
                (char === '"' || char === "'" || char === '`')
            ) {
                inString = true;
                stringChar = char;
                continue;
            }

            if (
                inString &&
                char === stringChar &&
                content[i - 1] !== '\\'
            ) {
                inString = false;
                stringChar = null;
                continue;
            }

            if (inString) continue;

            if (char === '{') braceCount++;
            if (char === '}') braceCount--;
        }

        return {
            complete: braceCount === 0,
            braceBalance: braceCount,
            totalChars: content.length
        };
    } catch (e) {
        return {
            complete: false,
            error: e.message
        };
    }
};

/**
 * FULL PROJECT SCANNER
 */
const scanProjectFiles = (dir) => {
    const files = readdirSync(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);

        try {
            const stat = statSync(fullPath);

            if (stat.isDirectory()) {
                if (
                    file === 'node_modules' ||
                    file === '.git' ||
                    file === 'dist' ||
                    file === 'build'
                ) {
                    continue;
                }

                scanProjectFiles(fullPath);

            } else if (
                file.endsWith('.js') ||
                file.endsWith('.mjs')
            ) {
                try {
                    const check = verifyFileComplete(fullPath);

                    const status = check.complete ? '✅' : '❌';

                    console.log(
                        `   ${status} ${fullPath} (balance: ${check.braceBalance}, chars: ${check.totalChars})`
                    );

                    if (!check.complete) {
                        console.log(
                            `      ⚠️ Brace imbalance: ${check.braceBalance}`
                        );
                    }

                } catch (err) {
                    console.log(`   ❌ ${fullPath}`);
                    console.log(`      ${err.message}`);
                }
            }

        } catch {}
    }
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
                    console.error(
                        getLineContext(
                            primary.filePath,
                            primary.lineNum,
                            2
                        )
                    );
                }
            }
        }

        throw error;
    }
};

/**
 * Deep import tracer
 */
const traceImportChain = async (
    modulePath,
    depth = 0,
    visited = new Set()
) => {

    const indent = '  '.repeat(depth);

    if (visited.has(modulePath)) {
        console.log(`${indent}♻️ Already visited: ${modulePath}`);
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

        if (error instanceof SyntaxError) {

            console.error(`\n${indent}🎯 SYNTAX ERROR FOUND`);
            console.error(`${indent}   File: ${modulePath}`);
            console.error(`${indent}   Message: ${error.message}`);

            const locations = parseStackTrace(error.stack);

            const primaryLoc =
                locations[0] || {
                    filePath: modulePath,
                    lineNum: 0,
                    colNum: 0
                };

            console.error(
                `${indent}   Location: ${primaryLoc.filePath}:${primaryLoc.lineNum}:${primaryLoc.colNum}`
            );

            if (primaryLoc.lineNum > 0) {
                console.error(
                    getLineContext(
                        primaryLoc.filePath,
                        primaryLoc.lineNum,
                        3
                    )
                );
            }

            throw new Error(
                `SYNTAX ERROR in ${modulePath}: ${error.message}`
            );
        }

        if (error.code === 'ERR_MODULE_NOT_FOUND') {

            console.error(`${indent}📦 MODULE NOT FOUND`);
            console.error(`${indent}   ${error.message}`);

            throw error;
        }

        console.error(`${indent}   Error: ${error.message}`);

        throw error;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

try {

    console.log('🚀 app.js starting...');
    console.log(`   Node: ${process.version}`);
    console.log(`   CWD: ${process.cwd()}`);

    // FULL PROJECT SCAN
    console.log('\n🔍 FULL PROJECT SCAN...');
    scanProjectFiles('./');

    // IMPORTS
    const { config, connectDatabase } =
        await safeImport('./config/index.js');

    const { default: logger } =
        await safeImport('./utils/logger.js');

    // DEEP TRACE
    console.log('\n📂 Starting deep import trace...');

    const importedBot =
        await traceImportChain('./bot/index.js');

    if (!importedBot?.default) {
        throw new Error(
            'TelegramBot export missing from ./bot/index.js'
        );
    }

    const TelegramBot = importedBot.default;

    const { startServer } =
        await safeImport('./api/index.js');

    const { default: CronJobs } =
        await safeImport('./cron/index.js');

    let bot = null;

    const port =
        config?.server?.port ||
        process.env.PORT ||
        3000;

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
            console.error(
                `  ${i + 1}. ${loc.filePath}:${loc.lineNum}:${loc.colNum}`
            );
        });
    }

    process.exit(1);
            }
