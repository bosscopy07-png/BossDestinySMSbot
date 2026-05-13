
// ═══════════════════════════════════════════════════════════════════════════════
//  bot/verification/StartVerification.js
//  Mandatory CAPTCHA + Channel Join Verification + Referral Processing
//  All referral tracking happens HERE, before UserCommands ever runs
// ═══════════════════════════════════════════════════════════════════════════════

import logger from '../../utils/logger.js';
import { User, Referral } from '../../models/index.js';
import { generateId } from '../../utils/helpers.js';

const MANDATORY_CHANNELS = [
    { id: '@Swiftsmscommunity', name: 'SwiftSMS Community', url: 'https://t.me/Swiftsmscommunity' },
    { id: '@swiftsmstech', name: 'SwiftSMS Tech', url: 'https://t.me/swiftsmstech' }
];

const WELCOME_IMAGE_URL = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const CAPTCHA_MAX_ATTEMPTS = 3;
const CAPTCHA_BLOCK_DURATION_MS = 10 * 60 * 1000;

class StartVerification {
    constructor(bot, userCommands, isAdminFn, alertAdminsFn, options = {}) {
        if (!bot || !userCommands || typeof isAdminFn !== 'function' || typeof alertAdminsFn !== 'function') {
            throw new Error('StartVerification requires: bot, userCommands, isAdminFn, alertAdminsFn');
        }

        this.bot = bot;
        this.userCommands = userCommands;
        this.isAdmin = isAdminFn;
        this.alertAdmins = alertAdminsFn;
        
        // Injected services for referral processing
        this.referralService = options.referralService || null;
        this.notificationService = options.notificationService || null;
        this.config = options.config || {};

        this._registerCallbacks();
    }

    _getEffectiveUserId(ctx) {
        if (ctx.senderChat?.id) return ctx.senderChat.id;
        return ctx.from?.id;
    }

    // ═══════════════════════════════════════════════════════
    //  REFERRAL: Capture code from context at entry point
    // ═══════════════════════════════════════════════════════

    _captureReferralCode(ctx) {
        const userId = this._getEffectiveUserId(ctx);
        let captured = null;

        if (ctx.startPayload) {
            captured = ctx.startPayload.toString().toUpperCase().trim();
            logger.info('[StartVerification] Code from startPayload', { userId, code: captured });
        }

        const text = ctx.message?.text || '';
        const startMatch = text.match(/^\/start\s+([A-Z0-9]+)/i);
        if (!captured && startMatch) {
            captured = startMatch[1].toUpperCase().trim();
            logger.info('[StartVerification] Code from text', { userId, code: captured });
        }

        if (captured) {
            ctx.session.pendingReferralCode = captured;
            ctx.session.pendingReferralCodeAt = Date.now();
            logger.info('[StartVerification] Code saved to session', { userId, code: captured });
        }

        return captured;
    }

    // ═══════════════════════════════════════════════════════
    //  REFERRAL: Process referral after successful verification
    // ═══════════════════════════════════════════════════════

