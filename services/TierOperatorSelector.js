// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierOperatorSelector.js — Tier Operator Selection
//  COMPLETE REWRITE:
//   1. FIXED: Queries ALL virtuals in tier range for a country/service
//   2. FIXED: Aggregates results from ALL providers, not just first match
//   3. FIXED: Cross-operator fallback — if virtual3 fails, tries virtual7, 12, 19...
//   4. FIXED: Country availability checks ALL tier virtuals, not just one
//   5. Cache TTL: 60 minutes to prevent rate limits
//   6. Preserves original service name throughout flow
//   7. FIXED SCORING: Normalized 0-100 with proper tier logic and weights
// ═══════════════════════════════════════════════════════════════════════════════

import { TIER_CONFIG, CACHE_TTL } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

/**
 * TierOperatorSelector — Selects best operator per tier from live provider data
 * 
 * CORE FIX: Instead of picking one virtual and checking its countries,
 * we now query the provider catalog for a specific country+service,
 * then filter ALL returned virtual operators by tier range.
 * This means if virtual3 has no stock for US but virtual7 does,
 * we find virtual7 and use it.
 * 
 * Features:
 *   - Fetches full price catalog per provider (cached 60min)
 *   - For a given country/service, gets ALL virtual operators from provider
 *   - Filters to only those in the requested tier's range
 *   - Scores ALL matching operators across ALL providers
 *   - Picks the single best one (cheapest for budget, balanced for standard, newest for premium)
 *   - Cross-operator fallback: if best fails, tries next best in same tier
 *   - Cross-provider fallback: aggregates results from ALL providers
 */
class TierOperatorSelector {
    constructor(providers = []) {
        this.providers = providers.filter(p => p?.isActive);
        
        // Cache for operator selections
        this._selectionCache = new Map();
        this._cacheTtl = CACHE_TTL.tierPrices || 60 * 60 * 1000;
        
        // Full catalog cache per provider
        this._catalogCache = new Map();
        this._catalogTtl = CACHE_TTL.productsCatalog || 60 * 60 * 1000;

        // Provider fallback priority order
        this._providerPriority = ['CHEAP_PANEL', 'SMSPOOL', 'HERO_SMS', 'ONLINE_SIM'];

        // Pending request deduplication
        this._pendingSelections = new Map();

        // Scoring weights
        this._weights = {
            price: 0.50,
            stock: 0.25,
            provider: 0.15,
            reliability: 0.10
        };

        // Price normalization baselines
        this._priceBaseline = {
            min: 0.03,
            optimal: 0.15,
            max: 2.00
        };

        logger.info('TierOperatorSelector initialized', {
            providers: this.providers.map(p => ({ name: p.name, key: p.providerKey })),
            weights: this._weights,
            priceBaseline: this._priceBaseline,
            cacheTtl: '60min'
        });
    }

    /**
     * Get all tier infos for display
     */
    getAllTierInfos() {
        return Object.entries(TIER_CONFIG).map(([key, config]) => ({
            key,
            label: config.label,
            emoji: config.emoji,
            description: config.description,
            detail: config.detail,
            badge: config.badge,
            priceMultiplier: config.priceMultiplier,
            operatorCount: config.operatorRange ? 
                (config.operatorRange.max - config.operatorRange.min + 1) : 0
        }));
    }

