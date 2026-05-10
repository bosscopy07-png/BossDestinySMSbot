// ═══════════════════════════════════════════════════════════════════════════════
//  services/CountryCatalog.js — Country Discovery with Live Pricing & Search
//  Handles 120+ countries without loading all at once
// ═══════════════════════════════════════════════════════════════════════════════

import { TOP_COUNTRIES, COUNTRY_ALIASES, PAGINATION, CACHE_TTL, TIER_CONFIG } from '../config/tierConfig.js';
import { COUNTRIES } from '../utils/constants.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate stable cache key from sorted inputs (immutable)
 */
function makeCacheKey(tierKey, service, countryCodes) {
    // Slice to avoid mutating caller's array, then sort
    const sorted = countryCodes.slice().sort();
    return `${tierKey}:${service}:${sorted.join(',')}`;
}

/**
 * Check if error indicates "service not offered" vs. "transient failure"
 */
function isNoStockError(error) {
    if (!error || !error.message) return false;
    return (
        error.message.includes('TIER_NO_STOCK') ||
        error.message.includes('NO_SERVICE') ||
        error.message.includes('NOT_AVAILABLE')
    );
}

/**
 * Convert ISO 3166-1 alpha-2 code to emoji flag
 */
function isoToFlag(code) {
    if (!code || typeof code !== 'string' || code.length !== 2) return '🌍';
    const cc = code.toUpperCase();
    const OFFSET = 127397;
    try {
        return (
            String.fromCodePoint(cc.charCodeAt(0) + OFFSET) +
            String.fromCodePoint(cc.charCodeAt(1) + OFFSET)
        );
    } catch {
        return '🌍';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class CountryCatalog {
    constructor(cheapPanelProvider, tierSelector) {
        if (!cheapPanelProvider || !tierSelector) {
            throw new Error('CountryCatalog requires both cheapPanelProvider and tierSelector');
        }

        this.provider = cheapPanelProvider;
        this.tierSelector = tierSelector;

        // Build country index
        this._countryMap = new Map();      // iso -> country data
        this._nameIndex = new Map();       // normalized name -> iso
        this._buildIndex();

        // Price cache with bounded size (LRU-like eviction)
        this._priceCache = new Map();
        this._maxCacheSize = 200;          // Prevent unbounded growth
    }

    _buildIndex() {
        for (const country of COUNTRIES) {
            if (!country?.code || !country?.name) {
                logger.warn('Skipping invalid country entry', { country });
                continue;
            }

            const code = country.code.toUpperCase();
            this._countryMap.set(code, country);
            this._nameIndex.set(country.name.toLowerCase(), code);

            // Index aliases that point to this country
            for (const [alias, aliasCode] of Object.entries(COUNTRY_ALIASES)) {
                if (aliasCode === code) {
                    this._nameIndex.set(alias.toLowerCase(), code);
                }
            }
        }

        logger.info('Country catalog indexed', {
            totalCountries: this._countryMap.size,
            aliasesIndexed: this._nameIndex.size - this._countryMap.size
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Tier-Aware Country Listing
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Validate service identifier
     */
    _validateService(service) {
        if (!service || typeof service !== 'string') {
            throw new Error('INVALID_SERVICE: service must be a non-empty string');
        }
        return service.trim();
    }

    /**
     * Get countries for a service, sorted by tier-aware pricing
     */
    async getCountriesForService(service, tierKey, options = {}) {
        const validatedService = this._validateService(service);

        const {
            page = 1,
            perPage = PAGINATION.countriesPerPage,
            searchQuery = null,
            topOnly = false
        } = options;

        const tier = TIER_CONFIG[tierKey];
        if (!tier) {
            throw new Error(`INVALID_TIER: ${tierKey}`);
        }

        if (!Number.isInteger(page) || page < 1) {
            throw new Error(`INVALID_PAGE: page must be a positive integer, got ${page}`);
        }
        if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
            throw new Error(`INVALID_PER_PAGE: perPage must be 1-100, got ${perPage}`);
        }

        // Determine which countries to check
        let countryCodes;
        if (searchQuery) {
            countryCodes = this._searchCountries(searchQuery);
        } else if (topOnly) {
            countryCodes = TOP_COUNTRIES.filter(code => this._countryMap.has(code));
        } else {
            countryCodes = Array.from(this._countryMap.keys());
        }

        if (countryCodes.length === 0) {
            return {
                countries: [],
                pagination: { page: 1, perPage, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
                tierInfo: this.tierSelector.getTierInfo(tierKey),
                searchQuery: searchQuery || null
            };
        }

        // Fetch live prices for these countries (parallel, batched)
        const countriesWithPrices = await this._fetchCountryPrices(
            countryCodes, validatedService, tierKey, tier
        );

        // Sort: cheapest first, then by stock (null prices last)
        countriesWithPrices.sort((a, b) => {
            const aHasPrice = a.price !== null && a.price !== undefined;
            const bHasPrice = b.price !== null && b.price !== undefined;
            if (aHasPrice && bHasPrice) return a.price - b.price;
            if (aHasPrice) return -1;
            if (bHasPrice) return 1;
            return (b.stock || 0) - (a.stock || 0);
        });

        // Paginate
        const total = countriesWithPrices.length;
        const start = (page - 1) * perPage;
        const end = Math.min(start + perPage, total);
        const pageCountries = countriesWithPrices.slice(start, end);

        return {
            countries: pageCountries,
            pagination: {
                page,
                perPage,
                total,
                totalPages: Math.ceil(total / perPage),
                hasNext: end < total,
                hasPrev: page > 1
            },
            tierInfo: this.tierSelector.getTierInfo(tierKey),
            searchQuery: searchQuery || null
        };
    }

    async getTopCountries(service, tierKey, limit = 20) {
        return this.getCountriesForService(service, tierKey, {
            topOnly: true,
            perPage: limit,
            page: 1
        });
    }

    searchCountries(query) {
        if (!query || typeof query !== 'string') return [];
        return this._searchCountries(query);
    }

    getCountry(code) {
        if (!code || typeof code !== 'string') return undefined;
        return this._countryMap.get(code.toUpperCase());
    }

    hasCountry(code) {
        if (!code || typeof code !== 'string') return false;
        return this._countryMap.has(code.toUpperCase());
                              }
                        // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Price Fetching (Improved)
    // ═══════════════════════════════════════════════════════════════════════

    async _fetchCountryPrices(countryCodes, service, tierKey, tier) {
        const cacheKey = makeCacheKey(tierKey, service, countryCodes);
        const cached = this._priceCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL.tierPrices) {
            logger.debug('Cache hit for country prices', { cacheKey, count: cached.data.length });
            return cached.data;
        }

        const batchSize = 10;
        const results = [];
        const errors = []; // Collect errors for logging, not swallowing

        for (let i = 0; i < countryCodes.length; i += batchSize) {
            const batch = countryCodes.slice(i, i + batchSize);

            const batchPromises = batch.map(async (code) => {
                const country = this._countryMap.get(code);
                if (!country) {
                    logger.warn('Unknown country code in batch', { code });
                    return null;
                }

                try {
                    const selection = await this.tierSelector.selectOperator(
                        tierKey, code, service, { timeoutMs: 8000 }
                    );

                    return {
                        code,
                        name: country.name,
                        flag: country.flag || isoToFlag(code),
                        price: selection.price,
                        displayPrice: selection.displayPrice,
                        price: selection.price ?? null,
                        displayPrice: selection.displayPrice ?? null,
                        stock: selection.stock ?? 0,
                        operator: selection.operator ?? null,
                        score: selection.score ?? 0,
                        currency: 'USD',
                        available: true
                    };

                } catch (error) {
                    const noStock = isNoStockError(error);

                    // Log at appropriate level based on error type
                    if (noStock) {
                        logger.debug('No stock for country/service', { code, service, tierKey });
                    } else {
                        logger.warn('Price fetch failed for country', {
                            code,
                            service,
                            tierKey,
                            error: error.message,
                            stack: error.stack
                        });
                        errors.push({ code, error: error.message });
                    }

                    return {
                        code,
                        name: country.name,
                        flag: country.flag || isoToFlag(code),
                        price: null,
                        displayPrice: null,
                        stock: 0,
                        operator: null,
                        score: 0,
                        currency: 'USD',
                        available: false,
                        unavailableReason: noStock ? 'no_stock' : 'error',
                        retryable: !noStock  // transient errors can be retried
                    };
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);

            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value !== null) {
                    results.push(result.value);
                }
            }

            // Adaptive delay: only sleep if more batches remain
            if (i + batchSize < countryCodes.length) {
                await new Promise(r => setTimeout(r, 100));
            }
        }

        // Log summary if there were errors
        if (errors.length > 0) {
            logger.info('Country price fetch completed with errors', {
                totalRequested: countryCodes.length,
                successful: results.filter(r => r.available).length,
                failed: errors.length,
                sampleErrors: errors.slice(0, 5)
            });
        }

        // Cache and enforce size limit
        this._setCacheEntry(cacheKey, results);

        return results;
    }

    _setCacheEntry(key, data) {
        // Evict oldest entries if at capacity
        if (this._priceCache.size >= this._maxCacheSize) {
            const oldestKey = this._priceCache.keys().next().value;
            this._priceCache.delete(oldestKey);
            logger.debug('Evicted oldest cache entry', { evictedKey: oldestKey });
        }

        this._priceCache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Search (Single Source of Truth)
    // ═══════════════════════════════════════════════════════════════════════

    _searchCountries(query) {
        const normalized = query.toLowerCase().trim();
        if (!normalized) return [];

        // Direct ISO match
        const upperCode = normalized.toUpperCase();
        if (this._countryMap.has(upperCode)) {
            return [upperCode];
        }

        // Alias match
        if (COUNTRY_ALIASES[normalized]) {
            return [COUNTRY_ALIASES[normalized]];
        }

        // Prefix/substring match against unified name index
        const matches = new Set();
        for (const [name, code] of this._nameIndex) {
            if (name.includes(normalized) || normalized.includes(name)) {
                matches.add(code);
            }
        }

        // Also match against native country names (catches entries not in _nameIndex)
        for (const country of COUNTRIES) {
            if (country?.name?.toLowerCase().includes(normalized)) {
                matches.add(country.code.toUpperCase());
            }
        }

        return Array.from(matches);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CACHE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    clearCache() {
        const size = this._priceCache.size;
        this._priceCache.clear();
        logger.info('CountryCatalog cache cleared', { entriesRemoved: size });
    }

    /**
     * Remove cache entries for a specific service (selective invalidation)
     */
    invalidateService(service) {
        const validated = this._validateService(service);
        let removed = 0;
        for (const key of this._priceCache.keys()) {
            if (key.includes(`:${validated}:`)) {
                this._priceCache.delete(key);
                removed++;
            }
        }
        logger.info('Invalidated service cache', { service: validated, entriesRemoved: removed });
        return removed;
    }

    /**
     * Get cache statistics for monitoring
     */
    getCacheStats() {
        return {
            size: this._priceCache.size,
            maxSize: this._maxCacheSize,
            keys: Array.from(this._priceCache.keys())
        };
    }
}

export default CountryCatalog;
                