    async _processReferral(userId, ctx) {
        const code = ctx.session?.pendingReferralCode;
        if (!code) {
            logger.info('[StartVerification] No pending referral code', { userId });
            return { processed: false };
        }

        // Prevent re-processing
        const user = await User.findOne({ userId }).select('referredBy').lean();
        if (user?.referredBy) {
            logger.debug('[StartVerification] User already referred', { userId, referredBy: user.referredBy });
            delete ctx.session.pendingReferralCode;
            delete ctx.session.pendingReferralCodeAt;
            return { processed: false, alreadyReferred: true };
        }

        const referrer = await User.findOne({ referralCode: code }).lean();
        if (!referrer) {
            logger.warn('[StartVerification] Invalid referral code', { userId, code });
            delete ctx.session.pendingReferralCode;
            return { processed: false, invalidCode: true };
        }

        if (referrer.userId === userId) {
            logger.warn('[StartVerification] Self-referral blocked', { userId, code });
            delete ctx.session.pendingReferralCode;
            return { processed: false, selfReferral: true };
        }

        // Set referredBy
        await User.updateOne({ userId }, { $set: { referredBy: code } });

        // Track via service
        let referralRecord = null;
        if (this.referralService) {
            try {
                referralRecord = await this.referralService.trackReferral(userId, code);
                logger.info('[StartVerification] Referral tracked via service', {
                    referralId: referralRecord?.referralId,
                    referrerId: referrer.userId
                });
            } catch (err) {
                logger.error('[StartVerification] ReferralService track failed', {
                    userId, code, error: err.message
                });
                // Fallback: manual increment
                await User.updateOne({ userId: referrer.userId }, { $inc: { referralCount: 1 } });
            }
        } else {
            logger.warn('[StartVerification] No ReferralService, using fallback', { userId, code });
            await User.updateOne({ userId: referrer.userId }, { $inc: { referralCount: 1 } });
        }

        // Notify referrer
        if (this.notificationService && referrer.userId) {
            try {
                const pct = ((this.config.referral?.percentage || 0.05) * 100).toFixed(0);
                await this.notificationService.send(referrer.userId, {
                    type: 'REFERRAL_JOINED',
                    title: '🎉 New Referral!',
                    message: `A new user joined using your code! You'll earn ${pct}% of their first deposit.`,
                    telegramChatId: referrer.userId,
                    immediate: true
                });
            } catch (err) {
                logger.error('[StartVerification] Notify referrer failed', { referrerId: referrer.userId, error: err.message });
            }
        }

        // Cleanup
        delete ctx.session.pendingReferralCode;
        delete ctx.session.pendingReferralCodeAt;

        logger.info('[StartVerification] Referral processing complete', {
            userId, referrerId: referrer.userId, code
        });

        return {
            processed: true,
            referrerId: referrer.userId,
            referrerName: referrer.username ? `@${referrer.username}` : (referrer.firstName || 'a friend'),
            code
        };
    }

    // ═══════════════════════════════════════════════════════
    //  MAIN ENTRY: handleStart
    // ═══════════════════════════════════════════════════════

