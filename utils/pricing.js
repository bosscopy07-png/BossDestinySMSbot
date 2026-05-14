//  — Dynamic pricing loader
import { Settings } from '../models/index.js';
import logger from './logger.js';

let priceCache = null;
let priceCacheTime = 0;
const CACHE_TTL = 30000; // 30 seconds

export async function GetPricing() {
    const now = Date.now();
    if (priceCache && (now - priceCacheTime < CACHE_TTL)) {
        return priceCache;
    }

    try {
        const settings = await Settings.findOne({ key: 'pricing' }).lean();
        
        if (settings?.value) {
            priceCache = settings.value;
            priceCacheTime = now;
            return priceCache;
        }
    } catch (error) {
        logger.error('Failed to load pricing from settings', { error: error.message });
    }

    // Fallback defaults if no settings found
    priceCache = {
        cheap: { price: 0.20, label: 'CHEAP', description: 'per OTP' },
        bundle: { price: 2.00, amount: 10, label: 'BUNDLE', description: 'for 10 OTPs' },
        vip: { price: 7.00, period: 'month', label: 'VIP', description: 'unlimited' }
    };
    priceCacheTime = now;
    return priceCache;
}

export function clearPriceCache() {
    priceCache = null;
    priceCacheTime = 0;
}

export function FormatPrice(pricing) {
    return {
        cheap: `$${pricing.cheap.price.toFixed(2)}/${pricing.cheap.description}`,
        bundle: `$${pricing.bundle.price.toFixed(2)} ${pricing.bundle.description}`,
        vip: `$${pricing.vip.price.toFixed(2)}/${pricing.vip.period} ${pricing.vip.description}`
    };
}
