// ═══════════════════════════════════════════════════════════════════════════════
//  config/env.js — Environment Configuration with Validation
//  Added: Payment provider configs (Paystack)
// ═══════════════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Joi from 'joi';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });

const envSchema = Joi.object({
    // ─── REQUIRED ─────────────────────────────────────────────────────────
    BOT_TOKEN: Joi.string().required(),
    ADMIN_ID: Joi.string().required(),
    DATABASE_URL: Joi.string().uri().required(),
    
    // ─── REDIS ────────────────────────────────────────────────────────────
    REDIS_URL: Joi.string().uri().allow('').optional(),
    
    // ─── VIP PROVIDERS (Twilio + Telnyx) ──────────────────────────────────
    TWILIO_SID: Joi.string().required(),
    TWILIO_AUTH_TOKEN: Joi.string().required(),
    TWILIO_PHONE_NUMBER: Joi.string().required(),
    TELNYX_API_KEY: Joi.string().required(),
    TELNYX_PHONE_NUMBER: Joi.string().required(),
    TELNYX_MESSAGING_PROFILE_ID: Joi.string().allow('').optional(),
    
    // ─── CHEAP PROVIDERS ──────────────────────────────────────────────────
    CHEAP_PANEL_API_KEY: Joi.string().required(),
    CHEAP_PANEL_BASE_URL: Joi.string().uri().required(),
    
    // SMSPool (fallback) — OPTIONAL
    SMSPOOL_API_KEY: Joi.string().allow('').optional(),
    SMSPOOL_BASE_URL: Joi.string().uri().allow('').optional().default('https://api.smspool.net'),
    
    // HeroSMS (fallback) — OPTIONAL
    HERO_SMS_API_KEY: Joi.string().allow('').optional(),
    HERO_SMS_BASE_URL: Joi.string().uri().allow('').optional().default('https://hero-sms.com/api'),
    
    // OnlineSim (last resort) — OPTIONAL
    ONLINE_SIM_API_KEY: Joi.string().allow('').optional(),
    ONLINE_SIM_BASE_URL: Joi.string().uri().allow('').optional().default('https://onlinesim.io/api'),
    
    // ─── BLOCKCHAIN ───────────────────────────────────────────────────────
    MASTER_PRIVATE_KEY: Joi.string().pattern(/^0x[a-fA-F0-9]{64}$/).required(),
    BSC_RPC: Joi.string().uri().required(),
    USDT_CONTRACT: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
    BLOCK_CONFIRMATIONS: Joi.number().integer().min(1).default(12),
    
    // ─── PAYMENT PROVIDER (Paystack) ──────────────────────────────────────
    PAYMENT_PROVIDER: Joi.string().valid('paystack', 'flutterwave', 'monnify').default('paystack'),
    PAYSTACK_SECRET_KEY: Joi.string().allow('').optional(),
    PAYSTACK_PUBLIC_KEY: Joi.string().allow('').optional(),
    PAYSTACK_WEBHOOK_SECRET: Joi.string().allow('').optional(),
    PAYSTACK_CALLBACK_URL: Joi.string().uri().allow('').optional(),
    
    // ─── NAIRA DEPOSIT CONFIG ─────────────────────────────────────────────
    MIN_DEPOSIT_NGN: Joi.number().integer().positive().default(500),
    NAIRA_FALLBACK_RATE: Joi.number().positive().default(1500),
    NAIRA_ADMIN_RATE: Joi.number().positive().allow('').optional(),
    APP_URL: Joi.string().uri().allow('').optional().default('https://api.swiftsms.com'),
    
    // ─── SECURITY ─────────────────────────────────────────────────────────
    JWT_SECRET: Joi.string().min(32).required(),
    RATE_LIMIT_WINDOW_MS: Joi.number().integer().default(60000),
    RATE_LIMIT_MAX_REQUESTS: Joi.number().integer().default(60),
    
    // ─── PRICING ──────────────────────────────────────────────────────────
    CHEAP_OTP_PRICE: Joi.number().positive().default(0.05),
    VIP_MONTHLY_PRICE: Joi.number().positive().default(10.00),
    BUNDLE_PRICE: Joi.number().positive().default(5.00),
    BUNDLE_OTP_COUNT: Joi.number().integer().positive().default(100),
    FREE_DAILY_LIMIT: Joi.number().integer().positive().default(3),
    VIP_DAILY_LIMIT: Joi.number().integer().positive().default(50),
    
    // ─── REFERRAL ─────────────────────────────────────────────────────────
    REFERRAL_PERCENTAGE: Joi.number().min(0).max(1).default(0.05),
    REFERRAL_MIN_DEPOSIT: Joi.number().positive().default(1.00),
    
    // ─── SERVER ───────────────────────────────────────────────────────────
    PORT: Joi.number().integer().default(3000),
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
    
    // ─── FEATURE FLAGS ────────────────────────────────────────────────────
    ENABLE_TIER_FLOW: Joi.string().valid('true', 'false').default('true'),
    ENABLE_LEGACY_FALLBACK: Joi.string().valid('true', 'false').default('true'),
    SHOW_TIER_PRICES: Joi.string().valid('true', 'false').default('true'),
    ENABLE_TIER_FALLBACK: Joi.string().valid('true', 'false').default('true')
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
    smspool: {
        apiKey: envVars.SMSPOOL_API_KEY || null,
        baseUrl: envVars.SMSPOOL_BASE_URL
    },
    heroSMS: {
        apiKey: envVars.HERO_SMS_API_KEY || null,
        baseUrl: envVars.HERO_SMS_BASE_URL
    },
    onlineSim: {
        apiKey: envVars.ONLINE_SIM_API_KEY || null,
        baseUrl: envVars.ONLINE_SIM_BASE_URL
    },
    blockchain: {
        masterPrivateKey: envVars.MASTER_PRIVATE_KEY,
        rpc: envVars.BSC_RPC,
        usdtContract: envVars.USDT_CONTRACT,
        blockConfirmations: envVars.BLOCK_CONFIRMATIONS
    },
    payment: {
        provider: envVars.PAYMENT_PROVIDER,
        paystackSecretKey: envVars.PAYSTACK_SECRET_KEY,
        paystackPublicKey: envVars.PAYSTACK_PUBLIC_KEY,
        paystackWebhookSecret: envVars.PAYSTACK_WEBHOOK_SECRET,
        callbackUrl: envVars.PAYSTACK_CALLBACK_URL,
        minDepositNgn: envVars.MIN_DEPOSIT_NGN,
        nairaFallbackRate: envVars.NAIRA_FALLBACK_RATE,
        nairaAdminRate: envVars.NAIRA_ADMIN_RATE || null
    },
    app: {
        url: envVars.APP_URL,
        env: envVars.NODE_ENV
    },
    security: {
        jwtSecret: envVars.JWT_SECRET,
        rateLimitWindowMs: envVars.RATE_LIMIT_WINDOW_MS,
        rateLimitMaxRequests: envVars.RATE_LIMIT_MAX_REQUESTS
    },
    tierFeatures: {
        enableTierFlow: envVars.ENABLE_TIER_FLOW === 'true',
        enableLegacyFallback: envVars.ENABLE_LEGACY_FALLBACK === 'true',
        showTierPrices: envVars.SHOW_TIER_PRICES === 'true',
        enableTierFallback: envVars.ENABLE_TIER_FALLBACK === 'true'
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
                                         
