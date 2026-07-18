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
       operatorRange: { min: 26, max: 61 },
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
       operatorRange: { min: 62, max: 999 },
       fallbackWithinTier: true,
       sortPriority: 'quality',    // Prioritize best operators
       priceMultiplier: 1.0,
       minStock: 1,
       badge: 'best'
   }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  DYNAMIC OPERATOR DISCOVERY — NEW
//  Fetches real operators from provider APIs instead of guessing
// ═══════════════════════════════════════════════════════════════════════════════

/**
* Provider API configurations for dynamic operator fetching
* Add your actual API endpoints and response parsers here
*/
export const PROVIDER_APIS = {
   fivesim: {
       name: '5sim',
       getProductsUrl: (country, service) => 
           `https://5sim.net/v1/guest/products/${country}/${service}`,
       parseOperators: (data) => {
           // 5sim returns: { "virtual1": { "Qty": 5, "Price": 0.25 }, ... }
           if (!data || typeof data !== 'object') return [];
           return Object.entries(data)
               .filter(([key]) => key.startsWith('virtual'))
               .map(([key, val]) => ({
                   operator: key,
                   price: parseFloat(val.Price || val.price || 0),
                   stock: parseInt(val.Qty || val.qty || val.stock || 0)
               }));
       }
   },
   smspool: {
       name: 'SMSPool',
       getProductsUrl: (country, service) => 
           `https://api.smspool.net/purchase/retrieve_operators`, // adjust endpoint
       parseOperators: (data) => {
           // Adjust based on actual SMSPool response format
           if (!Array.isArray(data)) return [];
           return data
               .filter(op => op.operator?.startsWith('virtual'))
               .map(op => ({
                   operator: op.operator,
                   price: parseFloat(op.price || 0),
                   stock: parseInt(op.stock || op.quantity || 0)
               }));
       }
   }
   // Add Hero, OnlineSim, etc. here
};

/**
* Fetches REAL operators from a provider API for a specific country/service
* This replaces static guessing with actual provider data
*/
export async function fetchProviderOperators(providerKey, country, service) {
   const provider = PROVIDER_APIS[providerKey];
   if (!provider) return [];
   
   try {
       const url = provider.getProductsUrl(country, service);
       const response = await fetch(url, {
           headers: {
               'Accept': 'application/json',
               'User-Agent': 'Vaultix/1.0'
           }
       });
       
       if (!response.ok) return [];
       const data = await response.json();
       return provider.parseOperators(data);
   } catch (err) {
       console.error(`[${providerKey}] Failed to fetch operators:`, err.message);
       return [];
   }
}

/**
* Filters operators by tier range and availability
* Returns ONLY operators that exist in the provider's actual catalog
*/
export function filterOperatorsByTier(operators, tierKey) {
   const tier = TIER_CONFIG[tierKey];
   if (!tier || !tier.operatorRange) return [];
   
   return operators.filter(op => {
       const match = op.operator?.match(/virtual(\d+)/);
       if (!match) return false;
       const num = parseInt(match[1]);
       return num >= tier.operatorRange.min && 
              num <= tier.operatorRange.max &&
              op.stock >= tier.minStock;
   });
}

/**
* Sorts operators based on tier priority strategy
*/
export function sortOperatorsByTier(operators, tierKey) {
   const tier = TIER_CONFIG[tierKey];
   const strategy = tier?.sortPriority || 'price';
   
   const sorted = [...operators];
   
   switch (strategy) {
       case 'price':
           // Cheapest first
           sorted.sort((a, b) => a.price - b.price);
           break;
       case 'balanced':
           // Balance: lower price + higher stock = better score
           sorted.sort((a, b) => {
               const scoreA = (a.price * 0.7) - (a.stock * 0.01);
               const scoreB = (b.price * 0.7) - (b.stock * 0.01);
               return scoreA - scoreB;
           });
           break;
       case 'quality':
           // Premium: highest virtual number (newest) first, then price
           sorted.sort((a, b) => {
               const numA = parseInt(a.operator.match(/virtual(\d+)/)?.[1] || 0);
               const numB = parseInt(b.operator.match(/virtual(\d+)/)?.[1] || 0);
               if (numB !== numA) return numB - numA; // Higher number = newer = better
               return a.price - b.price;
           });
           break;
       default:
           sorted.sort((a, b) => a.price - b.price);
   }
   
   return sorted;
}

