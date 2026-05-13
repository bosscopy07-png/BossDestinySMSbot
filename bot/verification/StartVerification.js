// ═══════════════════════════════════════════════════════════
//  bot/verification/StartVerification.js
//  Mandatory CAPTCHA + Channel Join Verification
// ═══════════════════════════════════════════════════════════

import logger from '../../utils/logger.js';

const MANDATORY_CHANNELS = [
    { id: '@Swiftsmscommunity', name: 'SwiftSMS Community', url: 'https://t.me/Swiftsmscommunity' },
    { id: '@swiftsmstech', name: 'SwiftSMS Tech', url: 'https://t.me/swiftsmstech' }
];

const WELCOME_IMAGE_URL = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const CAPTCHA_MAX_ATTEMPTS = 3;
const CAPTCHA_BLOCK_DURATION_MS = 10 * 60 * 1000;

class StartVerification {
    constructor(bot, userCommands, isAdminFn, alertAdminsFn) {
        if (!bot || !userCommands || typeof isAdminFn !== 'function' || typeof alertAdminsFn !== 'function') {
            throw new Error('StartVerification requires: bot, userCommands, isAdminFn, alertAdminsFn');
        }

        this.bot = bot;
        this.userCommands = userCommands;
        this.isAdmin = isAdminFn;
        this.alertAdmins = alertAdminsFn;

        this._registerCallbacks();
    }

    /**
     * Resolves the effective user ID from a context.
     * Handles anonymous channel/group posts where ctx.from is the sender_chat.
     */
    _getEffectiveUserId(ctx) {
        if (ctx.senderChat?.id) {
            return ctx.senderChat.id;
        }
        return ctx.from?.id;
    }

    // ═══════════════════════════════════════════════════════
    //  PUBLIC API: Main entry point for /start
    // ═══════════════════════════════════════════════════════

