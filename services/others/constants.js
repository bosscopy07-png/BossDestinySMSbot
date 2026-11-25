// services/others/constants.js — shared constants for the OTHERS (generic number) feature
export const OTHERS_STATUS = Object.freeze({
    PURCHASING: 'PURCHASING',
    ACTIVE: 'ACTIVE',
    RECEIVED: 'RECEIVED',
    EXPIRED: 'EXPIRED',
    CANCELLED: 'CANCELLED',
    FAILED: 'FAILED'
});

export const OTHERS_TERMINAL = Object.freeze(['RECEIVED', 'EXPIRED', 'CANCELLED', 'FAILED']);
// Statuses from which "Buy Again" is offered
export const OTHERS_REBUY_ELIGIBLE = Object.freeze(['EXPIRED', 'CANCELLED', 'FAILED']);

export const OTHERS_DEFAULTS = Object.freeze({
    product: 'other',          // 5sim generic product slug (override with OTHERS_PRODUCT)
    markupUsd: 0.10,           // same flat profit used by the existing providers
    pollIntervalMs: 5000,
    pollLockMs: 20000,
    cacheTtlMs: 60000,
    expiryGraceMs: 15000,
    maxProviderErrors: 12
});

export function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Callback-data tokens must be short and safe (Telegram limit: 64 bytes)
export const TOKEN_RE = /^[a-z0-9_\-]{1,32}$/;
