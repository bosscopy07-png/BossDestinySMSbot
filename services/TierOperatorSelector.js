// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierOperatorSelector.js — Tier Operator Selection
//  FIXED:
//   1. Dynamic operator discovery from provider catalog using operatorRange
//   2. Cross-operator fallback within same tier (virtual56 fails → try virtual57, 58...)
//   3. Cross-provider fallback for same tier (5sim fails → SMSPool → Hero → OnlineSim)
//   4. Cache TTL: 60 minutes to prevent rate limits
//   5. Preserves original service name throughout flow
//   6. Queries ALL providers, returns cheapest price per tier
// ═══════════════════════════════════════════════════════════════════════════════

import { TIER_CONFIG, getTierOperators, isOperatorInTier, getOperatorTier, getAdjacentOperators, CACHE_TTL } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

/**
 * TierOperatorSelector — Selects best operator per tier from live provider data
 * 
 * Features:
 *   - Fetches full price catalog (cached 60min)
 *   - Filters operators by tier range (budget: 1-25, standard: 26-50, premium: 51+)
 *   - Cross-operator fallback: if virtual56 fails, tries adjacent operators in same tier
 *   - Cross-provider fallback: queries ALL providers, picks cheapest with stock
 *   - Preserves original service name to prevent INVALID_SERVICE downstream
 */
