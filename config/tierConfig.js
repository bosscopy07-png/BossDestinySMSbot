// ═══════════════════════════════════════════════════════════════════════════════
//  config/tierConfig.js — Tier-to-Operator Mapping Configuration
//  ZERO hardcoded providers in business logic. All mappings live here.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tier Operator Configuration
 * 
 * Reorganized so each tier has DISTINCT operators with clear quality progression:
 *   Budget:    "any" + oldest/cheapest virtual operators (lowest 5SIM cost)
 *   Standard:  Mid-range virtual operators (moderate 5SIM cost)
 *   Premium:   Newest/most expensive virtual operators (highest 5SIM cost)
 * 
 * NO operator overlap between tiers. Each operator belongs to exactly one tier.
 * This ensures:
 *   - Budget cannot accidentally get "premium" operators
 *   - Premium always gets highest-quality (most expensive) operators
 *   - Clear user expectation: paying same price, getting different quality tiers
 */

export const TIER_CONFIG = {
    budget: {
        label: 'Budget',
        emoji: '💸',
        description: 'Cheapest available providers. Lower consistency.',
        detail: 'Random allocation ("any") or oldest virtual operators. Best for low-priority use.',
        // FIXED: Only "any" + lowest virtual numbers (oldest, cheapest on 5SIM)
        operators: [
            'any',           // Random = cheapest but least consistent
            'virtual2',
            'virtual4',
            'virtual5',
            'virtual7',
            'virtual8',
            'virtual9',
            'virtual10',
            'virtual11',
            'virtual12',
            'virtual13',
            'virtual14',
            'virtual15',
            'virtual16',
            'virtual17',
            'virtual18',
            'virtual19',
            'virtual20',
            'virtual21',
            'virtual22',
            'virtual23',
            'virtual24',
            'virtual25'
        ],
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
        // FIXED: Mid-range virtual numbers only (no overlap with budget or premium)
        operators: [
            'virtual26',
            'virtual27',
            'virtual28',
            'virtual29',
            'virtual30',
            'virtual31',
            'virtual32',
            'virtual33',
            'virtual34',
            'virtual35',
            'virtual36',
            'virtual37',
            'virtual38',
            'virtual39',
            'virtual40',
            'virtual41',
            'virtual42',
            'virtual43',
            'virtual44',
            'virtual45',
            'virtual46',
            'virtual47',
            'virtual48',
            'virtual49',
            'virtual50'
        ],
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
        // FIXED: Highest virtual numbers only (newest, most expensive on 5SIM)
        // These cost more on 5SIM but you charge same flat price = better user value
        operators: [
            'virtual51',
            'virtual52',
            'virtual53',
            'virtual54',
            'virtual55',
            'virtual56',
            'virtual57',
            'virtual58',
            'virtual59',
            'virtual60',
            'virtual61',
            'virtual62',
            'virtual63',
            'virtual64',
            'virtual65',
            'virtual66',
            'virtual67',
            'virtual68',
            'virtual69',
            'virtual70',
            'virtual71',
            'virtual72',
            'virtual73',
            'virtual74',
            'virtual75',
            'virtual76',
            'virtual77',
            'virtual78',
            'virtual79',
            'virtual80',
            'virtual81',
            'virtual82',
            'virtual83',
            'virtual84',
            'virtual85',
            'virtual86',
            'virtual87',
            'virtual88',
            'virtual89',
            'virtual90',
            'virtual91',
            'virtual92',
            'virtual93',
            'virtual94',
            'virtual95',
            'virtual96',
            'virtual97',
            'virtual98',
            'virtual99',
            'virtual100',
            'virtual101',
            'virtual102',
            'virtual103',
            'virtual104',
            'virtual105',
            'virtual106',
            'virtual107',
            'virtual108',
            'virtual109',
            'virtual110'
        ],
        fallbackWithinTier: true,
        sortPriority: 'quality',    // Prioritize best operators (highest price = best)
        priceMultiplier: 1.0,
        minStock: 1,
        badge: 'best'
    }
};

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
    'Microsoft'
];

/**
 * Service categories for grouping
 */
export const SERVICE_CATEGORIES = {
    'Social Media': ['WhatsApp', 'Telegram', 'Instagram', 'Facebook', 'Twitter', 'TikTok', 'Snapchat', 'Discord'],
    'Finance': ['Binance', 'Coinbase', 'PayPal'],
    'Email': ['Gmail', 'Outlook', 'Google', 'Microsoft', 'Yahoo'],
    'Streaming': ['Netflix', 'Spotify', 'Amazon'],
    'Rides & Travel': ['Uber', 'Airbnb'],
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
 * Cache TTLs (milliseconds)
 */
export const CACHE_TTL = {
    tierPrices: 30 * 1000,
    countryStock: 60 * 1000,
    serviceList: 5 * 60 * 1000,
    providerHealth: 2 * 60 * 1000
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
    Yahoo: 'yahoo'
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

export function getTierOperators(tierKey = 'budget') {
    return getTierConfig(tierKey).operators || [];
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
