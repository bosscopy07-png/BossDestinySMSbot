// ═══════════════════════════════════════════════════════════════════════════════
//  services/CountryCatalog.js — Country Discovery with Live Pricing & Search
//  DYNAMIC: Uses CheapPanelProvider.getAvailableCountries() as single source of truth
//  No hardcoded COUNTRIES import. Backfills top countries to reach minAvailable.
// ═══════════════════════════════════════════════════════════════════════════════

import { TOP_COUNTRIES, COUNTRY_ALIASES, PAGINATION, CACHE_TTL, TIER_CONFIG } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate stable cache key
 */
function makeCacheKey(tierKey, service, countryCodes) {
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
        error.message.includes('NOT_AVAILABLE') ||
        error.message.includes('BAD_COUNTRY') ||
        error.message.includes('BAD_SERVICE')
    );
}

/**
 * Convert ISO code to emoji flag
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

        // Dynamic country index — populated from provider, NOT hardcoded
        this._countryMap = new Map();      // iso -> { code, name, flag }
        this._nameIndex = new Map();       // normalized name -> iso
        this._aliasMap = new Map();        // alias -> iso

        // Available countries cache per service: service -> { countries[], timestamp }
        this._availableCache = new Map();
        this._availableCacheTtl = CACHE_TTL.tierPrices || 2 * 60 * 1000; // 2 minutes default

        // Price cache for specific country/service/tier combos
        this._priceCache = new Map();
        this._maxPriceCacheSize = 200;

        // Build alias index from config (aliases are static)
        this._buildAliasIndex();

        logger.info('CountryCatalog initialized', {
            provider: cheapPanelProvider.name || 'unknown',
            providerActive: cheapPanelProvider.isActive
        });
    }

    _buildAliasIndex() {
        for (const [alias, isoCode] of Object.entries(COUNTRY_ALIASES)) {
            this._aliasMap.set(alias.toLowerCase(), isoCode.toUpperCase());
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  DYNAMIC CATALOG LOADING
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Fetch available countries for a service from 5SIM
     * This is the SINGLE SOURCE OF TRUTH for country availability
     */
    async _loadAvailableCountries(service) {
        const normalizedService = this._normalizeService(service);
        const cacheKey = normalizedService;

        // Check cache
        const cached = this._availableCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this._availableCacheTtl) {
            logger.debug('Using cached available countries', { service: normalizedService, count: cached.countries.length });
            return cached.countries;
        }

        // Fetch from provider
        const result = await this.provider.getAvailableCountries(normalizedService);

        if (!result.success || !result.countries) {
            logger.error('Failed to load available countries', { service: normalizedService, error: result.error });
            return [];
        }

        // Update dynamic index
        const countries = result.countries.map(c => ({
            code: c.code.toUpperCase(),
            name: c.name,
            flag: isoToFlag(c.code),
            simCode: c.simCode
        }));

        // Rebuild indexes with fresh data
        this._rebuildCountryIndex(countries);

        // Cache
        this._availableCache.set(cacheKey, {
            countries,
            timestamp: Date.now()
        });

        logger.info('Loaded available countries from provider', {
            service: normalizedService,
            count: countries.length,
            sample: countries.slice(0, 5).map(c => c.code)
        });

        return countries;
    }

    _rebuildCountryIndex(countries) {
        this._countryMap.clear();
        this._nameIndex.clear();

        for (const country of countries) {
            this._countryMap.set(country.code, country);
            this._nameIndex.set(country.name.toLowerCase(), country.code);

            // Also index aliases that point to this country
            for (const [alias, isoCode] of this._aliasMap.entries()) {
                if (isoCode === country.code) {
                    this._nameIndex.set(alias, country.code);
                }
            }
        }
    }

    _normalizeService(service) {
        if (!service || typeof service !== 'string') return 'other';
        return service.trim();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get countries for a service with availability backfill
     * 
     * @param {string} service - Service name (e.g., 'whatsapp', 'telegram')
     * @param {string} tierKey - 'budget' | 'standard' | 'premium'
     * @param {Object} options
     *   @param {number} options.page - Page number
     *   @param {number} options.perPage - Items per page
     *   @param {string|null} options.searchQuery - Search by name/ISO/alias
     *   @param {boolean} options.topOnly - Prefer top countries, backfill if sparse
     *   @param {number} options.minAvailable - Minimum available countries (default: 20)
     */
    async getCountriesForService(service, tierKey, options = {}) {
        const normalizedService = this._normalizeService(service);

        const {
            page = 1,
            perPage = PAGINATION.countriesPerPage,
            searchQuery = null,
            topOnly = false,
            minAvailable = 20
        } = options;

        const tier = TIER_CONFIG[tierKey];
        if (!tier) {
            throw new Error(`INVALID_TIER: ${tierKey}`);
        }

        if (!Number.isInteger(page) || page < 1) {
            throw new Error(`INVALID_PAGE: page must be positive integer, got ${page}`);
        }
        if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
            throw new Error(`INVALID_PER_PAGE: perPage must be 1-100, got ${perPage}`);
        }

        // ── Load dynamic catalog for this service ──
        const availableCountries = await this._loadAvailableCountries(normalizedService);
        const availableCodes = new Set(availableCountries.map(c => c.code));

        if (availableCountries.length === 0) {
            return {
                countries: [],
                pagination: { page: 1, perPage, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
                tierInfo: this.tierSelector.getTierInfo(tierKey),
                service: normalizedService,
                message: `No countries available for ${normalizedService} at this time.`
            };
        }

        // ── Determine which country codes to check ──
        let countryCodes;
        let isSearchMode = false;

        if (searchQuery) {
            countryCodes = this._searchCountries(searchQuery, availableCodes);
            isSearchMode = true;
        } else if (topOnly) {
            // Start with TOP_COUNTRIES that are available for this service
            countryCodes = TOP_COUNTRIES.filter(code => availableCodes.has(code));
        } else {
            // All available countries
            countryCodes = Array.from(availableCodes);
        }

        // ── Search mode: handle explicit unavailability ──
        if (isSearchMode) {
            // Check if search matched countries NOT available for this service
            const allMatches = this._searchAllMatches(searchQuery); // Includes unavailable
            const unavailableMatches = allMatches.filter(code => !availableCodes.has(code));

            if (countryCodes.length === 0 && unavailableMatches.length > 0) {
                // User searched a valid country, but it's not available for this service
                const unavailableCountries = unavailableMatches.map(code => ({
                    code,
                    name: this._getCountryName(code),
                    flag: isoToFlag(code),
                    price: null,
                    displayPrice: null,
                    stock: 0,
                    operator: null,
                    score: 0,
                    currency: 'USD',
                    available: false,
                    unavailableReason: 'service_not_available',
                    message: `${this._getCountryName(code)} is not available for ${normalizedService}. Try another service or country.`
                }));

                return {
                    countries: unavailableCountries,
                    pagination: { page: 1, perPage, total: unavailableCountries.length, totalPages: 1, hasNext: false, hasPrev: false },
                    tierInfo: this.tierSelector.getTierInfo(tierKey),
                    service: normalizedService,
                    searchQuery: searchQuery.trim(),
                    searchMatched: true,
                    allUnavailable: true,
                    message: `The country you searched is not available for ${normalizedService}. Try another service or country.`
                };
            }

            if (countryCodes.length === 0) {
                return {
                    countries: [],
                    pagination: { page: 1, perPage, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
                    tierInfo: this.tierSelector.getTierInfo(tierKey),
                    service: normalizedService,
                    searchQuery: searchQuery.trim(),
                    searchMatched: false,
                    message: `No countries found matching "${searchQuery}" for ${normalizedService}.`
                };
            }
        }

        // ── Backfill for topOnly mode ──
        if (topOnly && !isSearchMode) {
            const backfillCodes = this._computeBackfill(countryCodes, availableCodes, minAvailable);
            countryCodes = backfillCodes;
        }

        // ── Fetch live prices ──
        const countriesWithPrices = await this._fetchCountryPrices(
            countryCodes,
            normalizedService,
            tierKey,
            tier
        );

        // Sort: available first (cheapest), then unavailable
        countriesWithPrices.sort((a, b) => {
            if (a.available && !b.available) return -1;
            if (!a.available && b.available) return 1;
            if (a.available && b.available) {
                if (a.price !== null && b.price !== null) return a.price - b.price;
                if (a.price !== null) return -1;
                if (b.price !== null) return 1;
            }
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
            service: normalizedService,
            searchQuery: searchQuery || null,
            searchMatched: isSearchMode ? true : null,
            allUnavailable: isSearchMode ? pageCountries.every(c => !c.available) : null
        };
    }

    /**
     * Get top countries with backfill guarantee
     */
    async getTopCountries(service, tierKey, limit = 20) {
        return this.getCountriesForService(service, tierKey, {
            topOnly: true,
            perPage: limit,
            page: 1,
            minAvailable: limit
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
    //  INTERNAL — Backfill Logic
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Compute backfill: if top countries < minAvailable, add more available countries
     * Preserves top country priority order, appends backfill by catalog order
     */
    _computeBackfill(topCodes, availableCodes, minAvailable) {
        if (topCodes.length >= minAvailable) {
            return topCodes; // Sufficient top countries available
        }

        const needed = minAvailable - topCodes.length;
        const result = [...topCodes];
        const added = new Set(topCodes);

        // Add remaining available countries in provider catalog order
        for (const code of availableCodes) {
            if (added.has(code)) continue;
            result.push(code);
            added.add(code);
            if (result.length >= minAvailable) break;
        }

        logger.info('Backfilled countries', {
            topAvailable: topCodes.length,
            needed,
            backfilledTo: result.length,
            totalAvailable: availableCodes.size
        });

        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Price Fetching
    // ═══════════════════════════════════════════════════════════════════════

    async _fetchCountryPrices(countryCodes, service, tierKey, tier) {
        const cacheKey = makeCacheKey(tierKey, service, countryCodes);
        const cached = this._priceCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL.tierPrices) {
            return cached.data;
        }

        const batchSize = 10;
        const results = [];
        const errors = [];

        for (let i = 0; i < countryCodes.length; i += batchSize) {
            const batch = countryCodes.slice(i, i + batchSize);

            const batchPromises = batch.map(async (code) => {
                const country = this._countryMap.get(code);
                if (!country) {
                    logger.warn('Country not in dynamic index', { code, service });
                    return null;
                }

                try {
                    const selection = await this.tierSelector.selectOperator(
                        tierKey, code, service, { timeoutMs: 8000 }
                    );

                    return {
                        code,
                        name: country.name,
                        flag: country.flag,
                        price: selection.price ?? null,
                        displayPrice: selection.displayPrice ?? null,
                        stock: selection.stock ?? 0,
                        operator: selection.operator,
                        score: selection.score ?? 0,
                        currency: 'USD',
                        available: true
                    };

                } catch (error) {
                    const noStock = isNoStockError(error);

                    if (noStock) {
                        logger.debug('No stock for country/service', { code, service, tierKey });
                    } else {
                        logger.warn('Price fetch failed', { code, service, tierKey, error: error.message });
                        errors.push({ code, error: error.message });
                    }

                    return {
                        code,
                        name: country.name,
                        flag: country.flag,
                        price: null,
                        displayPrice: null,
                        stock: 0,
                        operator: null,
                        score: 0,
                        currency: 'USD',
                        available: false,
                        unavailableReason: noStock ? 'no_stock' : 'error',
                        retryable: !noStock
                    };
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);

            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value !== null) {
                    results.push(result.value);
                }
            }

            if (i + batchSize < countryCodes.length) {
                await new Promise(r => setTimeout(r, 100));
            }
        }

        if (errors.length > 0) {
            logger.info('Price fetch summary', {
                total: countryCodes.length,
                successful: results.filter(r => r.available).length,
                failed: errors.length
            });
        }

        this._setPriceCacheEntry(cacheKey, results);
        return results;
    }

    _setPriceCacheEntry(key, data) {
        if (this._priceCache.size >= this._maxPriceCacheSize) {
            const oldestKey = this._priceCache.keys().next().value;
            this._priceCache.delete(oldestKey);
        }
        this._priceCache.set(key, { data, timestamp: Date.now() });
    }
        // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Search
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Search countries available for the service
     */
    _searchCountries(query, availableCodes = null) {
        const normalized = query.toLowerCase().trim();
        if (!normalized) return [];

        const matches = new Set();

        // Direct ISO match
        const upperCode = normalized.toUpperCase();
        if (this._countryMap.has(upperCode)) {
            if (!availableCodes || availableCodes.has(upperCode)) {
                matches.add(upperCode);
            }
        }

        // Alias match
        if (this._aliasMap.has(normalized)) {
            const aliasCode = this._aliasMap.get(normalized);
            if (!availableCodes || availableCodes.has(aliasCode)) {
                matches.add(aliasCode);
            }
        }

        // Name prefix/substring match
        for (const [name, code] of this._nameIndex) {
            if (name.includes(normalized) || normalized.includes(name)) {
                if (!availableCodes || availableCodes.has(code)) {
                    matches.add(code);
                }
            }
        }

        return Array.from(matches);
    }

    /**
     * Search ALL matches including unavailable (for unavailability messaging)
     */
    _searchAllMatches(query) {
        const normalized = query.toLowerCase().trim();
        if (!normalized) return [];

        const matches = new Set();

        // Direct ISO
        const upperCode = normalized.toUpperCase();
        if (this._countryMap.has(upperCode)) matches.add(upperCode);

        // Alias
        if (this._aliasMap.has(normalized)) matches.add(this._aliasMap.get(normalized));

        // Name match
        for (const [name, code] of this._nameIndex) {
            if (name.includes(normalized) || normalized.includes(name)) {
                matches.add(code);
            }
        }

        return Array.from(matches);
    }

    _getCountryName(code) {
        const country = this._countryMap.get(code.toUpperCase());
        return country?.name || code;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CACHE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    clearCache() {
        const priceSize = this._priceCache.size;
        const availableSize = this._availableCache.size;
        this._priceCache.clear();
        this._availableCache.clear();
        logger.info('CountryCatalog caches cleared', { priceEntries: priceSize, availableEntries: availableSize });
    }

    /**
     * Invalidate available countries cache for a specific service
     */
    invalidateService(service) {
        const normalized = this._normalizeService(service);
        const removed = this._availableCache.delete(normalized);
        logger.info('Invalidated service cache', { service: normalized, wasCached: removed });
        return removed;
    }

    getCacheStats() {
        return {
            priceCacheSize: this._priceCache.size,
            priceCacheMax: this._maxPriceCacheSize,
            availableCacheSize: this._availableCache.size,
            availableCacheKeys: Array.from(this._availableCache.keys())
        };
    }
}

export default CountryCatalog;