class TierOperatorSelector {
    constructor(providers = []) {
        this.providers = providers.filter(p => p?.isActive);
        
        // Cache for operator selections
        this._selectionCache = new Map();
        this._cacheTtl = CACHE_TTL.tierPrices || 60 * 60 * 1000; // 60 minutes
        
        // Full catalog cache per provider
        this._catalogCache = new Map(); // providerKey -> { catalog, timestamp }
        this._catalogTtl = CACHE_TTL.productsCatalog || 60 * 60 * 1000;

        // Provider fallback priority order
        this._providerPriority = ['CHEAP_PANEL', 'SMSPOOL', 'HERO_SMS', 'ONLINE_SIM'];

        // Pending request deduplication
        this._pendingSelections = new Map(); // cacheKey -> Promise

        logger.info('TierOperatorSelector initialized', {
            providers: this.providers.map(p => ({ name: p.name, key: p.providerKey })),
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

    /**
     * Get full catalog from provider (cached 60min)
     */
    async _getCatalog(provider) {
        const now = Date.now();
        const cached = this._catalogCache.get(provider.providerKey);
        
        if (cached && (now - cached.timestamp) < this._catalogTtl) {
            return cached.catalog;
        }
        
        // Use provider's cache if fresh
        if (provider.productsCache && (now - provider.productsCacheTime) < provider.productsCacheTtl) {
            this._catalogCache.set(provider.providerKey, {
                catalog: provider.productsCache,
                timestamp: now
            });
            return provider.productsCache;
        }
        
        // Fetch fresh catalog
        const catalog = await provider.getProducts();
        
        if (catalog) {
            this._catalogCache.set(provider.providerKey, {
                catalog,
                timestamp: now
            });
        }
        
        return catalog;
    }

    /**
     * Select best operator for tier/country/service
     * Cross-provider: queries ALL providers, returns cheapest with stock
     * Cross-operator: if preferred operator fails, tries adjacent in same tier
     * 
     * Returns: { operator, price, displayPrice, stock, score, provider, providerKey, originalService }
     */
    async selectOperator(tierKey, country, service, options = {}) {
        const cacheKey = `${tierKey}:${country}:${service}`;
        
        // Check cache first
        if (!options.skipCache) {
            const cached = this._selectionCache.get(cacheKey);
            if (cached && (Date.now() - cached.time) < this._cacheTtl) {
                return cached.data;
            }
        }

        // Deduplication: if another request is selecting this, wait for it
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

    async _doSelectOperator(tierKey, country, service, options) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier) {
            throw new Error(`INVALID_TIER: ${tierKey}`);
        }

        // Step 1: Try ALL providers for this tier
        const providerResults = await this._queryAllProviders(tierKey, country, service);
        
        if (providerResults.length === 0) {
            throw new Error(`NO_NUMBERS: No operators have stock for ${service} in ${country} across all providers`);
        }

        // Step 2: Score and sort all results
        const scored = providerResults.map(op => ({
            ...op,
            score: this._calculateScore(op, tier.sortPriority, tierKey)
        }));

        scored.sort((a, b) => b.score - a.score);

        const best = scored[0];

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
            crossProvider: best.crossProvider || false,
            tier: tierKey
        };

        logger.info('Operator selected', {
            tier: tierKey,
            country,
            service,
            operator: best.operator,
            price: best.price,
            stock: best.stock,
            provider: best.providerKey
        });

        return result;
    }

    /**
     * Query ALL active providers for this tier/country/service
     * Returns merged results from all providers
     */
    async _queryAllProviders(tierKey, country, service) {
        const allResults = [];
        const errors = [];

        // Sort providers by priority
        const sortedProviders = this._sortProvidersByPriority();

        for (const provider of sortedProviders) {
            try {
                const results = await this._queryProvider(provider, tierKey, country, service);
                allResults.push(...results);
            } catch (error) {
                errors.push({ provider: provider.providerKey, error: error.message });
            }
        }

        if (allResults.length === 0 && errors.length > 0) {
            logger.warn('All providers failed for tier', { tierKey, country, service, errors });
        }

        return allResults;
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
     * Query single provider for operators in tier range
     */
    async _queryProvider(provider, tierKey, country, service) {
        const tier = TIER_CONFIG[tierKey];
        const providerCountry = provider.mapCountry ? provider.mapCountry(country) : country;
        const providerService = provider.mapService ? provider.mapService(service) : service;

        const catalog = await this._getCatalog(provider);
        if (!catalog) {
            return [];
        }

        const countryData = catalog[providerCountry];
        if (!countryData) {
            return [];
        }

        let serviceData = countryData[providerService];
        let usedMappedService = providerService;

        // Try service fallbacks if primary not found
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
        
        // Get all operators in tier range with stock
        for (const [operatorName, operatorData] of Object.entries(serviceData)) {
            const count = typeof operatorData === 'object' ? (operatorData.count ?? 0) : 0;
            const price = typeof operatorData === 'object' ? (operatorData.cost ?? operatorData.price ?? Infinity) : Infinity;
            
            if (count <= 0 || price <= 0 || price === Infinity) continue;
            
            // Check if operator belongs to requested tier
            const opNum = parseInt(operatorName.match(/virtual(\d+)/)?.[1] || '0');
            
            if (tier.operatorRange && 
                opNum >= tier.operatorRange.min && 
                opNum <= tier.operatorRange.max) {
                
                const displayPrice = provider.getDisplayPrice ? provider.getDisplayPrice(price) : price + 0.10;
                
                candidates.push({
                    operator: operatorName,
                    price: price,
                    displayPrice: displayPrice,
                    stock: count,
                    provider: provider.name,
                    providerKey: provider.providerKey,
                    mappedService: usedMappedService,
                    crossProvider: provider.providerKey !== 'CHEAP_PANEL'
                });
            }
        }

        return candidates;
    }

    /**
     * Get service fallback chain for a provider
     */
    _getServiceFallbacks(service, provider) {
        const normalized = service.toString().trim().toLowerCase();
        
        // Use provider's fallback map if available
        if (provider.serviceFallbackMap && provider.serviceFallbackMap[normalized]) {
            return provider.serviceFallbackMap[normalized];
        }
        
        // Default fallbacks
        return [normalized, 'other'];
    }

    /**
     * Calculate operator score based on tier priority
     */
    _calculateScore(op, sortPriority, tierKey) {
        // Base score: inverse price (cheaper = higher score)
        let score = 1000 / (op.price + 0.01);
        
        // Stock bonus (more stock = higher score, capped at 100)
        score += Math.min(op.stock, 100) * 0.1;
        
        // Tier-specific adjustments
        if (tierKey === 'premium') {
            // Premium: prefer higher-numbered operators (newer = better quality)
            const opNum = parseInt(op.operator.match(/virtual(\d+)/)?.[1] || '0');
            score += opNum * 0.5;
        } else if (tierKey === 'budget') {
            // Budget: strongly prefer cheapest
            score += (2.0 - op.price) * 10;
        }
        
        // Provider bonus: prefer primary provider (5sim)
        if (op.providerKey === 'CHEAP_PANEL') {
            score += 5;
        }
        
        return score;
    }

    /**
     * Check if tier has any stock for country/service (lightweight)
     */
    async hasTierStock(tierKey, country, service) {
        try {
            const result = await this.selectOperator(tierKey, country, service);
            return {
                available: true,
                operator: result.operator,
                stock: result.stock,
                price: result.price,
                provider: result.providerKey
            };
        } catch (error) {
            return {
                available: false,
                reason: error.message
            };
        }
    }

    /**
     * Get fallback operators within SAME tier (excluding failed one)
     * Cross-operator fallback: tries adjacent virtual numbers
     */
    async getFallbackOperators(tierKey, country, service, excludeOperator = null) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier || !tier.fallbackWithinTier) {
            return [];
        }

        // Get all operators in tier from all providers
        const allResults = await this._queryAllProviders(tierKey, country, service);
        
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
            topProvider: scored[0]?.providerKey
        });

        return scored;
    }

    /**
     * Get cheapest price across ALL providers for a tier
     * Used for tier baseline price display
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
            pendingSelections: this._pendingSelections.size
        };
    }
}

export default TierOperatorSelector;
            
