// ═══════════════════════════════════════════════════════════════════════════════
//  config/tierConfig.js — Tier Configuration
//  DYNAMIC: Operator ranges instead of hardcoded lists
//  Budget: virtual1-25, Standard: virtual26-50, Premium: virtual51+
//  Each tier checks ALL operators in its range, not just a fixed list
//  Cache TTL increased to 60 minutes to prevent rate limits
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tier Operator Configuration
 * 
 * Each tier has a RANGE of virtual operators.
 * When checking availability, ALL operators in the range are checked.
 * The cheapest operator with stock is selected.
 * 
 * Cross-operator fallback: If virtual56 fails, tries virtual57, 58, etc. within same tier
 * Cross-provider fallback: If 5sim fails, tries SMSPool, then Hero, then OnlineSim for SAME tier
 */

export const TIER_CONFIG = {
    budget: {
        label: 'Budget',
        emoji: '💸',
        description: 'Cheapest available providers. Lower consistency.',
        detail: 'Random allocation ("any") or oldest virtual operators. Best for low-priority use.',
        // RANGE: virtual1 to virtual25 (oldest, cheapest)
        operatorRange: { min: 1, max: 25 },
        fallbackWithinTier: true,
        sortPriority: 'price',      // Always pick cheapest
        priceMultiplier: 1.0,
        minStock: 1,
        badge: null
    },
    standard: {
        label: 'Standard',
        emoji: '⚡',
        description: 'Balanced pricing and reliability.',
        detail: 'Mid-range virtual operators. Recommended for everyday use.',
        // RANGE: virtual26 to virtual50 (mid-range)
        operatorRange: { min: 26, max: 51 },
        fallbackWithinTier: true,
        sortPriority: 'balanced',   // Balance price vs stock
        priceMultiplier: 1.0,
        minStock: 1,
        badge: 'recommended'
    },
    premium: {
        label: 'Premium',
        emoji: '🔥',
        description: 'Highest-quality operators. Best success rate.',
        detail: 'Newest, most expensive virtual operators. Highest 5SIM cost = best delivery.',
        // RANGE: virtual51+ (newest, most expensive)
        operatorRange: { min: 52, max: 999 },
        fallbackWithinTier: true,
        sortPriority: 'quality',    // Prioritize best operators
        priceMultiplier: 1.0,
        minStock: 1,
        badge: 'best'
    }
};

/**
 * Generate operator list from range
 */
export function getTierOperators(tierKey = 'budget') {
    const tier = TIER_CONFIG[tierKey];
    if (!tier || !tier.operatorRange) return [];
    
    const ops = [];
    for (let i = tier.operatorRange.min; i <= tier.operatorRange.max; i++) {
        ops.push(`virtual${i}`);
    }
    return ops;
}

/**
 * Check if an operator belongs to a tier
 */
export function isOperatorInTier(operator, tierKey) {
    if (!operator || operator === 'any') return true;
    const tier = TIER_CONFIG[tierKey];
    if (!tier || !tier.operatorRange) return false;
    
    const match = operator.match(/virtual(\d+)/);
    if (!match) return false;
    
    const num = parseInt(match[1]);
    return num >= tier.operatorRange.min && num <= tier.operatorRange.max;
}

/**
 * Get tier for an operator
 */
export function getOperatorTier(operator) {
    if (!operator || operator === 'any') return 'budget';
    
    const match = operator.match(/virtual(\d+)/);
    if (!match) return 'budget';
    
    const num = parseInt(match[1]);
    if (num >= TIER_CONFIG.premium.operatorRange.min) return 'premium';
    if (num >= TIER_CONFIG.standard.operatorRange.min) return 'standard';
    return 'budget';
}

/**
 * Get adjacent operators within same tier for fallback
 */
export function getAdjacentOperators(operator, tierKey, maxDistance = 5) {
    const match = operator.match(/virtual(\d+)/);
    if (!match) return [];
    
    const num = parseInt(match[1]);
    const tier = TIER_CONFIG[tierKey];
    if (!tier || !tier.operatorRange) return [];
    
    const adjacent = [];
    for (let i = 1; i <= maxDistance; i++) {
        const higher = num + i;
        const lower = num - i;
        
        if (higher <= tier.operatorRange.max && higher >= tier.operatorRange.min) {
            adjacent.push(`virtual${higher}`);
        }
        if (lower >= tier.operatorRange.min && lower <= tier.operatorRange.max) {
            adjacent.push(`virtual${lower}`);
        }
    }
    return adjacent;
}

/**
 * Popular services — displayed first in service selection
 */
export const POPULAR_SERVICES = [
    'WhatsApp',
    'Telegram',
    'TikTok',
    'Discord',
    'Instagram',
    'Facebook',
    'Twitter',
    'Binance',
    'Gmail',
    'Outlook',
    'Snapchat',
    'Netflix',
    'Amazon',
    'PayPal',
    'Spotify',
    'Uber',
    'Coinbase',
    'Airbnb',
    'Google',
    'Microsoft',
    'Rebtel',
    'Signal',
    'LinkedIn',
    'WeChat',
    'Line'
];

