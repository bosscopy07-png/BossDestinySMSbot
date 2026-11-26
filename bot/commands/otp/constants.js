// bot/commands/otp/constants.js — shared constants for the OTP command modules
import { Markup } from 'telegraf';

// ═══════════════════════════════════════════════════════════════════════════════
export const PROFIT_MARGIN = 0.00;
export function applyProfitMargin(rawPrice) {
    if (rawPrice === null || rawPrice === undefined || isNaN(rawPrice)) return null;
    return parseFloat((rawPrice + PROFIT_MARGIN).toFixed(4));
                        }
       
// ─── Image Assets ─────────────────────────────────────────────────────────────
export const IMAGES = {
    otpMenu: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png',
    vipFirst: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    vipOther: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231495/file_00000000800071f48dbbef2fbcc543fe_qgr5ch.png',
    bundleFirst: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231494/file_00000000733c7246bf7774567468638b_l64i5g.png',
    bundleOther: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231493/file_000000004c8c71f49757d61e50e41a4e_dyocuq.png',
    freeMode: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231492/file_00000000820072468452896492cba37c_rw0k7f.png',
    countrySelect: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000cad4720a8c06373a016e5150_mg6tx1.png',
    cheapMode: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231494/file_0000000040a871f4a09afb0846cf618e_jdiomc.png',
    otpRequested: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235811/file_00000000e318720a951c5e2e7a2588cf_yyva4e.png',
    otpReceived: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000621c71f4b75e0fc04a89d1c2_saojfi.png',
    otpFailed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000621c71f4b75e0fc04a89d1c2_saojfi.png',
    default: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    depositConfirmed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235826/file_000000001c0c720aa51ae407e6741ca5_steie1.png',
    myNumber: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    banned: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    history: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    referral: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    stats: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231495/file_00000000800071f48dbbef2fbcc543fe_qgr5ch.png'
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
