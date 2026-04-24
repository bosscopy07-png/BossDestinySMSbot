import Redis from 'ioredis';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

let redis;

if (config.redis.url) {
    redis = new Redis(config.redis.url);
} else {
    // In-memory fallback for development
    redis = {
        requests: new Map(),
        
        async get(key) {
            return this.requests.get(key);
        },
        
        async set(key, value, ...args) {
            this.requests.set(key, value);
            if (args.includes('EX')) {
                const ttlIndex = args.indexOf('EX') + 1;
                const ttl = args[ttlIndex];
                setTimeout(() => this.requests.delete(key), ttl * 1000);
            }
            return 'OK';
        },
        
        async incr(key) {
            const current = parseInt(this.requests.get(key)) || 0;
            const next = current + 1;
            this.requests.set(key, next.toString());
            return next;
        },
        
        async expire(key, seconds) {
            setTimeout(() => this.requests.delete(key), seconds * 1000);
            return 1;
        }
    };
}

export const rateLimit = (options = {}) => {
    const {
        window = 60, // seconds
        max = 10,    // max requests
        keyPrefix = 'ratelimit'
    } = options;

    return async (ctx, next) => {
        const userId = ctx.from?.id?.toString();
        if (!userId) return next();

        const key = `${keyPrefix}:${userId}`;

        try {
            const current = await redis.incr(key);
            
            if (current === 1) {
                await redis.expire(key, window);
            }

            if (current > max) {
                logger.warn('Rate limit exceeded', { userId, current, max });
                return ctx.reply(`
⏳ Too many requests.

Please wait ${window} seconds before trying again.
                `);
            }

            return next();

        } catch (error) {
            logger.error('Rate limit check failed', { error: error.message });
            return next(); // Fail open
        }
    };
};

export const sessionLock = async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    
    if (!userId) return next();

    const { Session } = await import('../../models/index.js');
    
    const activeSession = await Session.findOne({
        userId,
        status: { $in: ['WAITING', 'CHECKING'] }
    });

    if (activeSession) {
        return ctx.reply(`
⏳ You have an active OTP session.

📱 Number: ${activeSession.number}
⏱ Status: ${activeSession.status}

Use /cancel to end it first.
        `);
    }

    return next();
};

export default redis;

