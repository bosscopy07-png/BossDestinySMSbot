import { User } from '../../models/index.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

/**
 * Resolves the effective user ID from a context.
 * Handles anonymous channel/group posts where ctx.from is the sender_chat.
 */
const _getEffectiveUserId = (ctx) => {
    if (ctx.senderChat?.id) {
        return ctx.senderChat.id.toString();
    }
    return ctx.from?.id?.toString();
};

/**
 * requireAuth middleware
 * 
 * RULES:
 * 1. Groups/Channels: SILENTLY IGNORE — bot is DM-only
 * 2. Private chats: Authenticate/create user, check blacklist
 * 3. Admin bypass: Skip auth for admin IDs (including anonymous posts)
 */
export const requireAuth = async (ctx, next) => {
    // ─── SILENTLY IGNORE non-private chats ───
    // The bot is a DM-only OTP service. Never reply in groups/channels.
    if (ctx.chat?.type !== 'private') {
        return; // Stop here. Do NOT call next(). Do NOT reply.
    }

    const userId = _getEffectiveUserId(ctx);

    if (!userId) {
        return ctx.reply('❌ Authentication required.').catch(() => {});
    }

    // ─── Admin bypass: Don't create DB records for admins ───
    const adminIds = (config.bot?.adminId || '')
        .toString()
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);

    if (adminIds.includes(userId)) {
        ctx.state.isAdmin = true;
        ctx.state.userId = userId;
        return next();
    }

    // ─── Only for regular users in private chats ───
    let user = await User.findOne({ userId });

    if (!user) {
        user = await User.create({
            userId,
            username: ctx.from?.username || null,
            firstName: ctx.from?.first_name || null,
            lastName: ctx.from?.last_name || null,
            createdAt: new Date()
        });

        logger.info('New user registered', { userId, username: ctx.from?.username });
    }

    await User.updateOne({ userId }, { lastActive: new Date() });

    if (user.isBlacklisted) {
        return ctx.reply('🚫 Your account has been suspended. Contact support.').catch(() => {});
    }

    ctx.state.user = user;
    ctx.state.userId = userId;

    return next();
};

/**
 * requireAdmin middleware
 * 
 * Works for both regular users and anonymous channel/group posts.
 */
export const requireAdmin = async (ctx, next) => {
    const userId = _getEffectiveUserId(ctx);

    const adminIds = (config.bot?.adminId || '')
        .toString()
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);

    if (!adminIds.includes(userId)) {
        logger.warn('Unauthorized admin access attempt', { userId, chatType: ctx.chat?.type });
        return ctx.reply('🚫 Admin access required.').catch(() => {});
    }

    ctx.state.isAdmin = true;
    ctx.state.userId = userId;
    return next();
};

/**
 * requireBalance middleware
 */
export const requireBalance = (minAmount) => {
    return async (ctx, next) => {
        const user = ctx.state.user;

        if (!user) {
            return ctx.reply('❌ Please start the bot first with /start').catch(() => {});
        }

        if (typeof user.getAvailableBalance !== 'function') {
            logger.error('[requireBalance] user.getAvailableBalance is not a function', { userId: ctx.state.userId });
            return ctx.reply('❌ Account error. Please contact support.').catch(() => {});
        }

        if (user.getAvailableBalance() < minAmount) {
            return ctx.reply(
                `💰 Insufficient Balance\n\n` +
                `Required: ${minAmount} USDT\n` +
                `Available: ${user.getAvailableBalance().toFixed(2)} USDT\n\n` +
                `Use /deposit to add funds.`
            ).catch(() => {});
        }

        return next();
    };
};
    