/**
 * Service categories for grouping
 */
export const SERVICE_CATEGORIES = {
    'Social Media': ['WhatsApp', 'Telegram', 'Instagram', 'Facebook', 'Twitter', 'TikTok', 'Snapchat', 'Discord', 'LinkedIn', 'Signal'],
    'Finance': ['Binance', 'Coinbase', 'PayPal'],
    'Email': ['Gmail', 'Outlook', 'Google', 'Microsoft', 'Yahoo'],
    'Streaming': ['Netflix', 'Spotify', 'Amazon'],
    'Rides & Travel': ['Uber', 'Airbnb'],
    'Communication': ['Rebtel', 'WeChat', 'Line'],
    'Other': []
};

/**
 * Top countries — displayed first in country selection
 */
export const TOP_COUNTRIES = [
    'US', 'UK', 'CA', 'RU', 'CN', 'IN', 'NG', 'DE', 'FR', 'BR',
    'MX', 'ID', 'PH', 'VN', 'TH', 'TR', 'PL', 'UA', 'KZ', 'RO',
    'ES', 'IT', 'NL', 'SE', 'NO', 'FI', 'DK', 'AU', 'JP', 'KR'
];

/**
 * Country search aliases
 */
export const COUNTRY_ALIASES = {
    'usa': 'US',
    'america': 'US',
    'united states': 'US',
    'britain': 'UK',
    'england': 'UK',
    'great britain': 'UK',
    'russia': 'RU',
    'china': 'CN',
    'india': 'IN',
    'nigeria': 'NG',
    'germany': 'DE',
    'france': 'FR',
    'brazil': 'BR',
    'mexico': 'MX',
    'indonesia': 'ID',
    'philippines': 'PH',
    'vietnam': 'VN',
    'thailand': 'TH',
    'turkey': 'TR',
    'poland': 'PL',
    'ukraine': 'UA',
    'kazakhstan': 'KZ',
    'romania': 'RO',
    'spain': 'ES',
    'italy': 'IT',
    'netherlands': 'NL',
    'sweden': 'SE',
    'norway': 'NO',
    'finland': 'FI',
    'denmark': 'DK',
    'australia': 'AU',
    'japan': 'JP',
    'korea': 'KR',
    'south korea': 'KR'
};

/**
 * Items per page for pagination
 */
export const PAGINATION = {
    servicesPerPage: 15,
    countriesPerPage: 20,
    searchResultsLimit: 30
};

/**
 * Cache TTLs (milliseconds) — INCREASED to prevent rate limits
 */
export const CACHE_TTL = {
    tierPrices: 60 * 60 * 1000,        // 60 minutes (was 30 seconds)
    countryStock: 60 * 60 * 1000,       // 60 minutes
    serviceList: 60 * 60 * 1000,        // 60 minutes
    providerHealth: 10 * 60 * 1000,     // 10 minutes
    productsCatalog: 60 * 60 * 1000,    // 60 minutes
    balance: 5 * 60 * 1000              // 5 minutes
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SERVICE NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

export const SERVICE_SLUGS = {
    WhatsApp: 'whatsapp',
    Telegram: 'telegram',
    TikTok: 'tiktok',
    Discord: 'discord',
    Instagram: 'instagram',
    Facebook: 'facebook',
    Twitter: 'twitter',
    Binance: 'binance',
    Gmail: 'gmail',
    Outlook: 'outlook',
    Snapchat: 'snapchat',
    Netflix: 'netflix',
    Amazon: 'amazon',
    PayPal: 'paypal',
    Spotify: 'spotify',
    Uber: 'uber',
    Coinbase: 'coinbase',
    Airbnb: 'airbnb',
    Google: 'google',
    Microsoft: 'microsoft',
    Yahoo: 'yahoo',
    Rebtel: 'rebtel',
    Signal: 'signal',
    LinkedIn: 'linkedin',
    WeChat: 'wechat',
    Line: 'line'
};

export function normalizeService(serviceName) {
    return SERVICE_SLUGS[serviceName] ||
           serviceName?.toLowerCase()?.trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function getTierConfig(tierKey = 'budget') {
    return TIER_CONFIG[tierKey] || TIER_CONFIG.budget;
}

/**
 * DEPRECATED: Use getTierOperators() instead
 */
export function getTierOperatorsLegacy(tierKey = 'budget') {
    return getTierOperators(tierKey);
}

/**
 * FIXED: applyTierPricing now just returns basePrice since all multipliers are 1.0
 * Kept for backward compatibility
 */
export function applyTierPricing(basePrice, tierKey = 'budget') {
    const tier = getTierConfig(tierKey);
    return Number(
        (basePrice * tier.priceMultiplier).toFixed(2)
    );
    }
    
