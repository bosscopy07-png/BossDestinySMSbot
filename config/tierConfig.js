// ═══════════════════════════════════════════════════════════════════════════════
//  config/tierConfig.js — Tier-to-Operator Mapping Configuration
//  ZERO hardcoded providers in business logic. All mappings live here.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tier Operator Configuration
 * 
 * Structure:
 *   tierKey: {
 *     label: 'Display Label',
 *     emoji: '🔥',
 *     description: 'User-facing description',
 *     operators: ['operator1', 'operator2'], // 5SIM operator names
 *     fallbackWithinTier: true, // Auto-fallback to next operator in same tier
 *     sortPriority: 'price' | 'balanced' | 'quality', // Selection priority
 *     priceMultiplier: 1.0, // Display price markup
 *     minStock: 1 // Minimum stock to be considered available
 *   }
 * 
 * Operators are 5SIM-specific values like: 'any', 'virtual2', 'virtual4', etc.
 * Add/remove operators here without touching business logic.
 */
export const TIER_CONFIG = {
    budget: {
        label: 'Budget',
        emoji: '💸',
        description: 'Cheapest available providers. Lower consistency.',
        detail: 'Mostly "any" operator or random allocation. Best for low-priority use.',
        operators: ['any', 'virtual2', 'virtual4', 'virtual5'],
        fallbackWithinTier: true,
        sortPriority: 'price',
        priceMultiplier: 1.0,
        minStock: 1,
        badge: null
    },
    standard: {
        label: 'Standard',
        emoji: '⚡',
        description: 'Balanced pricing and reliability.',
        detail: 'Moderate-quality providers. Recommended for everyday use.',
        operators: ['virtual7', 'virtual8', 'virtual16', 'virtual21', 'virtual26', 'virtual30'],
        fallbackWithinTier: true,
        sortPriority: 'balanced',
        priceMultiplier: 1.15,
        minStock: 1,
        badge: 'recommended'
    },
    premium: {
        label: 'Premium',
        emoji: '🔥',
        description: 'Highest-quality operators. Best success rate.',
        detail: 'Cleaner, faster numbers. Higher pricing. For important accounts.',
        operators: ['virtual32', 'virtual38', 'virtual58', 'virtual60'],
        fallbackWithinTier: true,
        sortPriority: 'quality',
        priceMultiplier: 1.35,
        minStock: 1,
        badge: 'best'
    }
};

/**
 * Popular services — displayed first in service selection
 * Array of service names matching your SERVICES constant
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
 * ISO 2-letter codes
 */
export const TOP_COUNTRIES = [
    'US', 'UK', 'CA', 'RU', 'CN', 'IN', 'NG', 'DE', 'FR', 'BR',
    'MX', 'ID', 'PH', 'VN', 'TH', 'TR', 'PL', 'UA', 'KZ', 'RO',
    'ES', 'IT', 'NL', 'SE', 'NO', 'FI', 'DK', 'AU', 'JP', 'KR'
];

/**
 * Country search aliases — map common names to ISO codes
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
    tierPrices: 30 * 1000,      // 30s — tier prices change with stock
    countryStock: 60 * 1000,   // 1m — stock changes frequently
    serviceList: 5 * 60 * 1000, // 5m — service list is stable
    providerHealth: 2 * 60 * 1000 // 2m — health scores
};
