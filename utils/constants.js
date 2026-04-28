
export const OTP_STATUS = {
    WAITING: 'WAITING',
    CHECKING: 'CHECKING',
    RECEIVED: 'RECEIVED',
    TIMEOUT: 'TIMEOUT',
    CANCELLED: 'CANCELLED',
    FAILED: 'FAILED'
};

export const USER_MODES = {
    FREE: 'FREE',
    CHEAP: 'CHEAP',
    VIP: 'VIP',
    BUNDLE: 'BUNDLE'  // ← FIXED: was missing
};


export const TRANSACTION_TYPES = {
    DEPOSIT: 'DEPOSIT',
    CHEAP_OTP: 'CHEAP_OTP',
    BUNDLE_PURCHASE: 'BUNDLE_PURCHASE',
    VIP_SUBSCRIPTION: 'VIP_SUBSCRIPTION',
    REFERRAL_REWARD: 'REFERRAL_REWARD',
    REFUND: 'REFUND',
    ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT'
};

export const TRANSACTION_STATUS = {
    PENDING: 'PENDING',
    CONFIRMING: 'CONFIRMING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED'
};

export const SERVICES = [
    'WhatsApp',
    'Telegram',
    'Facebook',
    'Instagram',
    'Twitter',
    'Binance',
    'Coinbase',
    'Gmail',
    'Outlook',
    'Netflix',
    'Amazon',
    'PayPal',
    'TikTok',
    'Snapchat',
    'Discord'
];

export const COUNTRIES = [
    { code: 'US', name: 'United States', flag: '🇺🇸', priceModifier: 0 },
    { code: 'UK', name: 'United Kingdom', flag: '🇬🇧', priceModifier: 0.01 },
    { code: 'CA', name: 'Canada', flag: '🇨🇦', priceModifier: 0.01 },
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬', priceModifier: -0.01 },
    { code: 'IN', name: 'India', flag: '🇮🇳', priceModifier: -0.01 },
    { code: 'DE', name: 'Germany', flag: '🇩🇪', priceModifier: 0.02 },
    { code: 'FR', name: 'France', flag: '🇫🇷', priceModifier: 0.02 },
    { code: 'RU', name: 'Russia', flag: '🇷🇺', priceModifier: 0.03 },
    { code: 'CN', name: 'China', flag: '🇨🇳', priceModifier: 0.05 }
];

export const PROVIDER_TYPES = {
    TWILIO: 'TWILIO',
    VONAGE: 'VONAGE',
    CHEAP_PANEL: 'CHEAP_PANEL',
    FREE_PUBLIC: 'FREE_PUBLIC'
};

export const PROVIDER_TIERS = {
    FREE: ['FREE_PUBLIC'],
    CHEAP: ['CHEAP_PANEL', 'VONAGE', 'TWILIO'],
    VIP: ['TWILIO', 'VONAGE']
};

export const WEBHOOK_EVENTS = {
    OTP_RECEIVED: 'otp.received',
    OTP_TIMEOUT: 'otp.timeout',
    DEPOSIT_CONFIRMED: 'deposit.confirmed',
    VIP_EXPIRING: 'vip.expiring',
    LOW_BALANCE: 'low.balance'
};