    /**
     * Get tier info by key
     */
    getTierInfo(tierKey) {
        const config = TIER_CONFIG[tierKey];
        if (!config) return null;
        
        return {
            key: tierKey,
            label: config.label,
            emoji: config.emoji,
            description: config.description,
            detail: config.detail,
            badge: config.badge,
            priceMultiplier: config.priceMultiplier,
            operatorCount: config.operatorRange ? 
                (config.operatorRange.max - config.operatorRange.min + 1) : 0
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CATALOG FETCHING (cached 60min)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get full catalog from provider (cached 60min)
     */
    async _getCatalog(provider) {
        const now = Date.now();
        const cached = this._catalogCache.get(provider.providerKey);
        
        if (cached && (now - cached.timestamp) < this._catalogTtl) {
            return cached.catalog;
        }
        
        if (provider.productsCache && (now - provider.productsCacheTime) < provider.productsCacheTtl) {
            this._catalogCache.set(provider.providerKey, {
                catalog: provider.productsCache,
                timestamp: now
            });
            return provider.productsCache;
        }
        
        const catalog = await provider.getProducts();
        
        if (catalog) {
            this._catalogCache.set(provider.providerKey, {
                catalog,
                timestamp: now
            });
        }
        
        return catalog;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  MAIN: Select best operator for tier/country/service
    //  CORE FIX: Gets ALL virtuals for country+service, filters by tier, picks best
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Select best operator for tier/country/service
     * 
     * FLOW:
     * 1. For each provider, fetch catalog for country+service
     * 2. Extract ALL virtual operators returned by provider
     * 3. Filter to only those in requested tier's range
     * 4. Score ALL candidates across ALL providers
     * 5. Return the single best one
     * 
     * This fixes the bug where it would pick virtual3, see US not available,
     * and return failure — instead of checking virtual7, 12, 19 etc.
     */
    async selectOperator(tierKey, country, service, options = {}) {
        const cacheKey = `${tierKey}:${country}:${service}`;
        
        if (!options.skipCache) {
            const cached = this._selectionCache.get(cacheKey);
            if (cached && (Date.now() - cached.time) < this._cacheTtl) {
                return cached.data;
            }
        }

        if (this._pendingSelections.has(cacheKey)) {
            return this._pendingSelections.get(cacheKey);
        }

        const promise = this._doSelectOperator(tierKey, country, service, options);
        this._pendingSelections.set(cacheKey, promise);

        try {
            const result = await promise;
            this._selectionCache.set(cacheKey, {
                data: result,
                time: Date.now()
            });
            return result;
        } finally {
            this._pendingSelections.delete(cacheKey);
        }
    }

    /**
     * Core selection logic
     */
    async _doSelectOperator(tierKey, country, service, options) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier) {
            throw new Error(`INVALID_TIER: ${tierKey}`);
        }

        // Step 1: Query ALL providers for ALL operators matching this country+service
        const allCandidates = await this._queryAllProvidersForCountryService(
            tierKey, country, service
        );
        
        if (allCandidates.length === 0) {
            throw new Error(`NO_NUMBERS: No ${tierKey} operators have stock for ${service} in ${country}`);
        }

        // Step 2: Enforce minimum stock threshold
        const minStock = tier.minStock || 1;
        const viableCandidates = allCandidates.filter(op => op.stock >= minStock);
        
        const candidates = viableCandidates.length > 0 ? viableCandidates : allCandidates;

        // Step 3: Score ALL candidates
        const scored = candidates.map(op => ({
            ...op,
            score: this._calculateScore(op, tier.sortPriority, tierKey)
        }));

        // Step 4: Sort by score (highest first)
        scored.sort((a, b) => b.score - a.score);

        const best = scored[0];

        // Suspicious price guard
        if (best.price < this._priceBaseline.min) {
            logger.warn('Selected suspiciously cheap operator', {
                operator: best.operator,
                price: best.price,
                provider: best.providerKey,
                score: best.score
            });
        }

        const result = {
            operator: best.operator,
            price: best.price,
            displayPrice: best.displayPrice,
            stock: best.stock,
            score: best.score,
            provider: best.provider,
            providerKey: best.providerKey,
            originalService: service,
            mappedService: best.mappedService,
            crossProvider: best.providerKey !== 'CHEAP_PANEL',
            tier: tierKey,
            country,
            meetsThreshold: best.stock >= minStock,
            allCandidatesCount: allCandidates.length,
            viableCandidatesCount: viableCandidates.length
        };

        logger.info('Operator selected', {
            tier: tierKey,
            country,
            service,
            operator: best.operator,
            price: best.price,
            stock: best.stock,
            score: best.score,
            provider: best.providerKey,
            totalChecked: allCandidates.length,
            viableCount: viableCandidates.length
        });

        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  QUERY ALL PROVIDERS — CORE FIX
    //  For each provider, get ALL virtual operators for country+service
    //  Then filter by tier range. Don't stop at first provider match.
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Query ALL active providers for ALL operators matching tier/country/service
     * Returns merged, deduplicated results from all providers
     * 
     * KEY FIX: Previously this would stop when it found operators from the first
     * provider. Now it collects from ALL providers and lets scoring decide.
     */
    async _queryAllProvidersForCountryService(tierKey, country, service) {
        const allResults = [];
        const errors = [];
        const seenOperators = new Set(); // Track to avoid duplicates

        const sortedProviders = this._sortProvidersByPriority();

        for (const provider of sortedProviders) {
            try {
                const providerResults = await this._queryProviderForCountryService(
                    provider, tierKey, country, service
                );
                
                for (const op of providerResults) {
                    const key = `${op.providerKey}:${op.operator}`;
                    if (!seenOperators.has(key)) {
                        seenOperators.add(key);
                        allResults.push(op);
                    }
                }
            } catch (error) {
                errors.push({ provider: provider.providerKey, error: error.message });
            }
        }

        if (allResults.length === 0 && errors.length > 0) {
            logger.warn('All providers failed for tier', { 
                tierKey, 
                country, 
                service, 
                errors 
            });
        }

        return allResults;
    }

    /**
     * Query single provider for ALL operators in tier range for country+service
     * 
     * FIX: Instead of checking if a specific virtual has the country,
     * we ask the provider: "for this country and service, what virtuals do you have?"
     * Then we filter those virtuals by our tier range.
     */
    async _queryProviderForCountryService(provider, tierKey, country, service) {
        const tier = TIER_CONFIG[tierKey];
        const providerCountry = provider.mapCountry ? provider.mapCountry(country) : country;
        const providerService = provider.mapService ? provider.mapService(service) : service;

        // Fetch provider's catalog
        const catalog = await this._getCatalog(provider);
        if (!catalog) {
            return [];
        }

        // Navigate to country data
        const countryData = catalog[providerCountry];
        if (!countryData) {
            return [];
        }

        // Navigate to service data (with fallback chain)
        let serviceData = countryData[providerService];
        let usedMappedService = providerService;

        if (!serviceData) {
            const fallbacks = this._getServiceFallbacks(service, provider);
            for (const fb of fallbacks) {
                if (countryData[fb]) {
                    serviceData = countryData[fb];
                    usedMappedService = fb;
                    break;
                }
            }
        }

        if (!serviceData) {
            return [];
        }

        const candidates = [];
        
        // serviceData = { virtual1: {count: 5, cost: 0.25}, virtual2: {...}, ... }
        // We iterate ALL virtuals returned by provider for this country+service
        for (const [operatorName, operatorData] of Object.entries(serviceData)) {
            // Only consider virtual operators
            if (!operatorName.startsWith('virtual')) continue;
            
            const count = typeof operatorData === 'object' 
                ? (operatorData.count ?? operatorData.qty ?? operatorData.stock ?? 0) 
                : 0;
            
            const price = typeof operatorData === 'object' 
                ? (operatorData.cost ?? operatorData.price ?? Infinity) 
                : Infinity;
            
            if (count <= 0 || price <= 0 || price === Infinity) continue;
            
            // Extract virtual number
            const match = operatorName.match(/virtual(\d+)/);
            if (!match) continue;
            
            const opNum = parseInt(match[1]);
            
            // Check if this virtual is in the requested tier's range
            if (tier.operatorRange && 
                opNum >= tier.operatorRange.min && 
                opNum <= tier.operatorRange.max) {
                
                const displayPrice = provider.getDisplayPrice 
                    ? provider.getDisplayPrice(price) 
                    : price + 0.10;
                
                candidates.push({
                    operator: operatorName,
                    price: price,
                    displayPrice: displayPrice,
                    stock: count,
                    provider: provider.name,
                    providerKey: provider.providerKey,
                    mappedService: usedMappedService,
                    crossProvider: provider.providerKey !== 'CHEAP_PANEL',
                    country: country,
                    service: service
                });
            }
        }

        return candidates;
    }

    /**
     * Sort providers by configured priority
     */
    _sortProvidersByPriority() {
        return [...this.providers].sort((a, b) => {
            const idxA = this._providerPriority.indexOf(a.providerKey);
            const idxB = this._providerPriority.indexOf(b.providerKey);
            if (idxA === -1 && idxB === -1) return 0;
            if (idxA === -1) return 1;
            if (idxB === -1) return -1;
            return idxA - idxB;
        });
    }

    /**
     * Get service fallback chain for a provider
     */
    _getServiceFallbacks(service, provider) {
        const normalized = service.toString().trim().toLowerCase();
        
        if (provider.serviceFallbackMap && provider.serviceFallbackMap[normalized]) {
            return provider.serviceFallbackMap[normalized];
        }
        
        return [normalized, 'other'];
    }
        // ═══════════════════════════════════════════════════════════════════════
    //  FIXED SCORING SYSTEM — Normalized 0-100
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Calculate normalized score (0-100) for an operator
     */
    _calculateScore(op, sortPriority, tierKey) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier) return 0;

        const priceScore = this._calculatePriceScore(op.price, tierKey);
        const stockScore = this._calculateStockScore(op.stock, tier.minStock || 1);
        const providerScore = this._calculateProviderScore(op.providerKey);
        const reliabilityScore = this._calculateReliabilityScore(op);

        // Tier-specific multipliers
        let tierMultiplier = 1.0;
        
        if (tierKey === 'premium') {
            if (op.price < 0.10) tierMultiplier = 0.85;
            else if (op.price > 0.50) tierMultiplier = 1.10;
        } else if (tierKey === 'budget') {
            if (op.price < this._priceBaseline.min) tierMultiplier = 0.30;
            else if (op.price < 0.08) tierMultiplier = 1.20;
        } else if (tierKey === 'standard') {
            if (op.price >= 0.10 && op.price <= 0.30) tierMultiplier = 1.05;
        }

        // Cross-provider penalty
        let crossProviderPenalty = 1.0;
        if (op.providerKey !== 'CHEAP_PANEL') {
            crossProviderPenalty = 0.90;
        }

        const rawScore = (
            priceScore * this._weights.price +
            stockScore * this._weights.stock +
            providerScore * this._weights.provider +
            reliabilityScore * this._weights.reliability
        );

        const finalScore = Math.round(rawScore * tierMultiplier * crossProviderPenalty);

        logger.debug('Operator scored', {
            operator: op.operator,
            price: op.price,
            stock: op.stock,
            provider: op.providerKey,
            tier: tierKey,
            priceScore: Math.round(priceScore),
            stockScore: Math.round(stockScore),
            providerScore: Math.round(providerScore),
            reliabilityScore: Math.round(reliabilityScore),
            tierMultiplier,
            crossProviderPenalty,
            finalScore
        });

        return finalScore;
    }