    async handleStart(ctx) {
        const userId = this._getEffectiveUserId(ctx);
        if (!userId) {
            logger.warn('[StartVerification] Missing userId');
            return ctx.reply('❌ Unable to identify user.').catch(() => {});
        }

        // CRITICAL: Capture referral code immediately
        this._captureReferralCode(ctx);

        // Admin bypass
        if (this.isAdmin(userId)) {
            ctx.session.joinVerified = true;
            ctx.session.joinVerifiedAt = Date.now();
            const referralResult = await this._processReferral(userId.toString(), ctx);
            return await this._runUserStart(ctx, referralResult);
        }

        // Block check
        if (ctx.session?.captchaBlockedUntil && Date.now() < ctx.session.captchaBlockedUntil) {
            const remaining = Math.ceil((ctx.session.captchaBlockedUntil - Date.now()) / 60000);
            return ctx.reply(
                `⛔ <b>Too many failed attempts.</b>\n\nTry again in <code>${remaining}</code> minute(s).`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }

        // Fresh check
        const isFresh = ctx.session?.joinVerified === true &&
                        ctx.session?.joinVerifiedAt &&
                        (Date.now() - ctx.session.joinVerifiedAt < VERIFICATION_TTL_MS);

        if (isFresh) {
            logger.debug('[StartVerification] Fresh verification', { userId });
            const referralResult = await this._processReferral(userId.toString(), ctx);
            return await this._runUserStart(ctx, referralResult);
        }

        // CAPTCHA
        if (ctx.session?.captchaPassed !== true) {
            return await this._sendCaptchaChallenge(ctx);
        }

        // Membership check
        logger.debug('[StartVerification] Checking membership', { userId });
        let membership;
        try {
            membership = await this._checkMembership(userId);
        } catch (err) {
            logger.error('[StartVerification] Membership check failed', { userId, error: err.message });
            await this.alertAdmins(err, { userId, updateType: 'message', command: '/start', note: 'Membership API fail-safe' });
            ctx.session.joinVerified = false;
            delete ctx.session.joinVerifiedAt;
            return await this._sendJoinRequirement(ctx);
        }

        if (membership.allJoined) {
            ctx.session.joinVerified = true;
            ctx.session.joinVerifiedAt = Date.now();
            const referralResult = await this._processReferral(userId.toString(), ctx);
            return await this._runUserStart(ctx, referralResult);
        }

        logger.info('[StartVerification] Not joined', {
            userId, missing: membership.memberships.filter(m => !m.joined).map(m => m.channel)
        });
        ctx.session.joinVerified = false;
        delete ctx.session.joinVerifiedAt;
        return await this._sendJoinRequirement(ctx);
    }

    // ═══════════════════════════════════════════════════════
    //  CAPTCHA
    // ═══════════════════════════════════════════════════════

    async _sendCaptchaChallenge(ctx) {
        const challenge = this._generateMathChallenge();
        ctx.session.captchaAnswer = challenge.answer;
        ctx.session.captchaAttempts = ctx.session.captchaAttempts || 0;

        const message = '🤖 <b>Human Verification</b>\n\n' +
            `Solve: <code>${challenge.question}</code>\n\n` +
            `<i>Attempt ${ctx.session.captchaAttempts + 1}/${CAPTCHA_MAX_ATTEMPTS}</i>`;

        const options = this._shuffleArray([...challenge.options]);
        const keyboard = { inline_keyboard: options.map(opt => ([{ text: String(opt), callback_data: `captcha_${opt}` }])) };

        try {
            await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (err) {
            logger.error('[StartVerification] CAPTCHA send failed', { error: err.message });
            ctx.reply('❌ Error. Try /start again.').catch(() => {});
        }
    }

    _generateMathChallenge() {
        const ops = ['+', '-', '*'];
        const op = ops[Math.floor(Math.random() * ops.length)];
        let a, b, answer;
        switch (op) {
            case '+': a = Math.floor(Math.random() * 20) + 1; b = Math.floor(Math.random() * 20) + 1; answer = a + b; break;
            case '-': a = Math.floor(Math.random() * 20) + 10; b = Math.floor(Math.random() * 10) + 1; answer = a - b; break;
            case '*': a = Math.floor(Math.random() * 9) + 2; b = Math.floor(Math.random() * 9) + 2; answer = a * b; break;
        }
        const options = new Set([answer]);
        while (options.size < 4) {
            const wrong = answer + Math.floor(Math.random() * 10) - 5;
            if (wrong !== answer && wrong >= 0) options.add(wrong);
        }
        return { question: `${a} ${op} ${b} = ?`, answer, options: Array.from(options) };
    }

    _shuffleArray(array) {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    async handleCaptchaAnswer(ctx) {
        const userId = this._getEffectiveUserId(ctx);
        if (!userId) return;

        try {
            await ctx.answerCbQuery().catch(() => {});
            const selected = parseInt(ctx.callbackQuery.data.replace('captcha_', ''), 10);
            const correct = ctx.session?.captchaAnswer;

            if (isNaN(selected) || correct === undefined) {
                return ctx.reply('❌ Session expired. Tap /start again.').catch(() => {});
            }

            if (ctx.session?.captchaBlockedUntil && Date.now() < ctx.session.captchaBlockedUntil) {
                const remaining = Math.ceil((ctx.session.captchaBlockedUntil - Date.now()) / 60000);
                return ctx.answerCbQuery(`⛔ Blocked for ${remaining}m`, { show_alert: true });
            }

            if (selected === correct) {
                logger.info('[StartVerification] CAPTCHA passed', { userId });
                ctx.session.captchaPassed = true;
                ctx.session.captchaAttempts = 0;
                delete ctx.session.captchaAnswer;
                await ctx.deleteMessage().catch(() => {});
                await ctx.reply('✅ <b>Verified!</b> Checking channels...', { parse_mode: 'HTML' });
                return await this.handleStart(ctx);
            }

            ctx.session.captchaAttempts = (ctx.session.captchaAttempts || 0) + 1;
            const remaining = CAPTCHA_MAX_ATTEMPTS - ctx.session.captchaAttempts;

            if (remaining <= 0) {
                ctx.session.captchaBlockedUntil = Date.now() + CAPTCHA_BLOCK_DURATION_MS;
                delete ctx.session.captchaAnswer;
                delete ctx.session.captchaPassed;
                logger.warn('[StartVerification] CAPTCHA blocked', { userId });
                await ctx.deleteMessage().catch(() => {});
                return ctx.reply('⛔ <b>Blocked for 10 minutes.</b>\n\nTry /start later.', { parse_mode: 'HTML' });
            }

            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(`❌ <b>Wrong.</b> <i>${remaining} left</i>`, { parse_mode: 'HTML' });
            return await this._sendCaptchaChallenge(ctx);

        } catch (error) {
            logger.error('[StartVerification] CAPTCHA error', { error: error.message, userId });
            await this.alertAdmins(error, { userId, updateType: 'callback_query', command: 'captcha_answer', note: 'CAPTCHA crash' });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  CHANNEL VERIFICATION CALLBACK
    // ═══════════════════════════════════════════════════════

    async handleVerifyCallback(ctx) {
        const userId = this._getEffectiveUserId(ctx);
        if (!userId) return;

        try {
            await ctx.answerCbQuery('⏳ Checking...').catch(() => {});
            let membership;
            try {
                membership = await this._checkMembership(userId);
            } catch (err) {
                logger.error('[StartVerification] Callback membership failed', { userId, error: err.message });
                await this.alertAdmins(err, { userId, updateType: 'callback_query', command: 'verify_join_status', note: 'Membership API callback fail' });
                return ctx.answerCbQuery('❌ Unable to verify. Try again later.', { show_alert: true });
            }

            if (membership.allJoined) {
                ctx.session.joinVerified = true;
                ctx.session.joinVerifiedAt = Date.now();
                await ctx.deleteMessage().catch(() => {});
                await ctx.reply('✅ <b>Welcome!</b> Full access granted.', { parse_mode: 'HTML' });
                const referralResult = await this._processReferral(userId.toString(), ctx);
                return await this._runUserStart(ctx, referralResult);
            }

            const notJoined = membership.memberships
                .filter(m => !m.joined)
                .map(m => {
                    const ch = MANDATORY_CHANNELS.find(c => c.id === m.channel);
                    return ch ? ch.name : m.channel;
                });

            await ctx.answerCbQuery(`❌ Not joined: ${notJoined.join(', ')}`, { show_alert: true });

        } catch (error) {
            logger.error('[StartVerification] Verify callback error', { error: error.message, userId });
            await this.alertAdmins(error, { userId, updateType: 'callback_query', command: 'verify_join_status' });
            await ctx.answerCbQuery('❌ Error. Try again.', { show_alert: true }).catch(() => {});
        }
    }

    // ═══════════════════════════════════════════════════════
    //  REVERIFY (for periodic re-checks)
    // ═══════════════════════════════════════════════════════

    async reverifyUser(userId, ctx) {
        try {
            const membership = await this._checkMembership(userId);
            if (membership.allJoined) {
                ctx.session.joinVerified = true;
                ctx.session.joinVerifiedAt = Date.now();
                return true;
            }
            logger.warn('[StartVerification] Revoked', { userId, missing: membership.memberships.filter(m => !m.joined).map(m => m.channel) });
            ctx.session.joinVerified = false;
            delete ctx.session.joinVerifiedAt;
            await ctx.reply('⛔ <b>Access Revoked</b>\n\nRe-join channels and tap /start.', { parse_mode: 'HTML' });
            return false;
        } catch (err) {
            logger.error('[StartVerification] Reverify failed — revoking', { userId, error: err.message });
            ctx.session.joinVerified = false;
            delete ctx.session.joinVerifiedAt;
            await ctx.reply('⛔ <b>Verification Error</b>\n\nTry /start later.', { parse_mode: 'HTML' }).catch(() => {});
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════
    //  CALLBACK REGISTRATION
    // ═══════════════════════════════════════════════════════

    _registerCallbacks() {
        this.bot.action('verify_join_status', (ctx) => this.handleVerifyCallback(ctx));
        this.bot.action(/^captcha_(-?\d+)$/, (ctx) => this.handleCaptchaAnswer(ctx));
    }

    // ═══════════════════════════════════════════════════════
    //  MEMBERSHIP CHECK
    // ═══════════════════════════════════════════════════════

    async _checkMembership(userId) {
        const results = await Promise.allSettled(
            MANDATORY_CHANNELS.map(async (channel) => {
                try {
                    const member = await this.bot.telegram.getChatMember(channel.id, userId);
                    const status = member.status;
                    return { channel: channel.id, joined: ['member', 'administrator', 'creator'].includes(status), status };
                } catch (err) {
                    logger.warn('[StartVerification] getChatMember failed', { channel: channel.id, userId, error: err.message });
                    return { channel: channel.id, joined: false, status: 'error', error: err.message };
                }
            })
        );

        const memberships = results.map(r => r.status === 'fulfilled' ? r.value : { channel: 'unknown', joined: false, status: 'error' });
        const allJoined = memberships.every(m => m.joined);
        return { allJoined, memberships };
    }

    // ═══════════════════════════════════════════════════════
    //  JOIN REQUIREMENT UI
    // ═══════════════════════════════════════════════════════

    
         async _sendJoinRequirement(ctx) {
        const keyboard = {
            inline_keyboard: [
                ...MANDATORY_CHANNELS.map(ch => ([{ text: `📢 Join ${ch.name}`, url: ch.url }])),
                [{ text: '✅ I\'ve Joined — Continue', callback_data: 'verify_join_status' }]
            ]
        };

        const caption = [
            '<b>👋 Welcome to SwiftSMS Bot!</b>',
            '',
            '📌 <b>Join our community to continue:</b>',
            '',
            '1️⃣ <b>SwiftSMS Community</b> — Updates & announcements',
            '2️⃣ <b>SwiftSMS Tech</b> — Support & discussions',
            '',
            '<i>Click buttons below, join both, then tap "I\'ve Joined".</i>'
        ].join('\n');

        try {
            await ctx.replyWithPhoto(WELCOME_IMAGE_URL, { caption, parse_mode: 'HTML', reply_markup: keyboard });
        } catch (photoErr) {
            logger.warn('[StartVerification] Photo failed, text fallback', { error: photoErr.message });
            await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  FORWARD TO USER COMMANDS (with referral result)
    // ═══════════════════════════════════════════════════════

    async _runUserStart(ctx, referralResult = { processed: false }) {
        const userId = this._getEffectiveUserId(ctx);
        try {
            logger.debug('[StartVerification] Forwarding to userCommands', {
                userId,
                referralProcessed: referralResult.processed,
                referrerId: referralResult.referrerId || null
            });
            
            // Pass referral result via ctx.state so UserCommands can use it
            ctx.state.referralResult = referralResult;
            return await this.userCommands.handleStart(ctx);
        } catch (err) {
            logger.error('[StartVerification] userCommands.handleStart failed', { error: err.message, userId });
            await this.alertAdmins(err, { userId, updateType: 'message', command: '/start', note: 'Verified but handleStart threw' });
            throw err;
        }
    }
}

export default StartVerification;
