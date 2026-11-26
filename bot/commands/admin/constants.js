// bot/commands/admin/constants.js — shared constants for the admin command modules

// ─── Image URLs ───
export const IMG_SUCCESS = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png';
export const IMG_ERROR = 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png';

// ─── Transaction type constants ───
export const TX_TYPES = Object.freeze({
    CHEAP_OTP: 'CHEAP_OTP',
    BUNDLE_PURCHASE: 'BUNDLE_PURCHASE',
    VIP_SUBSCRIPTION: 'VIP_SUBSCRIPTION',
    DEPOSIT: 'DEPOSIT',
    REFERRAL_REWARD: 'REFERRAL_REWARD',
    ADMIN_ADD: 'ADMIN_ADD',
    ADMIN_DEDUCT: 'ADMIN_DEDUCT',
    WITHDRAWAL: 'WITHDRAWAL',
    REFUND: 'REFUND',
    POOL_PURCHASE: 'POOL_PURCHASE',
    NUMBER_RETIRE: 'NUMBER_RETIRE',
    NUMBER_ASSIGN: 'NUMBER_ASSIGN',
    NUMBER_RELEASE: 'NUMBER_RELEASE'
});

// ─── Admin state constants for button flows ───
export const ADMIN_STATE = Object.freeze({
    NONE: 'none',
    AWAITING_BROADCAST: 'awaitingBroadcast',
    AWAITING_ADD_BALANCE: 'awaitingAddBalance',
    AWAITING_DEDUCT_BALANCE: 'awaitingDeductBalance',
    AWAITING_BLACKLIST_REASON: 'awaitingBlacklistReason',
    AWAITING_MESSAGE_USER: 'awaitingMessageUser',
    AWAITING_SEARCH_QUERY: 'awaitingSearchQuery',
    AWAITING_RESET_FREE_USER: 'awaitingResetFreeUser',
    AWAITING_GIVE_VIP_USER: 'awaitingGiveVipUser',
    AWAITING_GIVE_VIP_DAYS: 'awaitingGiveVipDays',
    AWAITING_POOL_PURCHASE_COUNTRY: 'awaitingPoolPurchaseCountry',
    AWAITING_POOL_PURCHASE_QTY: 'awaitingPoolPurchaseQty',
    AWAITING_POOL_PURCHASE_PROVIDER: 'awaitingPoolPurchaseProvider',
    AWAITING_CANCEL_VIP_USER: 'awaitingCancelVipUser',
    AWAITING_SET_BUNDLE_PRICE: 'awaitingSetBundlePrice',
    AWAITING_SET_BUNDLE_OTP_PRICE: 'awaitingSetBundleOtpPrice',
    AWAITING_RETIRE_NUMBER: 'awaitingRetireNumber',
    AWAITING_BROADCAST_MESSAGE: 'awaitingBroadcastMessage',
    AWAITING_CUSTOM_BROADCAST_FILTER: 'awaitingCustomBroadcastFilter'
});

// ─── Number status constants ───
export const NUMBER_STATUS = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    ASSIGNED: 'ASSIGNED',
    RESERVED: 'RESERVED',
    RETIRED: 'RETIRED',
    EXPIRED: 'EXPIRED'
});
