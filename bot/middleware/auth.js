import { User } from '../../models/index.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

export const requireAuth = async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    
    if (!userId) {
        return ctx.reply('❌ Authentication required.');
    }

    // Ensure user exists in database
    let user = await User.findOne({ userId });
    
    if (!user) {
        user = await User.create({
            userId,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
            createdAt: new Date()
        });
        
        logger.info('New user registered', { userId, username: ctx.from.username });
    }

    // Update last active
    await User.updateOne({ userId }, { lastActive: new Date() });

    // Check blacklist
    if (user.isBlacklisted) {
        return ctx.reply('🚫 Your account has been suspended. Contact support.');
    }

    // Attach user to context
    ctx.state.user = user;
    ctx.state.userId = userId;

    return next();
};

export const requireAdmin = async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    
    if (!config.bot.adminId.split(',').includes(userId)) {
        logger.warn('Unauthorized admin access attempt', { userId });
        return ctx.reply('🚫 Admin access required.');
    }

    ctx.state.isAdmin = true;
    return next();
};

export const requireBalance = (minAmount) => {
    return async (ctx, next) => {
        const user = ctx.state.user;
        
        if (!user) {
            return ctx.reply('❌ Please start the bot first with /start');
        }

        if (user.getAvailableBalance() < minAmount) {
            return ctx.reply(`
💰 Insufficient Balance

Required: ${minAmount} USDT
Available: ${user.getAvailableBalance().toFixed(2)} USDT

Use /deposit to add funds.
            `);
        }

        return next();
    };
};
