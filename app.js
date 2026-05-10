import { readFileSync } from 'fs';
import path from 'path';

/* ─────────────────────────────────────────────
   GLOBAL ERROR HANDLERS (SINGLE SOURCE)
───────────────────────────────────────────── */

process.on('uncaughtException', (err) => {
    console.error('\n💥 UNCAUGHT EXCEPTION');
    console.error(err.stack || err.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('\n💥 UNHANDLED REJECTION');
    console.error(reason?.stack || reason);
    process.exit(1);
});

/* ─────────────────────────────────────────────
   STACK PARSER (ROBUST)
───────────────────────────────────────────── */

const parseStackTrace = (stack = '') => {
    const locations = [];

    for (const line of stack.split('\n')) {
        const match = line.match(/(file:\/\/[^\s)]+|\/.*\.js:\d+:\d+)/);
        if (!match) continue;

        let raw = match[1];
        let lineNum = 0;
        let colNum = 0;

        const pos = raw.match(/:(\d+):(\d+)$/);

        if (pos) {
            lineNum = +pos[1];
            colNum = +pos[2];
            raw = raw.slice(0, -pos[0].length);
        }

        if (raw.startsWith('file://')) {
            raw = new URL(raw).pathname;
        }

        locations.push({ filePath: raw, lineNum, colNum });
    }

    return locations;
};

/* ─────────────────────────────────────────────
   CONTEXT DEBUGGER
───────────────────────────────────────────── */

const getLineContext = (filePath, lineNum, context = 3) => {
    try {
        const lines = readFileSync(filePath, 'utf8').split('\n');

        const start = Math.max(0, lineNum - context - 1);
        const end = Math.min(lines.length, lineNum + context);

        let out = `\n📄 FILE: ${filePath}\n`;
        out += '─'.repeat(70) + '\n';

        for (let i = start; i < end; i++) {
            out += `${i + 1 === lineNum ? '>>' : '  '} ${String(i + 1).padStart(4)} | ${lines[i]}\n`;
        }

        return out + '─'.repeat(70);
    } catch {
        return `Cannot read ${filePath}`;
    }
};

/* ─────────────────────────────────────────────
   FILE INTEGRITY CHECK (IMPROVED)
───────────────────────────────────────────── */

const verifyFileBalance = (content) => {
    let brace = 0;

    for (const c of content) {
        if (c === '{') brace++;
        if (c === '}') brace--;
    }

    return brace;
};

const findUnclosedTokens = (content) => {

    const stack = [];
    const issues = [];

    const openMap = { '{': '}', '(': ')', '[': ']' };
    const closeMap = { '}': '{', ')': '(', ']': '[' };

    for (let i = 0; i < content.length; i++) {
        const c = content[i];

        if (openMap[c]) {
            stack.push({ char: c, index: i });
        }

        if (closeMap[c]) {
            const last = stack[stack.length - 1];

            if (last && last.char === closeMap[c]) {
                stack.pop();
            } else {
                issues.push({ type: 'mismatch', char: c, index: i });
            }
        }
    }

    return { stack, issues };
};

/* ─────────────────────────────────────────────
   CRITICAL FILE CHECK (CLEAN OUTPUT)
───────────────────────────────────────────── */

const verifyCriticalFiles = () => {

    console.log('\n🔍 Checking critical files...\n');

    const files = [
        './bot/commands/otp.js',
        './bot/index.js'
    ];

    for (const file of files) {
        try {
            const full = new URL(file, import.meta.url).pathname;
            const content = readFileSync(full, 'utf8');

            const balance = verifyFileBalance(content);

            if (balance === 0) {
                console.log(`✅ ${file}`);
            } else {
                console.log(`❌ ${file} (brace imbalance: ${balance})`);

                const { stack, issues } = findUnclosedTokens(content);

                if (stack.length || issues.length) {
                    console.log('\n🧠 Detailed issues:');

                    for (const s of stack.slice(-5)) {
                        console.log(`UNOPENED ${s.char}`);
                    }

                    for (const i of issues.slice(-5)) {
                        console.log(`MISMATCH ${i.char}`);
                    }
                }
            }

        } catch {
            console.log(`❌ ${file} (missing)`);
        }
    }
};

/* ─────────────────────────────────────────────
   SAFE IMPORT (CLEAN + DEBUG READY)
───────────────────────────────────────────── */

const safeImport = async (p) => {
    try {
        console.log(`📦 ${p}`);
        const mod = await import(p);
        console.log(`✅ ${p}`);
        return mod;

    } catch (e) {
        console.error(`❌ ${p}`);
        console.error(e.message);

        if (e.stack) {
            const loc = parseStackTrace(e.stack)[0];
            if (loc) {
                console.error(getLineContext(loc.filePath, loc.lineNum));
            }
        }

        throw e;
    }
};

/* ─────────────────────────────────────────────
   IMPORT TRACE (DEBUG MODE)
───────────────────────────────────────────── */

const traceImportChain = async (p, visited = new Set()) => {

    if (visited.has(p)) return null;
    visited.add(p);

    console.log(`📂 ${p}`);

    try {
        const mod = await import(p);
        console.log(`✅ ${p}`);
        return mod;

    } catch (e) {
        console.log(`❌ ${p}`);

        if (e instanceof SyntaxError) {
            const loc = parseStackTrace(e.stack)[0];
            if (loc) {
                console.error(getLineContext(loc.filePath, loc.lineNum));
            }
        }

        throw e;
    }
};

/* ─────────────────────────────────────────────
   MAIN BOOTSTRAP
───────────────────────────────────────────── */

try {

    console.log('\n🚀 APP STARTING');
    console.log(process.version);

    verifyCriticalFiles();

    const { config, connectDatabase } =
        await safeImport('./config/index.js');

    await safeImport('./utils/logger.js');

    console.log('\n📂 tracing bot...');
    const botModule =
        await traceImportChain('./bot/index.js');

    if (!botModule?.default) {
        throw new Error('Bot export missing');
    }

    const Bot = botModule.default;

    const { startServer } =
        await safeImport('./api/index.js');

    const { default: Cron } =
        await safeImport('./cron/index.js');

    await connectDatabase();

    const bot = new Bot();
    await bot.launch();

    startServer(config?.server?.port || 3000);

    new Cron().start();

    console.log('\n🎉 SYSTEM ONLINE');

} catch (err) {
    console.error('\n💥 FATAL ERROR');
    console.error(err.stack || err.message);
    process.exit(1);
    }
