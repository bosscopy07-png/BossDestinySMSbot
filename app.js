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
        result += '─'.repeat(70) + '\n';

        for (let i = start; i < end; i++) {
            const marker = i === lineNum - 1 ? '>>> ' : '    ';
            const lineStr = String(i + 1).padStart(4, ' ');

            result += `${marker}${lineStr} | ${lines[i]}\n`;
        }

        result += '─'.repeat(70);

        return result;

    } catch (e) {
        return `Could not read file: ${filePath} (${e.message})`;
    }
};

/**
 * Parse stack trace to find exact file locations
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
 * THE FIX: Find exactly where "Unexpected end of input" comes from
 * This scans backwards from EOF to find the unclosed brace/paren/bracket
 */
const findUnexpectedEOF = (filePath) => {
    try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        console.log(`\n🔍 SCANNING ${filePath} for "Unexpected end of input"...`);
        console.log(`   Total lines: ${lines.length}`);

        // Stack tracks: { char, line, col, type }
        const stack = [];
        const problems = [];

        let inString = false;
        let stringChar = null;
        let inTemplateExpr = false;
        let inRegex = false;
        let inLineComment = false;
        let inBlockComment = false;

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            const prev = content[i - 1];
            const next = content[i + 1];
            const lineNum = content.substring(0, i).split('\n').length;
            const colNum = i - content.lastIndexOf('\n', i - 1);

            // Block comments /* */
            if (!inString && !inRegex && char === '/' && next === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
            if (inBlockComment && char === '*' && next === '/') {
                inBlockComment = false;
                i++;
                continue;
            }
            if (inBlockComment) continue;

            // Line comments //
            if (!inString && !inRegex && char === '/' && next === '/') {
                inLineComment = true;
                continue;
            }
            if (inLineComment && char === '\n') {
                inLineComment = false;
                continue;
            }
            if (inLineComment) continue;

            // Regex literals
            if (!inString && !inRegex && char === '/' && prev !== '\\') {
                // Rough check for regex context
                const before = content.substring(Math.max(0, i - 20), i).trim();
                if (/[\=\(\[,!&|:;\?\+~\*\/]$/.test(before) || before === '' || before.endsWith('return')) {
                    inRegex = true;
                    continue;
                }
            }
            if (inRegex && char === '/' && prev !== '\\') {
                inRegex = false;
                while (/[gimuy]/.test(content[i + 1])) i++;
                continue;
            }
            if (inRegex) continue;

            // Strings and template literals
            if (!inString && (char === '"' || char === "'" || char === '`')) {
                inString = true;
                stringChar = char;
                continue;
            }
            if (inString && char === stringChar && prev !== '\\') {
                if (stringChar === '`') inTemplateExpr = false;
                inString = false;
                stringChar = null;
                continue;
            }
            if (inString && stringChar === '`' && char === '$' && next === '{') {
                inTemplateExpr = true;
                // Don't skip, let the { be processed below
            }
            if (inString && !inTemplateExpr) continue;

            // Track brackets with line numbers
            const opens = { '{': 'brace', '(': 'paren', '[': 'bracket' };
            const closes = { '}': 'brace', ')': 'paren', ']': 'bracket' };

            if (char in opens) {
                stack.push({
                    char,
                    type: opens[char],
                    line: lineNum,
                    col: colNum,
                    pos: i
                });
            } else if (char in closes) {
                const last = stack[stack.length - 1];
                if (last && last.type === closes[char]) {
                    stack.pop();
                } else {
                    problems.push({
                        type: 'MISMATCH',
                        expected: last ? last.char : 'nothing',
                        found: char,
                        line: lineNum,
                        col: colNum
                    });
                }
            }
        }

        // RESULTS
        console.log(`   Braces/Parens/Brackets still open at EOF: ${stack.length}`);

        if (stack.length === 0 && problems.length === 0) {
            console.log('   ✅ File syntax is balanced!');
            return null;
        }

        if (problems.length > 0) {
            console.log(`\n❌ MISMATCHED CLOSING TOKENS: ${problems.length}`);
            problems.forEach(p => {
                console.log(`   Line ${p.line}: found '${p.found}' but expected '${p.expected}'`);
            });
        }

        if (stack.length > 0) {
            console.log(`\n❌ UNCLOSED TOKENS AT EOF: ${stack.length}`);

            // The LAST unclosed token is usually the real problem
            const lastUnclosed = stack[stack.length - 1];

            console.log(`\n🎯 ROOT CAUSE: Unclosed '${lastUnclosed.char}' opened at line ${lastUnclosed.line}, col ${lastUnclosed.col}`);
            console.log(`   This means something was started but never finished before the file ended.`);
            console.log(`   The "export default" at the bottom is fine — the parser just never got there properly.\n`);

            // Show ALL unclosed tokens (most recent last = closest to EOF)
            console.log('   All unclosed tokens (newest = closest to EOF):');
            [...stack].reverse().forEach((item, idx) => {
                const isLast = idx === 0;
                console.log(`      ${isLast ? '>>>' : '   '} #${stack.length - idx}: '${item.char}' at line ${item.line} (${item.type})`);
            });

            // Show context around the LAST (most likely broken) one
            console.log(`\n📄 CODE WHERE THE PROBLEM STARTED (line ${lastUnclosed.line}):`);
            console.log('─'.repeat(70));

            const ctxStart = Math.max(0, lastUnclosed.line - 6);
            const ctxEnd = Math.min(lines.length, lastUnclosed.line + 5);

            for (let i = ctxStart; i < ctxEnd; i++) {
                const marker = (i === lastUnclosed.line - 1) ? '>>> ' : '    ';
                console.log(`${marker}${String(i + 1).padStart(4)} | ${lines[i] || ''}`);
            }
            console.log('─'.repeat(70));

            // Also show EOF context
            console.log(`\n📄 EOF CONTEXT (last 10 lines):`);
            console.log('─'.repeat(70));
            const eofStart = Math.max(0, lines.length - 10);
            for (let i = eofStart; i < lines.length; i++) {
                const marker = (i === lines.length - 1) ? 'EOF> ' : '     ';
                console.log(`${marker}${String(i + 1).padStart(4)} | ${lines[i] || ''}`);
            }
            console.log('─'.repeat(70));

            return lastUnclosed;
        }

        return null;

    } catch (e) {
        console.error(`   Could not analyze file: ${e.message}`);
        return null;
    }
};

/**
 * Verify file syntax balance
 */
const verifyFileComplete = (filePath) => {
    try {
        const content = readFileSync(filePath, 'utf-8');

        let braces = 0;
        let parens = 0;
        let brackets = 0;

        let inString = false;
        let stringChar = null;

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            const prev = content[i - 1];

            if (
                !inString &&
                (char === '"' || char === "'" || char === '`')
            ) {
                inString = true;
                stringChar = char;
                continue;
            }

            if (inString && char === stringChar && prev !== '\\') {
                inString = false;
                stringChar = null;
                continue;
            }

            if (inString) continue;

            if (char === '{') braces++;
            if (char === '}') braces--;
            if (char === '(') parens++;
            if (char === ')') parens--;
            if (char === '[') brackets++;
            if (char === ']') brackets--;
        }

        return {
            complete: braces === 0 && parens === 0 && brackets === 0,
            braceBalance: braces,
            parenBalance: parens,
            bracketBalance: brackets,
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
 * Verify only critical files
 */
const verifyCriticalFiles = () => {
    console.log('\n🔍 Verifying critical files...');

    const criticalFiles = [
        './bot/commands/otp.js',
        './bot/index.js'
    ];

    for (const file of criticalFiles) {
        try {
            const url = new URL(file, import.meta.url);
            const check = verifyFileComplete(url.pathname);
            const status = check.complete ? '✅' : '❌';

            console.log(
                `   ${status} ${file} ` +
                `(braces:${check.braceBalance}, ` +
                `parens:${check.parenBalance}, ` +
                `brackets:${check.bracketBalance}, ` +
                `chars:${check.totalChars})`
            );

            if (!check.complete) {
                console.log(`      ⚠️ Syntax imbalance detected — running deep scan...`);
                findUnexpectedEOF(url.pathname);
            }

        } catch (e) {
            console.log(`   ❌ ${file} (not found)`);
        }
    }
};

/**
 * Safe import
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
                        getLineContext(primary.filePath, primary.lineNum, 3)
                    );
                }
            }

            // THE KEY FIX: If "Unexpected end of input", run the deep scanner
            if (error.message.includes('Unexpected end of input')) {
                console.error('\n🚨 "Unexpected end of input" detected — scanning for unclosed tokens...');

                // Try to resolve the actual file path
                let targetFile = modulePath;
                try {
                    const resolved = new URL(modulePath, import.meta.url);
                    targetFile = resolved.pathname;
                } catch {
                    // keep original
                }

                findUnexpectedEOF(targetFile);
            }
        }

        throw error;
    }
};

/**
 * Deep import tracer
 */
const traceImportChain = async (modulePath, depth = 0, visited = new Set()) => {
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
            const primaryLoc = locations[0] || {
                filePath: modulePath,
                lineNum: 0,
                colNum: 0
            };

            console.error(
                `${indent}   Location: ${primaryLoc.filePath}:${primaryLoc.lineNum}:${primaryLoc.colNum}`
            );

            if (primaryLoc.lineNum > 0) {
                console.error(
                    getLineContext(primaryLoc.filePath, primaryLoc.lineNum, 3)
                );
            } else {
                // "Unexpected end of input" shows line 0 — run deep scanner
                let targetFile = modulePath;
                try {
                    targetFile = new URL(modulePath, import.meta.url).pathname;
                } catch {}

                console.error(`${indent}\n🚨 Running deep token analysis...`);
                findUnexpectedEOF(targetFile);
            }

            throw new Error(`SYNTAX ERROR in ${modulePath}: ${error.message}`);
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

    verifyCriticalFiles();

    const { config, connectDatabase } = await safeImport('./config/index.js');
    const { default: logger } = await safeImport('./utils/logger.js');

    console.log('\n📂 Starting deep import trace...');

    const importedBot = await traceImportChain('./bot/index.js');

    if (!importedBot?.default) {
        throw new Error('TelegramBot export missing from ./bot/index.js');
    }

    const TelegramBot = importedBot.default;

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
            