    /**
     * Price score: 0-100, inverse logarithmic scale
     */
    _calculatePriceScore(price, tierKey) {
        if (price <= 0) return 0;
        if (price >= 5.00) return 0;

        const { min, optimal, max } = this._priceBaseline;

        if (price < min) {
            return Math.max(0, 100 * (price / min) * 0.5);
        }

        if (price <= optimal) {
            const ratio = (price - min) / (optimal - min);
            return Math.round(100 - (ratio * 15));
        }

        if (price <= max) {
            const ratio = (price - optimal) / (max - optimal);
            return Math.round(85 - (ratio * 75));
        }

        const ratio = (price - max) / (5.00 - max);
        return Math.round(10 - (ratio * 10));
    }

    /**
     * Stock score: 0-100, threshold-aware
     */
    _calculateStockScore(stock, minStock) {
        if (stock < minStock) return 0;
        if (stock >= minStock * 50) return 100;

        const ratio = (stock - minStock) / (minStock * 49);
        return Math.round(30 + (ratio * 70));
    }

    /**
     * Provider score: 0-100
     */
    _calculateProviderScore(providerKey) {
        const priorityIndex = this._providerPriority.indexOf(providerKey);
        if (priorityIndex === -1) return 50;
        if (priorityIndex === 0) return 100;
        return Math.max(0, 100 - (priorityIndex * 25));
    }

