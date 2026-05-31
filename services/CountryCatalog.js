// ═══════════════════════════════════════════════════════════════════════════════
//  services/CountryCatalog.js — Country Discovery with Live Pricing & Search
//  DYNAMIC: Uses provider catalog as single source of truth
//  FIXED:
//   1. Uses cached catalog instead of live API calls for prices
//   2. Checks ALL providers for cheapest price per country
//   3. Cache TTL: 60 minutes
//   4. Batch price fetching from cached data
// ═══════════════════════════════════════════════════════════════════════════════

import { TOP_COUNTRIES, COUNTRY_ALIASES, PAGINATION, CACHE_TTL, TIER_CONFIG } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

function makeCacheKey(tierKey, service, countryCodes) {
    const sorted = countryCodes.slice().sort();
    return `${tierKey}:${service}:${sorted.join(',')}`;
}

function isNoStockError(error) {
    if (!error || !error.message) return false;
    return (
        error.message.includes('TIER_NO_STOCK') ||
        error.message.includes('NO_SERVICE') ||
        error.message.includes('NOT_AVAILABLE') ||
        error.message.includes('BAD_COUNTRY') ||
        error.message.includes('BAD_SERVICE') ||
        error.message.includes('NO_NUMBERS')
    );
}

function isoToFlag(code) {
    if (!code || typeof code !== 'string' || code.length !== 2) return '🌍';
    const cc = code.toUpperCase();
    const OFFSET = 127397;
    try {
        return String.fromCodePoint(cc.charCodeAt(0) + OFFSET) + String.fromCodePoint(cc.charCodeAt(1) + OFFSET);
    } catch {
        return '🌍';
    }
}

class CountryCatalog {
    constructor(cheapPanelProvider, tierSelector) {
        if (!cheapPanelProvider || !tierSelector) {
            throw new Error('CountryCatalog requires both cheapPanelProvider and tierSelector');
        }

        this.provider = cheapPanelProvider;
        this.tierSelector = tierSelector;

        this._countryMap = new Map();
        this._nameIndex = new Map();
        this._aliasMap = new Map();

        this._availableCache = new Map();
        this._availableCacheTtl = CACHE_TTL.countryStock || 60 * 60 * 1000;

        this._priceCache = new Map();
        this._maxPriceCacheSize = 500;

        this._buildAliasIndex();

        logger.info('CountryCatalog initialized', {
            provider: cheapPanelProvider.name || 'unknown',
            providerActive: cheapPanelProvider.isActive,
            cacheTtl: '60min'
        });
    }

