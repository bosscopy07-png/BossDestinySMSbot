import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

process.on('uncaughtException', (err) => {
    console.error('\n💥 UNCAUGHT EXCEPTION');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(err.stack || err.message || err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('\n💥 UNHANDLED REJECTION');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(reason?.stack || reason);
    process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATHS
// ═══════════════════════════════════════════════════════════════════════════════

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const divider = () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
};

const exists = (target) => {
    try {
        fs.accessSync(target);
        return true;
    } catch {
        return false;
    }
};

const getLineContext = (filePath, lineNum, context = 3) => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        const start = Math.max(0, lineNum - context - 1);
        const end = Math.min(lines.length, lineNum + context);

        let output = `\n📄 ${filePath}\n`;
        output += '─'.repeat(70) + '\n';

        for (let i = start; i < end; i++) {
            const marker = i === lineNum - 1 ? '👉' : '  ';
            output += `${marker} ${(i + 1)
                .toString()
                .padStart(4)} | ${lines[i]}\n`;
        }

        output += '─'.repeat(70);

        return output;
    } catch (err) {
        return `Could not read file: ${err.message}`;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RECURSIVE FILE SCANNER
// ═══════════════════════════════════════════════════════════════════════════════

const getAllJsFiles = (dir, collected = []) => {
    if (!exists(dir)) return collected;

    const files = fs.readdirSync(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);

        try {
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (
                    file === 'node_modules' ||
                    file === '.git' ||
                    file === 'dist' ||
                    file === 'build'
                ) {
                    continue;
                }

                getAllJsFiles(fullPath, collected);
            } else if (
                file.endsWith('.js') ||
                file.endsWith('.mjs')
            ) {
                collected.push(fullPath);
            }
        } catch {}
    }

    return collected;
};

// ═══════════════════════════════════════════════════════════════════════════════
// BRACE VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════════

const verifyBraceBalance = (content) => {
    let braces = 0;
    let brackets = 0;
    let parens = 0;

    let inString = false;
    let stringChar = '';

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

        if (
            inString &&
            char === stringChar &&
            prev !== '\\'
        ) {
            inString = false;
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
        braces,
        brackets,
        parens,
        balanced:
            braces === 0 &&
            brackets === 0 &&
            parens === 0
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// RAW SYNTAX CHECKER
// ═══════════════════════════════════════════════════════════════════════════════

const scanFileSyntax = (filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');

        // Parse JS without executing imports
        new Function(content);

        const balance = verifyBraceBalance(content);

        return {
            ok: true,
            chars: content.length,
            balance
        };
    } catch (err) {
        return {
            ok: false,
            error: err,
            chars: 0
        };
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FULL PROJECT VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════════

const validateProject = () => {
    console.log('\n🔍 SCANNING ENTIRE PROJECT...');
    divider();

    const files = getAllJsFiles(__dirname);

    if (files.length === 0) {
        throw new Error('No JS files found');
    }

    console.log(`📦 Found ${files.length} JS files\n`);

    const brokenFiles = [];

    for (const file of files) {
        const result = scanFileSyntax(file);

        if (result.ok) {
            console.log(
                `✅ ${path.relative(__dirname, file)} (${result.chars} chars)`
            );
        } else {
            console.log(
                `❌ ${path.relative(__dirname, file)}`
            );

            console.log(`   ${result.error.message}`);

            const match = result.error.stack?.match(
                /<anonymous>:(\d+):(\d+)/
            );

            if (match) {
                const line = parseInt(match[1]);
                const column = parseInt(match[2]);

                console.log(`   Line: ${line}`);
                console.log(`   Column: ${column}`);

                console.log(getLineContext(file, line));
            }

            brokenFiles.push(file);
        }
    }

    divider();

    if (brokenFiles.length > 0) {
        console.error(
            `\n💥 FOUND ${brokenFiles.length} BROKEN FILE(S)`
        );

        brokenFiles.forEach((file) => {
            console.error(`   ❌ ${file}`);
        });

        process.exit(1);
    }

    console.log('\n✅ ALL FILES PASSED VALIDATION');
};

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE IMPORT
// ═══════════════════════════════════════════════════════════════════════════════

const safeImport = async (modulePath) => {
    try {
        console.log(`\n📦 Importing ${modulePath}`);

        const absolute = path.resolve(__dirname, modulePath);

        if (!exists(absolute)) {
            throw new Error(`Module file not found: ${absolute}`);
        }

        const moduleUrl = pathToFileURL(absolute).href;

        const imported = await import(moduleUrl);

        console.log(`✅ Imported ${modulePath}`);

        return imported;
    } catch (err) {
        console.error(`\n❌ FAILED IMPORT: ${modulePath}`);
        console.error(err.stack || err);

        throw err;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// APP BOOT
// ═══════════════════════════════════════════════════════════════════════════════

const boot = async () => {
    console.log('\n🚀 APPLICATION STARTING');
    divider();

    console.log(`🟢 Node Version: ${process.version}`);
    console.log(`📂 Root: ${__dirname}`);

    // STEP 1 — Validate ENTIRE project
    validateProject();

    divider();

    console.log('\n🚀 STARTING IMPORT CHAIN');

    // STEP 2 — Imports
    const { config, connectDatabase } =
        await safeImport('./config/index.js');

    const { default: logger } =
        await safeImport('./utils/logger.js');

    const { default: TelegramBot } =
        await safeImport('./bot/index.js');

    const { startServer } =
        await safeImport('./api/index.js');

    const { default: CronJobs } =
        await safeImport('./cron/index.js');

    divider();

    console.log('\n🚀 STARTING SERVICES');

    await connectDatabase();

    const bot = new TelegramBot();

    await bot.launch();

    const port =
        config?.server?.port ||
        process.env.PORT ||
        3000;

    startServer(port);

    const cron = new CronJobs();

    cron.start();

    divider();

    console.log(`\n🎉 APPLICATION RUNNING ON PORT ${port}`);
};

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

boot().catch((err) => {
    console.error('\n💥 FATAL STARTUP ERROR');
    divider();
    console.error(err.stack || err);
    process.exit(1);
});
