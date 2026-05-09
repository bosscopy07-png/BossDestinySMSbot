// ═══════════════════════════════════════════════════════════════════════════════
//  services/CountryCatalog.js — Country Discovery with Live Pricing & Search
//  Handles 120+ countries without loading all at once
// ═══════════════════════════════════════════════════════════════════════════════

import { TOP_COUNTRIES, COUNTRY_ALIASES, PAGINATION, CACHE_TTL, TIER_CONFIG } from '../config/tierConfig.js';
import { COUNTRIES } from '../utils/constants.js';
import logger from '../utils/logger.js';

/**
 * CountryCatalog — Manages country listing with live pricing, search, and pagination
 * 
 * Performance:
 *   - Caches tier-specific pricing
 *   - Parallel price queries for displayed countries
 *   - Search by name, ISO code, or alias
 */
class CountryCatalog {
    constructor(cheapPanelProvider, tierSelector) {
        this.provider = cheapPanelProvider;
        this.tierSelector = tierSelector;
        
        // Build country index
        this._countryMap = new Map();      // iso -> country data
        this._nameIndex = new Map();       // normalized name -> iso
        this._buildIndex();

        // Price cache: key = `${tierKey}:${service}:${countryListHash}` -> { countries[], timestamp }
        this._priceCache = new Map();
    }

    _buildIndex() {
        for (const country of COUNTRIES) {
            this._countryMap.set(country.code.toUpperCase(), country);
            this._nameIndex.set(country.name.toLowerCase(), country.code);
            
            // Index aliases
            const aliases = Object.entries(COUNTRY_ALIASES)
                .filter(([_, code]) => code === country.code)
                .map(([alias, _]) => alias);
            
            for (const alias of aliases) {
                this._nameIndex.set(alias.toLowerCase(), country.code);
            }
        }

        logger.info('Country catalog indexed', { 
            totalCountries: COUNTRIES.length,
            aliases: Object.keys(COUNTRY_ALIASES).length
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Tier-Aware Country Listing
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get countries for a service, sorted by tier-aware pricing
     * 
     * @param {string} service - Service name
     * @param {string} tierKey - 'budget' | 'standard' | 'premium'
     * @param {Object} options - { page, perPage, searchQuery, topOnly }
     * @returns {Promise<{countries: Array, pagination: Object, tierInfo: Object}>}
     */
    async getCountriesForService(service, tierKey, options = {}) {
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
                tierInfo: this.tierSelector.getTierInfo(tierKey) 
            };
        }

        // Fetch live prices for these countries (parallel, batched)
        const countriesWithPrices = await this._fetchCountryPrices(
            countryCodes, service, tierKey, tier
        );

        // Sort: cheapest first, then by stock
        countriesWithPrices.sort((a, b) => {
            if (a.price !== null && b.price !== null) return a.price - b.price;
            if (a.price !== null) return -1;
            if (b.price !== null) return 1;
            return b.stock - a.stock;
        });

        // Paginate
        const total = countriesWithPrices.length;
        const start = (page - 1) * perPage;
        const end = start + perPage;
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

    /**
     * Get top countries with pricing (for initial display)
     */
    async getTopCountries(service, tierKey, limit = 20) {
        return this.getCountriesForService(service, tierKey, {
            topOnly: true,
            perPage: limit,
            page: 1
        });
    }

    /**
     * Search countries by name or ISO code
     */
    searchCountries(query) {
        return this._searchCountries(query);
    }

    /**
     * Get country by ISO code
     */
    getCountry(code) {
        return this._countryMap.get(code.toUpperCase());
    }

    /**
     * Check if country exists
     */
    hasCountry(code) {
        return this._countryMap.has(code.toUpperCase());
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Price Fetching
    // ═══════════════════════════════════════════════════════════════════════

    async _fetchCountryPrices(countryCodes, service, tierKey, tier) {
        const cacheKey = `${tierKey}:${service}:${countryCodes.sort().join(',')}`;
        const cached = this._priceCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL.tierPrices) {
            return cached.data;
        }

        // Batch requests: process in groups of 10 to avoid overwhelming the API
        const batchSize = 10;
        const results = [];

        for (let i = 0; i < countryCodes.length; i += batchSize) {
            const batch = countryCodes.slice(i, i + batchSize);
            const batchPromises = batch.map(async (code) => {
                const country = this._countryMap.get(code);
                if (!country) return null;

                try {
                    // Use tier selector to get best operator and price for this country
                    const selection = await this.tierSelector.selectOperator(
                        tierKey, code, service, { timeoutMs: 8000 }
                    );

                    return {
                        code,
                        name: country.name,
                        flag: country.flag || this._getFlag(code),
                        price: selection.price,
                        displayPrice: selection.displayPrice,
                        stock: selection.stock,
                        operator: selection.operator,
                        score: selection.score,
                        currency: 'USD'
                    };

                } catch (error) {
                    // No stock or error — still include country but mark as unavailable
                    return {
                        code,
                        name: country.name,
                        flag: country.flag || this._getFlag(code),
                        price: null,
                        displayPrice: null,
                        stock: 0,
                        operator: null,
                        score: 0,
                        currency: 'USD',
                        unavailable: true,
                        unavailableReason: error.message?.includes('TIER_NO_STOCK') ? 'no_stock' : 'error'
                    };
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);
            results.push(...batchResults
                .filter(r => r.status === 'fulfilled' && r.value !== null)
                .map(r => r.value)
            );

            // Small delay between batches to be nice to the API
            if (i + batchSize < countryCodes.length) {
                await new Promise(r => setTimeout(r, 100));
            }
        }

        // Cache results
        this._priceCache.set(cacheKey, {
            data: results,
            timestamp: Date.now()
        });

        // Cleanup old cache
        this._cleanupCache();

        return results;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Search
    // ═══════════════════════════════════════════════════════════════════════

    _searchCountries(query) {
        const normalized = query.toLowerCase().trim();
        
        // Direct ISO match
        if (this._countryMap.has(normalized.toUpperCase())) {
            return [normalized.toUpperCase()];
        }

        // Alias match
        if (COUNTRY_ALIASES[normalized]) {
            return [COUNTRY_ALIASES[normalized]];
        }

        // Name prefix/substring match
        const matches = [];
        for (const [name, code] of this._nameIndex) {
            if (name.includes(normalized) || normalized.includes(name)) {
                matches.push(code);
            }
        }

        // Also check country names from COUNTRIES array
        for (const country of COUNTRIES) {
            if (country.name.toLowerCase().includes(normalized)) {
                matches.push(country.code);
            }
        }

        return [...new Set(matches)]; // Deduplicate
    }

    _getFlag(code) {
        // Convert ISO code to regional indicator symbols
        const OFFSET = 127397;
        const cc = code.toUpperCase();
        if (cc.length !== 2) return '🌍';
        return String.fromCodePoint(cc.charCodeAt(0) + OFFSET) + String.fromCodePoint(cc.charCodeAt(1) + OFFSET);
    }

    _cleanupCache() {
        const now = Date.now();
        for (const [key, entry] of this._priceCache) {
            if (now - entry.timestamp > CACHE_TTL.tierPrices * 3) {
                this._priceCache.delete(key);
            }
        }
    }

    /**
     * Clear all price caches
     */
    clearCache() {
        this._priceCache.clear();
        logger.info('CountryCatalog cache cleared');
    }
}

export default CountryCatalog;