    _buildAliasIndex() {
        for (const [alias, isoCode] of Object.entries(COUNTRY_ALIASES)) {
            this._aliasMap.set(alias.toLowerCase(), isoCode.toUpperCase());
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  DYNAMIC CATALOG LOADING (cached 60min)
    // ═══════════════════════════════════════════════════════════════════════

    async _loadAvailableCountries(service) {
        const normalizedService = this._normalizeService(service);
        const cacheKey = normalizedService;

        const cached = this._availableCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this._availableCacheTtl) {
            return cached.countries;
        }

        const result = await this.provider.getAvailableCountries(normalizedService);

        if (!result.success || !result.countries) {
            logger.error('Failed to load available countries', { service: normalizedService, error: result.error });
            return [];
        }

        const countries = result.countries.map(c => ({
            code: c.code.toUpperCase(),
            name: c.name,
            flag: isoToFlag(c.code),
            simCode: c.simCode
        }));

        this._rebuildCountryIndex(countries);

        this._availableCache.set(cacheKey, { countries, timestamp: Date.now() });

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
        if (!tier) throw new Error(`INVALID_TIER: ${tierKey}`);
        if (!Number.isInteger(page) || page < 1) throw new Error(`INVALID_PAGE: ${page}`);
        if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error(`INVALID_PER_PAGE: ${perPage}`);

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

        let countryCodes;
        let isSearchMode = false;

        if (searchQuery) {
            countryCodes = this._searchCountries(searchQuery, availableCodes);
            isSearchMode = true;
        } else if (topOnly) {
            countryCodes = TOP_COUNTRIES.filter(code => availableCodes.has(code));
        } else {
            countryCodes = Array.from(availableCodes);
        }

        if (isSearchMode) {
            const allMatches = this._searchAllMatches(searchQuery);
            const unavailableMatches = allMatches.filter(code => !availableCodes.has(code));

            if (countryCodes.length === 0 && unavailableMatches.length > 0) {
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

        if (topOnly && !isSearchMode) {
            const backfillCodes = this._computeBackfill(countryCodes, availableCodes, minAvailable, normalizedService);
            countryCodes = backfillCodes;
        }

        // FIXED: Use cached tier selector instead of live API calls
        const countriesWithPrices = await this._fetchCountryPricesFromCache(countryCodes, normalizedService, tierKey, tier);

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

    _computeBackfill(topCodes, availableCodes, minAvailable, service = 'unknown') {
        if (topCodes.length >= minAvailable) return topCodes;

        const needed = minAvailable - topCodes.length;
        const result = [...topCodes];
        const added = new Set(topCodes);

        for (const code of availableCodes) {
            if (added.has(code)) continue;
            result.push(code);
            added.add(code);
            if (result.length >= minAvailable) break;
        }

        logger.info('Backfilled countries', {
            service,
            topAvailable: topCodes.length,
            needed,
            backfilledTo: result.length,
            totalAvailable: availableCodes.size
        });

        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FIXED: Price fetching from cache instead of live API
    // ═══════════════════════════════════════════════════════════════════════

    async _fetchCountryPricesFromCache(countryCodes, service, tierKey, tier) {
        const cacheKey = makeCacheKey(tierKey, service, countryCodes);
        const cached = this._priceCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL.tierPrices) {
            return cached.data;
        }

        const results = [];
        const errors = [];

        // Use tierSelector to get prices from ALL providers (cached)
        for (const code of countryCodes) {
            try {
                const selection = await this.tierSelector.selectOperator(
                    tierKey, code, service, { timeoutMs: 8000 }
                );

                const country = this._countryMap.get(code);
                
                results.push({
                    code,
                    name: country?.name || code,
                    flag: country?.flag || isoToFlag(code),
                    price: selection.displayPrice ?? null,
                    displayPrice: selection.displayPrice ?? null,
                    rawPrice: selection.price ?? null,
                    stock: selection.stock ?? 0,
                    operator: selection.operator,
                    score: selection.score ?? 0,
                    currency: 'USD',
                    available: true,
                    provider: selection.providerKey
                });

            } catch (error) {
                const noStock = isNoStockError(error);
                const country = this._countryMap.get(code);

                if (!noStock) {
                    logger.warn('Price fetch failed', { code, service, tierKey, error: error.message });
                    errors.push({ code, error: error.message });
                }

                results.push({
                    code,
                    name: country?.name || code,
                    flag: country?.flag || isoToFlag(code),
                    price: null,
                    displayPrice: null,
                    rawPrice: null,
                    stock: 0,
                    operator: null,
                    score: 0,
                    currency: 'USD',
                    available: false,
                    unavailableReason: noStock ? 'no_stock' : 'error',
                    retryable: !noStock
                });
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

    _searchCountries(query, availableCodes = null) {
        const normalized = query.toLowerCase().trim();
        if (!normalized) return [];

        const matches = new Set();

        const upperCode = normalized.toUpperCase();
        if (this._countryMap.has(upperCode)) {
            if (!availableCodes || availableCodes.has(upperCode)) matches.add(upperCode);
        }

        if (this._aliasMap.has(normalized)) {
            const aliasCode = this._aliasMap.get(normalized);
            if (!availableCodes || availableCodes.has(aliasCode)) matches.add(aliasCode);
        }

        for (const [name, code] of this._nameIndex) {
            if (name.includes(normalized) || normalized.includes(name)) {
                if (!availableCodes || availableCodes.has(code)) matches.add(code);
            }
        }

        return Array.from(matches);
    }

    _searchAllMatches(query) {
        const normalized = query.toLowerCase().trim();
        if (!normalized) return [];

        const matches = new Set();

        const upperCode = normalized.toUpperCase();
        if (this._countryMap.has(upperCode)) matches.add(upperCode);

        if (this._aliasMap.has(normalized)) matches.add(this._aliasMap.get(normalized));

        for (const [name, code] of this._nameIndex) {
            if (name.includes(normalized) || normalized.includes(name)) matches.add(code);
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
                                 
