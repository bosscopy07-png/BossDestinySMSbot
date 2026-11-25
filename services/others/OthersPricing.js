// services/others/OthersPricing.js — price calculation for OTHERS (no fake prices: input is live provider cost)
import { OTHERS_DEFAULTS } from './constants.js';

export class OthersPricing {
    constructor({ markupUsd = OTHERS_DEFAULTS.markupUsd } = {}) {
        this.markupUsd = Number.isFinite(markupUsd) ? markupUsd : OTHERS_DEFAULTS.markupUsd;
    }

    /** User-facing price in USD, rounded UP to the cent so we never undercharge by rounding. */
    userPrice(providerCost) {
        const c = Number(providerCost);
        if (!Number.isFinite(c) || c <= 0) return null;
        return Math.ceil((c + this.markupUsd) * 100 - 1e-9) / 100;
    }

    static toCents(price) { return Math.round(Number(price) * 100); }
    static fromCents(c) { return Math.round(Number(c)) / 100; }
}
export default OthersPricing;
