// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierOperatorSelector.js — Tier Operator Selection
//  FIXED:
//   1. Dynamic operator discovery from provider catalog using operatorRange
//   2. Cross-operator fallback within same tier (virtual56 fails → try virtual57, 58...)
//   3. Cross-provider fallback for same tier (5sim fails → SMSPool → Hero → OnlineSim)
//   4. Cache TTL: 60 minutes to prevent rate limits
//   5. Preserves original service name throughout flow
//   6. Queries ALL providers, returns cheapest price per tier
//   7. FIXED SCORING: Normalized 0-100 with proper tier logic and weights
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
 *   - FIXED: Normalized scoring system (0-100) with configurable weights
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

        // ═══════════════════════════════════════════════════════════════════════
        //  FIXED: SCORING WEIGHTS — tunable per business priority
        //  All scores normalized to 0-100 range
        // ═══════════════════════════════════════════════════════════════════════
        this._weights = {
            price: 0.50,        // 50% — cheapest wins
            stock: 0.25,        // 25% — reliable stock levels
            provider: 0.15,     // 15% — prefer primary provider
            reliability: 0.10   // 10% — historical success rate (placeholder)
        };

        // Price normalization: what we consider "fair market" for scoring
        this._priceBaseline = {
            min: 0.03,          // Below this is suspicious (scam/fake)
            optimal: 0.15,      // Sweet spot for scoring
            max: 2.00           // Above this is penalized heavily
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

    /**
     * FIXED: Core selection logic with normalized scoring and stock threshold enforcement
     */
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

        // ENFORCED: Filter out operators below minimum stock threshold
        const minStock = tier.minStock || 1;
        const viableResults = providerResults.filter(op => op.stock >= minStock);
        
        if (viableResults.length === 0) {
            // Fallback: allow below-threshold if nothing else exists
            logger.warn('No operators meet minStock threshold, using best available', {
                tier: tierKey,
                country,
                service,
                minStock,
                bestAvailable: Math.max(...providerResults.map(o => o.stock))
            });
        }

        const candidates = viableResults.length > 0 ? viableResults : providerResults;

        // Step 2: Score and sort all results using FIXED normalized scoring
        const scored = candidates.map(op => ({
            ...op,
            score: this._calculateScore(op, tier.sortPriority, tierKey)
        }));

        scored.sort((a, b) => b.score - a.score);

        const best = scored[0];

        // Sanity check: log if selected operator is suspiciously cheap
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
            meetsThreshold: best.stock >= minStock
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
            meetsThreshold: result.meetsThreshold
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

    // ═══════════════════════════════════════════════════════════════════════
    //  FIXED SCORING SYSTEM — Normalized 0-100 with proper tier logic
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Calculate normalized score (0-100) for an operator
     * 
     * Score = weighted sum of:
     *   - Price score (0-100): cheaper = higher, with floor/ceiling guards
     *   - Stock score (0-100): more stock = higher, threshold-aware
     *   - Provider score (0-100): primary provider bonus
     *   - Reliability score (0-100): placeholder for historical data
     */
    _calculateScore(op, sortPriority, tierKey) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier) return 0;

        // ── Price Score (0-100) ──────────────────────────────────────────
        const priceScore = this._calculatePriceScore(op.price, tierKey);

        // ── Stock Score (0-100) ────────────────────────────────────────────
        const stockScore = this._calculateStockScore(op.stock, tier.minStock || 5);

        // ── Provider Score (0-100) ─────────────────────────────────────────
        const providerScore = this._calculateProviderScore(op.providerKey);

        // ── Reliability Score (0-100) ────────────────────────────────────
        const reliabilityScore = this._calculateReliabilityScore(op);

        // ── Tier-specific adjustments ────────────────────────────────────
        let tierMultiplier = 1.0;
        
        if (tierKey === 'premium') {
            // Premium: slight preference for mid-range prices (not too cheap)
            // Too cheap often means low quality/reliability
            if (op.price < 0.10) tierMultiplier = 0.85;
            else if (op.price > 0.50) tierMultiplier = 1.10;
        } else if (tierKey === 'budget') {
            // Budget: aggressive price preference, but avoid suspiciously cheap
            if (op.price < this._priceBaseline.min) tierMultiplier = 0.30; // Scam guard
            else if (op.price < 0.08) tierMultiplier = 1.20;
        } else if (tierKey === 'standard') {
            // Standard: balanced, slight preference for moderate prices
            if (op.price >= 0.10 && op.price <= 0.30) tierMultiplier = 1.05;
        }

        // ── Cross-provider penalty ───────────────────────────────────────
        // Switching providers adds latency and failure risk
        let crossProviderPenalty = 1.0;
        if (op.providerKey !== 'CHEAP_PANEL') {
            crossProviderPenalty = 0.90; // 10% penalty for non-primary
        }

        // ── Final weighted score ─────────────────────────────────────────
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
     * 
     * - $0.03 (min) → 100 points (but flagged as suspicious)
     * - $0.15 (optimal) → 85 points
     * - $0.50 → 60 points
     * - $2.00 (max) → 10 points
     * - $5.00+ → 0 points
     */
    _calculatePriceScore(price, tierKey) {
        if (price <= 0) return 0;
        if (price >= 5.00) return 0;

        const { min, optimal, max } = this._priceBaseline;

        // Suspiciously cheap — possible scam/fake numbers
        if (price < min) {
            return Math.max(0, 100 * (price / min) * 0.5); // Max 50, scaled down
        }

        // Normal range: logarithmic decay from optimal
        if (price <= optimal) {
            // Between min and optimal: slight decay from 100
            const ratio = (price - min) / (optimal - min);
            return Math.round(100 - (ratio * 15)); // 100 → 85
        }

        if (price <= max) {
            // Between optimal and max: steeper decay
            const ratio = (price - optimal) / (max - optimal);
            return Math.round(85 - (ratio * 75)); // 85 → 10
        }

        // Above max but below 5.00
        const ratio = (price - max) / (5.00 - max);
        return Math.round(10 - (ratio * 10)); // 10 → 0
    }

    /**
     * Stock score: 0-100, threshold-aware
     * 
     * - Below minStock: 0 (unreliable)
     * - minStock: 30 points (barely acceptable)
     * - 10x minStock: 70 points (comfortable)
     * - 50x minStock: 100 points (very reliable)
     */
    _calculateStockScore(stock, minStock) {
        if (stock < minStock) return 0;
        if (stock >= minStock * 50) return 100;

        const ratio = (stock - minStock) / (minStock * 49);
        return Math.round(30 + (ratio * 70)); // 30 → 100
    }

    /**
     * Provider score: 0-100
     * Primary provider (CHEAP_PANEL/5sim) gets full bonus
     */
        _calculateProviderScore(providerKey) {
        const priorityIndex = this._providerPriority.indexOf(providerKey);
        if (priorityIndex === -1) return 50; // Unknown provider
        if (priorityIndex === 0) return 100; // Primary
        return Math.max(0, 100 - (priorityIndex * 25)); // 100, 75, 50, 25
    }

    /**
     * Reliability score: placeholder for historical success tracking
     * TODO: Integrate with actual success-rate tracking
     */
    _calculateReliabilityScore(op) {
        // Placeholder: assume primary provider + high stock = more reliable
        let score = 70; // Base assumption

        if (op.providerKey === 'CHEAP_PANEL') score += 15;
        if (op.stock > 20) score += 10;
        if (op.stock < 5) score -= 20;

        return Math.min(100, Math.max(0, score));
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

        // Score and sort using FIXED scoring
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
            pendingSelections: this._pendingSelections.size,
            weights: this._weights,
            priceBaseline: this._priceBaseline
        };
    }
}

export default TierOperatorSelector;
