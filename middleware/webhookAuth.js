import config from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * IP whitelist for Paystack webhooks
 */
const PAYSTACK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];

export const webhookIpFilter = (req, res, next) => {
    // Skip in development
    if (config.env === 'development') {
        return next();
    }

    const clientIp = req.ip || req.connection.remoteAddress;
    
    if (!PAYSTACK_IPS.includes(clientIp)) {
        logger.warn('Webhook request from unauthorized IP', { ip: clientIp });
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    next();
};

/**
 * Rate limiter for webhook endpoint
 */
export const webhookRateLimiter = {
    windowMs: 60 * 1000, // 1 minute
    max: 100 // Max 100 requests per minute
};