    async handleStart(ctx) {
        const userId = this._getEffectiveUserId(ctx);

        if (!userId) {
            logger.warn('[StartVerification] Missing userId in /start');
            return ctx.reply('❌ Unable to identify user. Please try again.').catch(() => {});
        }

        // ─── Admin bypass (supports anonymous posts) ───
        if (this.isAdmin(userId)) {
            logger.debug('[StartVerification] Admin bypass', { userId });
            ctx.session.joinVerified = true;
            ctx.session.joinVerifiedAt = Date.now();
            return await this._runUserStart(ctx);
        }

        // ─── Check if user is blocked from CAPTCHA failures ───
        if (ctx.session?.captchaBlockedUntil && Date.now() < ctx.session.captchaBlockedUntil) {
            const remaining = Math.ceil((ctx.session.captchaBlockedUntil - Date.now()) / 60000);
            return ctx.reply(
                `⛔ <b>Too many failed attempts.</b>\n\n` +
                `Please try again in <code>${remaining}</code> minute(s).`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }

        // ─── Check if verification is still fresh ───
        const isFresh = ctx.session?.joinVerified === true &&
                        ctx.session?.joinVerifiedAt &&
                        (Date.now() - ctx.session.joinVerifiedAt < VERIFICATION_TTL_MS);

        if (isFresh) {
            logger.debug('[StartVerification] Using fresh verification', { userId });
            return await this._runUserStart(ctx);
        }

        // ─── CAPTCHA not passed yet ───
        if (ctx.session?.captchaPassed !== true) {
            return await this._sendCaptchaChallenge(ctx);
        }

        // ─── CAPTCHA passed, now check channel membership ───
        logger.debug('[StartVerification] CAPTCHA passed, checking membership', { userId });

        let membership;
        try {
            membership = await this._checkMembership(userId);
        } catch (checkErr) {
            logger.error('[StartVerification] Membership check failed', {
                userId,
                error: checkErr.message
            });
            await this.alertAdmins(checkErr, {
                userId,
                updateType: 'message',
                command: '/start',
                note: 'Membership API failure — user shown join requirement as fail-safe'
            });
            ctx.session.joinVerified = false;
            delete ctx.session.joinVerifiedAt;
            return await this._sendJoinRequirement(ctx);
        }

        if (membership.allJoined) {
            logger.info('[StartVerification] User verified', { userId, channels: membership.memberships });
            ctx.session.joinVerified = true;
            ctx.session.joinVerifiedAt = Date.now();
            return await this._runUserStart(ctx);
        }

        logger.info('[StartVerification] User not joined', {
            userId,
            missing: membership.memberships.filter(m => !m.joined).map(m => m.channel)
        });
        ctx.session.joinVerified = false;
        delete ctx.session.joinVerifiedAt;
        return await this._sendJoinRequirement(ctx);
    }

    // ═══════════════════════════════════════════════════════
    //  CAPTCHA: Generate and send math challenge
    // ═══════════════════════════════════════════════════════

    async _sendCaptchaChallenge(ctx) {
        const challenge = this._generateMathChallenge();
        ctx.session.captchaAnswer = challenge.answer;
        ctx.session.captchaAttempts = ctx.session.captchaAttempts || 0;

        const message =
            '🤖 <b>Human Verification</b>\n\n' +
            'Solve this to continue:\n\n' +
            `<code>${challenge.question}</code>\n\n` +
            `<i>Attempt ${ctx.session.captchaAttempts + 1}/${CAPTCHA_MAX_ATTEMPTS}</i>`;

        // Shuffle options so correct answer isn't always in same position
        const options = this._shuffleArray([...challenge.options]);

        const keyboard = {
            inline_keyboard: options.map(opt => ([
                { text: String(opt), callback_data: `captcha_${opt}` }
            ]))
        };

        try {
            await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (err) {
            logger.error('[StartVerification] Failed to send CAPTCHA', { error: err.message });
            await this.alertAdmins(err, {
                userId: ctx.from?.id,
                updateType: 'message',
                command: '/start',
                note: 'CAPTCHA send failed'
            });
            ctx.reply('❌ Error starting verification. Please try /start again.').catch(() => {});
        }
    }

    _generateMathChallenge() {
        const ops = ['+', '-', '*'];
        const op = ops[Math.floor(Math.random() * ops.length)];
        let a, b, answer;

        switch (op) {
            case '+':
                a = Math.floor(Math.random() * 20) + 1;
                b = Math.floor(Math.random() * 20) + 1;
                answer = a + b;
                break;
            case '-':
                a = Math.floor(Math.random() * 20) + 10;
                b = Math.floor(Math.random() * 10) + 1;
                answer = a - b;
                break;
            case '*':
                a = Math.floor(Math.random() * 9) + 2;
                b = Math.floor(Math.random() * 9) + 2;
                answer = a * b;
                break;
        }

        const question = `${a} ${op} ${b} = ?`;

        // Generate 3 wrong answers close to correct
        const options = new Set([answer]);
        while (options.size < 4) {
            const offset = Math.floor(Math.random() * 10) - 5;
            const wrong = answer + offset;
            if (wrong !== answer && wrong >= 0) {
                options.add(wrong);
            }
        }

        return { question, answer, options: Array.from(options) };
    }

    _shuffleArray(array) {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ═══════════════════════════════════════════════════════
    //  CAPTCHA: Handle answer callback
    // ═══════════════════════════════════════════════════════

    async handleCaptchaAnswer(ctx) {
        const userId = this._getEffectiveUserId(ctx);
        if (!userId) return;

        try {
            await ctx.answerCbQuery().catch(() => {});

            const selectedAnswer = parseInt(ctx.callbackQuery.data.replace('captcha_', ''), 10);
            const correctAnswer = ctx.session?.captchaAnswer;

            if (isNaN(selectedAnswer) || correctAnswer === undefined) {
                return ctx.reply('❌ Session expired. Please tap /start again.').catch(() => {});
            }

            // Check if blocked
            if (ctx.session?.captchaBlockedUntil && Date.now() < ctx.session.captchaBlockedUntil) {
                const remaining = Math.ceil((ctx.session.captchaBlockedUntil - Date.now()) / 60000);
                return ctx.answerCbQuery(`⛔ Blocked for ${remaining}m`, { show_alert: true });
            }

            if (selectedAnswer === correctAnswer) {
                // Correct!
                logger.info('[StartVerification] CAPTCHA passed', { userId });
                ctx.session.captchaPassed = true;
                ctx.session.captchaAttempts = 0;
                delete ctx.session.captchaAnswer;

                await ctx.deleteMessage().catch(() => {});
                await ctx.reply('✅ <b>Verified!</b> Now let\'s check your channel membership...', { parse_mode: 'HTML' });

                // Continue to membership check
                return await this.handleStart(ctx);
            }

            // Wrong answer
            ctx.session.captchaAttempts = (ctx.session.captchaAttempts || 0) + 1;
            const remainingAttempts = CAPTCHA_MAX_ATTEMPTS - ctx.session.captchaAttempts;

            if (remainingAttempts <= 0) {
                // Block user
                ctx.session.captchaBlockedUntil = Date.now() + CAPTCHA_BLOCK_DURATION_MS;
                delete ctx.session.captchaAnswer;
                delete ctx.session.captchaPassed;

                logger.warn('[StartVerification] CAPTCHA max attempts exceeded', { userId });
                await ctx.deleteMessage().catch(() => {});
                return ctx.reply(
                    '⛔ <b>Too many failed attempts.</b>\n\n' +
                    'You are blocked for <code>10 minutes</code>.\n\n' +
                    'Please try /start again later.',
                    { parse_mode: 'HTML' }
                );
            }

            // Show new challenge
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(
                `❌ <b>Wrong answer.</b>\n\n` +
                `<i>${remainingAttempts} attempt(s) remaining.</i>`,
                { parse_mode: 'HTML' }
            );
            return await this._sendCaptchaChallenge(ctx);

        } catch (error) {
            logger.error('[StartVerification] CAPTCHA callback error', { error: error.message, userId });
            await this.alertAdmins(error, {
                userId,
                updateType: 'callback_query',
                command: 'captcha_answer',
                note: 'CAPTCHA callback crash'
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  CALLBACK: "I've Joined" button
    // ═══════════════════════════════════════════════════════

    async handleVerifyCallback(ctx) {
        const userId = this._getEffectiveUserId(ctx);
        if (!userId) return;

        try {
            await ctx.answerCbQuery('⏳ Checking your membership...').catch(() => {});

            let membership;
            try {
                membership = await this._checkMembership(userId);
            } catch (checkErr) {
                logger.error('[StartVerification] Callback membership check failed', {
                    userId,
                    error: checkErr.message
                });
                await this.alertAdmins(checkErr, {
                    userId,
                    updateType: 'callback_query',
                    command: 'verify_join_status',
                    note: 'Membership API failure during callback'
                });
                return await ctx.answerCbQuery('❌ Unable to verify. Please try again later.', { show_alert: true });
            }

            if (membership.allJoined) {
                ctx.session.joinVerified = true;
                ctx.session.joinVerifiedAt = Date.now();
                await ctx.deleteMessage().catch(() => {});
                await ctx.reply('✅ <b>Welcome aboard!</b> You now have full access to the bot.', { parse_mode: 'HTML' });
                return await this._runUserStart(ctx);
            }

            const notJoined = membership.memberships
                .filter(m => !m.joined)
                .map(m => {
                    const ch = MANDATORY_CHANNELS.find(c => c.id === m.channel);
                    return ch ? ch.name : m.channel;
                });

            await ctx.answerCbQuery(`❌ You haven't joined: ${notJoined.join(', ')}`, { show_alert: true });

        } catch (error) {
            logger.error('[StartVerification] Callback error', { error: error.message, userId });
            await this.alertAdmins(error, {
                userId,
                updateType: 'callback_query',
                command: 'verify_join_status'
            });
            await ctx.answerCbQuery('❌ Error checking. Please try again.', { show_alert: true }).catch(() => {});
        }
    }

    // ═══════════════════════════════════════════════════════
    //  PUBLIC: Re-check membership for an already-verified user
    //  FAIL-CLOSED: Returns false on error (revokes access)
    // ═══════════════════════════════════════════════════════

    async reverifyUser(userId, ctx) {
        try {
            const membership = await this._checkMembership(userId);

            if (membership.allJoined) {
                ctx.session.joinVerified = true;
                ctx.session.joinVerifiedAt = Date.now();
                return true;
            }

            logger.warn('[StartVerification] Membership revoked — user left channels', {
                userId,
                missing: membership.memberships.filter(m => !m.joined).map(m => m.channel)
            });
            ctx.session.joinVerified = false;
            delete ctx.session.joinVerifiedAt;

            await ctx.reply(
                '⛔ <b>Access Revoked</b>\n\n' +
                'You left one or more required channels. Please re-join to continue using the bot.\n\n' +
                'Tap /start to verify again.',
                { parse_mode: 'HTML' }
            );
            return false;

        } catch (checkErr) {
            // FAIL-CLOSED: On API error, revoke access rather than allow
            logger.error('[StartVerification] Re-verify check failed — revoking access', { userId, error: checkErr.message });
            ctx.session.joinVerified = false;
            delete ctx.session.joinVerifiedAt;

            await ctx.reply(
                '⛔ <b>Verification Error</b>\n\n' +
                'Unable to verify your channel membership. Please try /start again later.',
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return false;
        }
    }
            // ═══════════════════════════════════════════════════════
    //  PRIVATE: Register callback actions
    // ═══════════════════════════════════════════════════════

    _registerCallbacks() {
        this.bot.action('verify_join_status', (ctx) => this.handleVerifyCallback(ctx));

        // Register CAPTCHA answer handler — matches any captcha_N callback
        this.bot.action(/^captcha_(-?\d+)$/, (ctx) => this.handleCaptchaAnswer(ctx));
    }

    // ═══════════════════════════════════════════════════════
    //  PRIVATE: Live Telegram API membership check
    // ═══════════════════════════════════════════════════════

    async _checkMembership(userId) {
        const results = await Promise.allSettled(
            MANDATORY_CHANNELS.map(async (channel) => {
                try {
                    const member = await this.bot.telegram.getChatMember(channel.id, userId);
                    const status = member.status;
                    return {
                        channel: channel.id,
                        joined: ['member', 'administrator', 'creator'].includes(status),
                        status
                    };
                } catch (err) {
                    logger.warn('[StartVerification] getChatMember failed', {
                        channel: channel.id,
                        userId,
                        error: err.message,
                        code: err.code,
                        description: err.description
                    });
                    return {
                        channel: channel.id,
                        joined: false,
                        status: 'error',
                        error: err.message
                    };
                }
            })
        );

        const memberships = results.map(r =>
            r.status === 'fulfilled' ? r.value : { channel: 'unknown', joined: false, status: 'error' }
        );

        const allJoined = memberships.every(m => m.joined);

        return { allJoined, memberships };
    }

    // ═══════════════════════════════════════════════════════
    //  PRIVATE: Send the join requirement UI
    // ═══════════════════════════════════════════════════════

    async _sendJoinRequirement(ctx) {
        const keyboard = {
            inline_keyboard: [
                ...MANDATORY_CHANNELS.map(ch => ([
                    { text: `📢 Join ${ch.name}`, url: ch.url }
                ])),
                [{ text: '✅ I\'ve Joined — Continue', callback_data: 'verify_join_status' }]
            ]
        };

        const caption = [
            '<b>👋 Welcome to SwiftSMS Bot!</b>',
            '',
            '📌 <b>To get started, please join our community:</b>',
            '',
            '1️⃣ <b>SwiftSMS Community</b> — Updates & announcements',
            '2️⃣ <b>SwiftSMS Tech</b> — Support & discussions',
            '',
            '<i>Click the buttons below, join both channels, then tap "I\'ve Joined".</i>'
        ].join('\n');

        try {
            await ctx.replyWithPhoto(WELCOME_IMAGE_URL, {
                caption,
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        } catch (photoErr) {
            logger.warn('[StartVerification] Photo send failed, using text fallback', { error: photoErr.message });
            try {
                await ctx.reply(caption, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            } catch (textErr) {
                logger.error('[StartVerification] Text fallback also failed', { error: textErr.message });
                throw textErr;
            }
        }
    }

// ═══════════════════════════════════════════════════════
//  PRIVATE: Forward to the real user start command
//  FIXED: Preserve startPayload for referral tracking
// ═══════════════════════════════════════════════════════

async _runUserStart(ctx) {
    try {
        // Preserve original start payload if it exists (from deep link t.me/bot?start=CODE)
        // This is critical because ctx.startPayload gets lost after CAPTCHA/channel verification callbacks
        if (ctx.startPayload && !ctx.session?.pendingReferralCode) {
            ctx.session.pendingReferralCode = ctx.startPayload.toUpperCase().trim();
            logger.debug('[StartVerification] Preserved startPayload in session', { 
                userId: this._getEffectiveUserId(ctx),
                code: ctx.session.pendingReferralCode 
            });
        }
        
        return await this.userCommands.handleStart(ctx);
    } catch (err) {
        logger.error('[StartVerification] userCommands.handleStart failed', {
            error: err.message,
            userId: this._getEffectiveUserId(ctx)
        });
        await this.alertAdmins(err, {
            userId: this._getEffectiveUserId(ctx),
            updateType: 'message',
            command: '/start',
            note: 'User verified but handleStart threw'
        });
        throw err;
    }
}
        
}

export default StartVerification;
