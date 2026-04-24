 import Joi from 'joi';

export const depositSchema = Joi.object({
    amount: Joi.number().positive().min(0.50).required(),
    currency: Joi.string().valid('USDT', 'BUSD', 'BNB').default('USDT')
});

export const otpRequestSchema = Joi.object({
    service: Joi.string().required(),
    mode: Joi.string().valid('FREE', 'CHEAP', 'VIP').required(),
    country: Joi.string().length(2).default('US')
});

export const apiKeySchema = Joi.object({
    name: Joi.string().min(1).max(100).required(),
    permissions: Joi.array().items(
        Joi.string().valid('read', 'request_otp', 'webhook', 'balance')
    ).min(1).required(),
    webhookUrl: Joi.string().uri().optional(),
    webhookEvents: Joi.array().items(
        Joi.string().valid('otp.received', 'otp.timeout', 'deposit.confirmed')
    ).optional()
});

export const broadcastSchema = Joi.object({
    message: Joi.string().min(1).max(4096).required(),
    filters: Joi.object({
        mode: Joi.string().valid('FREE', 'CHEAP', 'VIP').optional(),
        vipOnly: Joi.boolean().optional(),
        activeSince: Joi.date().optional()
    }).default({})
});

export const userUpdateSchema = Joi.object({
    balance: Joi.number().min(0).optional(),
    bundleRemaining: Joi.number().min(0).integer().optional(),
    vipExpiry: Joi.date().optional(),
    mode: Joi.string().valid('FREE', 'CHEAP', 'VIP').optional(),
    isBlacklisted: Joi.boolean().optional(),
    blacklistReason: Joi.string().optional(),
    preferredCountry: Joi.string().length(2).optional()
}).min(1);

export const withdrawalSchema = Joi.object({
    toAddress: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
    amount: Joi.number().positive().required()
});
