// services/rewards/cashbackMath.js — pure cashback helpers (no database)
export const CASHBACK_RATE = (() => { const r = parseFloat(process.env.CASHBACK_RATE ?? '0.01'); return Number.isFinite(r) && r >= 0 && r <= 0.5 ? r : 0.01; })();

/** 1% (by default) of what the user paid, floored to 4 decimals so we never pay out more than the rate. */
export function computeCashback(amount, rate = CASHBACK_RATE) {
    const a = Math.abs(Number(amount));
    if (!Number.isFinite(a) || a <= 0) return 0;
    return Math.floor(a * rate * 10000 + 1e-9) / 10000;
}
export const fmt4 = (n) => `$${(Math.round(Number(n || 0) * 10000) / 10000).toFixed(4)}`;
export const round4 = (n) => Math.floor(Number(n || 0) * 10000 + 1e-9) / 10000;