    /**
     * Reliability score: placeholder
     */
    _calculateReliabilityScore(op) {
        let score = 70;

        if (op.providerKey === 'CHEAP_PANEL') score += 15;
        if (op.stock > 20) score += 10;
        if (op.stock < 5) score -= 20;

        return Math.min(100, Math.max(0, score));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TIER STOCK CHECK — FIXED
    //  Checks ALL virtuals in tier range for country/service, not just one
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check if tier has ANY stock for country/service
     * Returns summary of ALL available operators, not just the best one
     */
    async hasTierStock(tierKey, country, service) {
        try {
            const allCandidates = await this._queryAllProvidersForCountryService(
                tierKey, country, service
            );

            if (allCandidates.length === 0) {
                return {
                    available: false,
                    reason: `No ${tierKey} operators have stock for ${service} in ${country}`,
                    operatorsChecked: 0
                };
            }

            const minStock = TIER_CONFIG[tierKey]?.minStock || 1;
            const viable = allCandidates.filter(op => op.stock >= minStock);

            // Return the best one as primary, but include count of all available
            const best = viable.length > 0 ? viable[0] : allCandidates[0];

            return {
                available: true,
                operator: best.operator,
                stock: best.stock,
                price: best.price,
                displayPrice: best.displayPrice,
                provider: best.providerKey,
                totalOperators: allCandidates.length,
                viableOperators: viable.length,
                allOperators: allCandidates.map(c => ({
                    operator: c.operator,
                    price: c.price,
                    stock: c.stock,
                    provider: c.providerKey
                }))
            };
        } catch (error) {
            return {
                available: false,
                reason: error.message,
                operatorsChecked: 0
            };
        }
    }

    /**
     * Get ALL operators in tier for country/service (for UI display)
     * Returns full list sorted by tier strategy
     */
    async getAllTierOperators(tierKey, country, service) {
        try {
            const allCandidates = await this._queryAllProvidersForCountryService(
                tierKey, country, service
            );

            if (allCandidates.length === 0) {
                return [];
            }

            const scored = allCandidates.map(op => ({
                ...op,
                score: this._calculateScore(op, TIER_CONFIG[tierKey]?.sortPriority, tierKey)
            }));

            scored.sort((a, b) => b.score - a.score);
            return scored;
        } catch (error) {
            logger.error('Failed to get all tier operators', { tierKey, country, service, error: error.message });
            return [];
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FALLBACK OPERATORS — FIXED
    //  Gets next-best operators in same tier, excluding the failed one
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get fallback operators within SAME tier (excluding failed one)
     * Returns ranked list of alternatives from ALL providers
     */
    async getFallbackOperators(tierKey, country, service, excludeOperator = null) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier || !tier.fallbackWithinTier) {
            return [];
        }

        // Get ALL operators in tier from ALL providers
        const allResults = await this._queryAllProvidersForCountryService(
            tierKey, country, service
        );
        
        // Filter out excluded operator
        let available = allResults.filter(op => 
            op.operator !== excludeOperator &&
            op.stock >= (tier.minStock || 1) &&
            op.price > 0
        );

        if (available.length === 0) {
            logger.warn('No fallback operators in tier', { 
                tier: tierKey, 
                country, 
                service, 
                excluded: excludeOperator 
            });
            return [];
        }

        // Score and sort
        const scored = available.map(op => ({
            ...op,
            score: this._calculateScore(op, tier.sortPriority, tierKey)
        }));

        scored.sort((a, b) => b.score - a.score);
        
        logger.info('Fallback operators found', {
            tier: tierKey,
            country,
            service,
            count: scored.length,
            topOperator: scored[0]?.operator,
            topPrice: scored[0]?.price,
            topStock: scored[0]?.stock,
            topProvider: scored[0]?.providerKey,
            topScore: scored[0]?.score
        });

        return scored;
    }

    /**
     * Get cheapest price across ALL providers for a tier
     */
    async getCheapestPrice(tierKey, country, service) {
        try {
            const result = await this.selectOperator(tierKey, country, service);
            return {
                available: true,
                price: result.displayPrice,
                rawPrice: result.price,
                operator: result.operator,
                stock: result.stock,
                provider: result.providerKey
            };
        } catch (error) {
            return {
                available: false,
                reason: error.message
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY AVAILABILITY — FIXED
    //  For a given service, check which countries have stock in this tier
    //  This queries the provider catalog properly
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get countries that have stock for a service in a specific tier
     * This is used by CountryCatalog to show available countries
     * 
     * FIX: Previously this might have checked one virtual and returned
     * countries for just that virtual. Now it checks ALL virtuals in the
     * tier range and aggregates available countries.
     */
    async getAvailableCountriesForService(tierKey, service, options = {}) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier) return [];

        const allCountries = [];
        const seenCountries = new Set();

        for (const provider of this.providers) {
            try {
                const catalog = await this._getCatalog(provider);
                if (!catalog) continue;

                // Iterate all countries in catalog
                for (const [countryCode, countryData] of Object.entries(catalog)) {
                    if (seenCountries.has(countryCode)) continue;

                    // Check if this country has the service
                    const providerService = provider.mapService 
                        ? provider.mapService(service) 
                        : service;
                    
                    let serviceData = countryData[providerService];
                    
                    if (!serviceData) {
                        const fallbacks = this._getServiceFallbacks(service, provider);
                        for (const fb of fallbacks) {
                            if (countryData[fb]) {
                                serviceData = countryData[fb];
                                break;
                            }
                        }
                    }

                    if (!serviceData) continue;

                    // Check if ANY virtual in tier range has stock
                    let hasStock = false;
                    let bestPrice = Infinity;
                    let bestStock = 0;
                    let bestOperator = null;

                    for (const [operatorName, operatorData] of Object.entries(serviceData)) {
                        if (!operatorName.startsWith('virtual')) continue;
                        
                        const match = operatorName.match(/virtual(\d+)/);
                        if (!match) continue;
                        
                        const opNum = parseInt(match[1]);
                        if (opNum < tier.operatorRange.min || opNum > tier.operatorRange.max) continue;
                        
                        const count = typeof operatorData === 'object' 
                            ? (operatorData.count ?? operatorData.qty ?? operatorData.stock ?? 0) 
                            : 0;
                        
                        const price = typeof operatorData === 'object' 
                            ? (operatorData.cost ?? operatorData.price ?? Infinity) 
                            : Infinity;

                        if (count > 0 && price > 0 && price !== Infinity) {
                            hasStock = true;
                            if (price < bestPrice) {
                                bestPrice = price;
                                bestStock = count;
                                bestOperator = operatorName;
                            }
                        }
                    }

                    if (hasStock) {
                        seenCountries.add(countryCode);
                        allCountries.push({
                            code: countryCode,
                            provider: provider.providerKey,
                            bestOperator: bestOperator,
                            bestPrice: bestPrice,
                            bestStock: bestStock,
                            hasMultipleProviders: false // Set later if needed
                        });
                    }
                }
            } catch (error) {
                logger.warn('Provider catalog error', { 
                    provider: provider.providerKey, 
                    error: error.message 
                });
            }
        }

        return allCountries;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CACHE & STATS
    // ═══════════════════════════════════════════════════════════════════════

    clearCaches() {
        this._selectionCache.clear();
        this._catalogCache.clear();
        this._pendingSelections.clear();
        logger.info('TierOperatorSelector caches cleared');
    }

    getStats() {
        return {
            providers: this.providers.map(p => ({ name: p.name, key: p.providerKey })),
            cacheSize: this._selectionCache.size,
            catalogCacheSize: this._catalogCache.size,
            pendingSelections: this._pendingSelections.size,
            weights: this._weights,
            priceBaseline: this._priceBaseline
        };
    }
}

export default TierOperatorSelector;
            
