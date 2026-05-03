// ═══════════════════════════════════════════════════════════
//  bot/verification/StartVerification.js
// ═══════════════════════════════════════════════════════════

import logger from '../../utils/logger.js';

const MANDATORY_CHANNELS = [
    { id: '@Swiftsmscommunity', name: 'SwiftSMS Community', url: 'https://t.me/Swiftsmscommunity' },
    { id: '@swiftsmstech', name: 'SwiftSMS Tech', url: 'https://t.me/swiftsmstech' }
];

const WELCOME_IMAGE_URL = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';

// Re-verify membership every 24 hours
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

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

    // ═══════════════════════════════════════════════════════
    //  PUBLIC API: Main entry point for /start
    // ═══════════════════════════════════════════════════════

    async handleStart(ctx) {
        const userId = ctx.from?.id;

        if (!userId) {
            logger.warn('[StartVerification] Missing userId in /start');
            return ctx.reply('❌ Unable to identify user. Please try again.').catch(() => {});
        }

        // ─── Admin bypass ───
        if (this.isAdmin(userId)) {
            logger.debug('[StartVerification] Admin bypass', { userId });
            ctx.session.joinVerified = true;
            ctx.session.joinVerifiedAt = Date.now();
            return await this._runUserStart(ctx);
        }

        // ─── Check if verification is still fresh ───
        const isFresh = ctx.session?.joinVerified === true &&
                        ctx.session?.joinVerifiedAt &&
                        (Date.now() - ctx.session.joinVerifiedAt < VERIFICATION_TTL_MS);

        if (isFresh) {
            logger.debug('[StartVerification] Using fresh verification', { userId });
            return await this._runUserStart(ctx);
        }

        // ─── Verification expired or never done — re-check live ───
        logger.debug('[StartVerification] Performing live membership check', { userId });

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

        // ─── Evaluate result ───
        if (membership.allJoined) {
            logger.info('[StartVerification] User verified', { userId, channels: membership.memberships });
            ctx.session.joinVerified = true;
            ctx.session.joinVerifiedAt = Date.now();
            return await this._runUserStart(ctx);
        }

        // ─── Not joined — enforce requirement ───
        logger.info('[StartVerification] User not joined', {
            userId,
            missing: membership.memberships.filter(m => !m.joined).map(m => m.channel)
        });
        ctx.session.joinVerified = false;
        delete ctx.session.joinVerifiedAt;
        return await this._sendJoinRequirement(ctx);
    }

    // ═══════════════════════════════════════════════════════
    //  CALLBACK: "I've Joined" button
    // ═══════════════════════════════════════════════════════

    async handleVerifyCallback(ctx) {
        const userId = ctx.from?.id;
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
    // ═══════════════════════════════════════════════════════

    async reverifyUser(userId, ctx) {
        try {
            const membership = await this._checkMembership(userId);

            if (membership.allJoined) {
                ctx.session.joinVerified = true;
                ctx.session.joinVerifiedAt = Date.now();
                return true;
            }

            // User left — revoke access
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
            logger.error('[StartVerification] Re-verify check failed', { userId, error: checkErr.message });
            // Fail-safe: assume still valid to avoid disrupting user
            return true;
        }
    }

    // ═══════════════════════════════════════════════════════
    //  PRIVATE: Register callback actions
    // ═══════════════════════════════════════════════════════

    _registerCallbacks() {
        this.bot.action('verify_join_status', (ctx) => this.handleVerifyCallback(ctx));
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
    // ═══════════════════════════════════════════════════════

    async _runUserStart(ctx) {
        try {
            return await this.userCommands.handleStart(ctx);
        } catch (err) {
            logger.error('[StartVerification] userCommands.handleStart failed', {
                error: err.message,
                userId: ctx.from?.id
            });
            await this.alertAdmins(err, {
                userId: ctx.from?.id,
                updateType: 'message',
                command: '/start',
                note: 'User verified but handleStart threw'
            });
            throw err;
        }
    }
}

export default StartVerification;