/**
* MAIN: Get best operator for tier — DYNAMIC DISCOVERY
* 
* This is the replacement for getTierOperators().
* It fetches REAL operators from the provider, filters by tier range,
* and returns them sorted by the tier's strategy.
* 
* @param {string} tierKey - 'budget' | 'standard' | 'premium'
* @param {string} country - Country code (e.g., 'US')
* @param {string} service - Service name (e.g., 'WhatsApp')
* @param {string} providerKey - Provider to check (e.g., 'fivesim')
* @returns {Promise<Array>} Sorted list of available operators
*/
export async function getBestTierOperators(tierKey, country, service, providerKey = 'fivesim') {
   // 1. Fetch real operators from provider API
   const allOperators = await fetchProviderOperators(providerKey, country, service);
   
   if (!allOperators.length) {
       console.warn(`[${providerKey}] No operators returned for ${country}/${service}`);
       return [];
   }
   
   // 2. Filter to only those in this tier's range AND with stock
   const tierOperators = filterOperatorsByTier(allOperators, tierKey);
   
   if (!tierOperators.length) {
       console.warn(`[${tierKey}] No operators in range with stock`);
       return [];
   }
   
   // 3. Sort by tier strategy (price/balanced/quality)
   const sorted = sortOperatorsByTier(tierOperators, tierKey);
   
   console.log(`[${tierKey}] Found ${sorted.length} operators, best: ${sorted[0]?.operator} @ $${sorted[0]?.price}`);
   return sorted;
}

/**
* Picks the SINGLE best operator for a purchase
* Returns null if none available (triggers cross-provider fallback)
*/
export async function pickBestOperator(tierKey, country, service, providerKey = 'fivesim') {
   const operators = await getBestTierOperators(tierKey, country, service, providerKey);
   return operators[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FALLBACK SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

/**
* Cross-provider fallback chain
* If primary provider has no stock, tries others in order
*/
export const PROVIDER_FALLBACK_CHAIN = ['fivesim', 'smspool'];

/**
* Finds best operator across ALL providers with fallback
* Tries each provider in chain until it finds stock
*/
export async function findOperatorWithFallback(tierKey, country, service) {
   for (const providerKey of PROVIDER_FALLBACK_CHAIN) {
       const operator = await pickBestOperator(tierKey, country, service, providerKey);
       if (operator) {
           return {
               ...operator,
               provider: providerKey,
               tier: tierKey
           };
       }
       console.log(`[fallback] ${providerKey} has no ${tierKey} stock, trying next...`);
   }
   return null;
}

/**
* Cross-tier fallback: If premium out of stock, try standard, then budget
*/
export async function findOperatorWithTierFallback(preferredTier, country, service) {
   const tierOrder = [preferredTier, 'standard', 'budget'];
   const uniqueTiers = [...new Set(tierOrder)]; // Remove duplicates if preferred is already in list
   
   for (const tierKey of uniqueTiers) {
       const result = await findOperatorWithFallback(tierKey, country, service);
       if (result) {
           if (tierKey !== preferredTier) {
               console.log(`[tier-fallback] ${preferredTier} unavailable, using ${tierKey}: ${result.operator}`);
           }
           return result;
       }
   }
   return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LEGACY / STATIC FUNCTIONS (kept for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

/**
* Generate static operator list from range (OLD — use getBestTierOperators instead)
* This is what was causing the "only checks beginning numbers" bug
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
* Now uses DYNAMIC discovery instead of static range
*/
export async function getAdjacentOperators(operator, tierKey, maxDistance = 5) {
   const match = operator.match(/virtual(\d+)/);
   if (!match) return [];
   
   const num = parseInt(match[1]);
   const tier = TIER_CONFIG[tierKey];
   if (!tier || !tier.operatorRange) return [];
   
   // Build adjacent candidates
   const candidates = [];
   for (let i = 1; i <= maxDistance; i++) {
       const higher = num + i;
       const lower = num - i;
       
       if (higher <= tier.operatorRange.max) {
           candidates.push(`virtual${higher}`);
       }
       if (lower >= tier.operatorRange.min) {
           candidates.push(`virtual${lower}`);
       }
   }
   return candidates;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  POPULAR SERVICES, CATEGORIES, COUNTRIES
// ═══════════════════════════════════════════════════════════════════════════════

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
* DEPRECATED: Use getBestTierOperators() instead
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
       
