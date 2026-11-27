
// bot/commands/otp/constants.js — shared constants for the OTP command modules
import { Markup } from 'telegraf';

import { BOT_IMAGE_URL } from '../../../utils/botImage.js';
// ═══════════════════════════════════════════════════════════════════════════════
export const PROFIT_MARGIN = 0.00;
export function applyProfitMargin(rawPrice) {
    if (rawPrice === null || rawPrice === undefined || isNaN(rawPrice)) return null;
    return parseFloat((rawPrice + PROFIT_MARGIN).toFixed(4));
                        }
       
// ─── Image Assets ─────────────────────────────────────────────────────────────
export const IMAGES = {
    otpMenu: BOT_IMAGE_URL,
    vipFirst: BOT_IMAGE_URL,
    vipOther: BOT_IMAGE_URL,
    bundleFirst: BOT_IMAGE_URL,
    bundleOther: BOT_IMAGE_URL,
    freeMode: BOT_IMAGE_URL,
    countrySelect: BOT_IMAGE_URL,
    cheapMode: BOT_IMAGE_URL,
    otpRequested: BOT_IMAGE_URL,
    otpReceived: BOT_IMAGE_URL,
    otpFailed: BOT_IMAGE_URL,
    default: BOT_IMAGE_URL,
    depositConfirmed: BOT_IMAGE_URL,
    myNumber: BOT_IMAGE_URL,
    banned: BOT_IMAGE_URL,
    history: BOT_IMAGE_URL,
    referral: BOT_IMAGE_URL,
    stats: BOT_IMAGE_URL
};

// ─── Inline Keyboards (Reusable) ──────────────────────────────────────────────
export const KEYBOARDS = {
    backToMenu: () => Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Menu', 'menu')]
    ]),
    
    depositOrBack: () => Markup.inlineKeyboard([
        [Markup.button.callback('💳 Deposit', 'deposit')],
        [Markup.button.callback('🔙 Back', 'menu')]
    ]),
    
    supportOrRetry: () => Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'menu')],
        [Markup.button.callback('📞 Support', 'contact_support')]
    ]),
    
    otpActions: (sessionId, number = null) => Markup.inlineKeyboard([
        ...(number ? [[{ text: '📋 Copy Number', copy_text: { text: String(number) } }]] : []),
        [Markup.button.callback('🔍 Check OTP', `check_otp_${sessionId}`), Markup.button.callback('❌ Cancel', 'cancel_otp')]
    ])
};

// ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands Class
// ═══════════════════════════════════════════════════════════════════════════════
