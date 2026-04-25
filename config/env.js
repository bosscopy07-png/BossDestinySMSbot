import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Joi from 'joi';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

const envSchema = Joi.object({
    BOT_TOKEN: Joi.string().required(),
    ADMIN_ID: Joi.string().required(),
    DATABASE_URL: Joi.string().uri().required(),
    REDIS_URL: Joi.string().uri().allow(''),
    TWILIO_SID: Joi.string().required(),
    TWILIO_AUTH_TOKEN: Joi.string().required(),
    TWILIO_PHONE_NUMBER: Joi.string().required(),
    TELNYX_API_KEY: Joi.string().required(),
    TELNYX_PHONE_NUMBER: Joi.string().required(),
    TELNYX_MESSAGING_PROFILE_ID: Joi.string().allow('').optional(),
    CHEAP_PANEL_API_KEY: Joi.string().required(),
    CHEAP_PANEL_BASE_URL: Joi.string().uri().required(),
    MASTER_PRIVATE_KEY: Joi.string().pattern(/^0x[a-fA-F0-9]{64}$/).required(),
    BSC_RPC: Joi.string().uri().required(),
    USDT_CONTRACT: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
    BLOCK_CONFIRMATIONS: Joi.number().integer().min(1).default(12),
    JWT_SECRET: Joi.string().min(32).required(),
    RATE_LIMIT_WINDOW_MS: Joi.number().integer().default(60000),
    RATE_LIMIT_MAX_REQUESTS: Joi.number().integer().default(60),
    CHEAP_OTP_PRICE: Joi.number().positive().default(0.05),
    VIP_MONTHLY_PRICE: Joi.number().positive().default(10.00),
    BUNDLE_PRICE: Joi.number().positive().default(5.00),
    BUNDLE_OTP_COUNT: Joi.number().integer().positive().default(100),
    FREE_DAILY_LIMIT: Joi.number().integer().positive().default(3),
    VIP_DAILY_LIMIT: Joi.number().integer().positive().default(50),
    REFERRAL_PERCENTAGE: Joi.number().min(0).max(1).default(0.05),
    REFERRAL_MIN_DEPOSIT: Joi.number().positive().default(1.00),
    PORT: Joi.number().integer().default(3000),
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development')
}).unknown();

const { error, value: envVars } = envSchema.validate(process.env);

if (error) {
    throw new Error(`Environment validation error: ${error.message}`);
}

export const config = {
    bot: {
        token: envVars.BOT_TOKEN,
        adminId: envVars.ADMIN_ID
    },
    database: {
        url: envVars.DATABASE_URL
    },
    redis: {
        url: envVars.REDIS_URL || null
    },
    twilio: {
        sid: envVars.TWILIO_SID,
        authToken: envVars.TWILIO_AUTH_TOKEN,
        phoneNumber: envVars.TWILIO_PHONE_NUMBER
    },
    telnyx: {
        apiKey: envVars.TELNYX_API_KEY,
        phoneNumber: envVars.TELNYX_PHONE_NUMBER,
        messagingProfileId: envVars.TELNYX_MESSAGING_PROFILE_ID || null
    },
    cheapPanel: {
        apiKey: envVars.CHEAP_PANEL_API_KEY,
        baseUrl: envVars.CHEAP_PANEL_BASE_URL
    },
    blockchain: {
        masterPrivateKey: envVars.MASTER_PRIVATE_KEY,
        rpc: envVars.BSC_RPC,
        usdtContract: envVars.USDT_CONTRACT,
        blockConfirmations: envVars.BLOCK_CONFIRMATIONS
    },
    security: {
        jwtSecret: envVars.JWT_SECRET,
        rateLimitWindowMs: envVars.RATE_LIMIT_WINDOW_MS,
        rateLimitMaxRequests: envVars.RATE_LIMIT_MAX_REQUESTS
    },
    pricing: {
        cheapOtp: envVars.CHEAP_OTP_PRICE,
        vipMonthly: envVars.VIP_MONTHLY_PRICE,
        bundlePrice: envVars.BUNDLE_PRICE,
        bundleOtpCount: envVars.BUNDLE_OTP_COUNT,
        freeDailyLimit: envVars.FREE_DAILY_LIMIT,
        vipDailyLimit: envVars.VIP_DAILY_LIMIT
    },
    referral: {
        percentage: envVars.REFERRAL_PERCENTAGE,
        minDeposit: envVars.REFERRAL_MIN_DEPOSIT
    },
    server: {
        port: envVars.PORT,
        env: envVars.NODE_ENV
    }
};

export default config;
