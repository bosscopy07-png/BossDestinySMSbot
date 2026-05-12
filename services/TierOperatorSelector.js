// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierOperatorSelector.js — Intelligent Tier-Based Provider Selection
//  Core engine: selects best operator within tier using cached product data
//  FIXED: displayPrice now includes $0.20 profit margin to match CheapPanelProvider
// ═══════════════════════════════════════════════════════════════════════════════

import { TIER_CONFIG, CACHE_TTL } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

/**
 * TierOperatorSelector — Selects the best available operator within a tier
 * 
 * Design principles:
 *   - NO cross-tier fallback (enforced)
 *   - All provider names come from config only
 *   - Reads from cached product catalog (zero API calls per selection)
 *   - Health scoring for smart selection
 */
class TierOperatorSelector {
    constructor(cheapPanelProvider) {
        this.provider = cheapPanelProvider;
        
        // In-memory caches
        this._priceCache = new Map();      // key: `${country}:${service}:${tierKey}` -> { operators[], timestamp }
        this._healthCache = new Map();     // key: `${provider}:${operator}` -> { successRate, avgSpeed, timestamp }
        this._operatorStats = new Map();   // Runtime stats: operator -> { attempts, successes, failures, avgResponseTime }
        
        // Pending request deduplication
        this._pendingChecks = new Map();   // key -> Promise
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Main Selection Entry Point
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Select the best operator for a given tier, country, and service
     * 
     * @param {string} tierKey - 'budget' | 'standard' | 'premium'
     * @param {string} country - ISO country code (e.g., 'US')
     * @param {string} service - Service name (e.g., 'WhatsApp')
     * @param {Object} options - { skipCache: boolean, timeoutMs: number }
     * @returns {Promise<{operator: string, price: number, stock: number, score: number, displayPrice: number}>}
     */
    async selectOperator(tierKey, country, service, options = {}) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier) {
            throw new Error(`INVALID_TIER: "${tierKey}". Available: ${Object.keys(TIER_CONFIG).join(', ')}`);
        }

        const operators = tier.operators;
        if (!operators || operators.length === 0) {
            throw new Error(`TIER_EMPTY: No operators configured for tier "${tierKey}"`);
        }

        logger.info('Selecting operator', { tier: tierKey, country, service, operators: operators.length });

        // FIXED: Read from cached product catalog — ZERO API calls
        const operatorData = await this._fetchTierOperatorData(
            tierKey, country, service, operators, options.timeoutMs || 15000
        );

        // Step 2: Filter operators with sufficient stock
        const available = operatorData.filter(op => op.stock >= tier.minStock);
        
        if (available.length === 0) {
            const bestStock = Math.max(...operatorData.map(op => op.stock));
            throw new Error(`TIER_NO_STOCK: No ${tierKey} operators have stock for ${service} in ${country}. Best available: ${bestStock}`);
        }

        // Step 3: Score and rank available operators
        const scored = available.map(op => ({
            ...op,
            score: this._calculateOperatorScore(op, tier.sortPriority, tierKey)
        }));

        // Sort by score (highest first)
        scored.sort((a, b) => b.score - a.score);

        const selected = scored[0];
        // FIXED: displayPrice now includes $0.20 profit margin to match CheapPanelProvider.getDisplayPrice()
        const basePrice = selected.price ? parseFloat((selected.price * tier.priceMultiplier).toFixed(4)) : null;
        const displayPrice = basePrice !== null ? parseFloat((basePrice + 0.20).toFixed(2)) : null;

        logger.info('Operator selected', {
            tier: tierKey,
            country,
            service,
            operator: selected.operator,
            price: selected.price,
            displayPrice,
            stock: selected.stock,
            score: selected.score.toFixed(2),
            rank: 1,
            totalConsidered: scored.length
        });

        return {
            operator: selected.operator,
            price: selected.price,
            displayPrice,
            stock: selected.stock,
            score: selected.score,
            allOptions: scored.slice(0, 5), // Top 5 for debugging/admin
            tier: tierKey
        };
    }

    /**
     * Get fallback operators within the SAME tier (ordered by preference)
     * Used when primary operator fails during purchase
     */
    async getFallbackOperators(tierKey, country, service, excludeOperator = null) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier || !tier.fallbackWithinTier) {
            return [];
        }

        const operators = tier.operators.filter(op => op !== excludeOperator);
        if (operators.length === 0) return [];

        const operatorData = await this._fetchTierOperatorData(
            tierKey, country, service, operators, 10000
        );

        const available = operatorData.filter(op => op.stock >= tier.minStock);
        const scored = available.map(op => ({
            ...op,
            score: this._calculateOperatorScore(op, tier.sortPriority, tierKey)
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    /**
     * Check if ANY operator in tier has stock (lightweight check)
     */
    async hasTierStock(tierKey, country, service) {
        try {
            await this.selectOperator(tierKey, country, service, { timeoutMs: 8000 });
            return { available: true };
        } catch (error) {
            if (error.message?.includes('TIER_NO_STOCK') || error.message?.includes('TIER_EMPTY')) {
                return { available: false, reason: error.message };
            }
            return { available: false, reason: error.message };
        }
    }

    /**
     * Get tier display info for UI
     */
    getTierInfo(tierKey) {
        const tier = TIER_CONFIG[tierKey];
        if (!tier) return null;
        return {
            key: tierKey,
            label: tier.label,
            emoji: tier.emoji,
            description: tier.description,
            detail: tier.detail,
            badge: tier.badge,
            operatorCount: tier.operators.length,
            priceMultiplier: tier.priceMultiplier
        };
    }

    /**
     * Get all tier infos for UI
     */
    getAllTierInfos() {
        return Object.entries(TIER_CONFIG).map(([key, tier]) => this.getTierInfo(key));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Data Fetching (CACHE-ONLY, ZERO API CALLS)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Fetch operator data from cached product catalog
     * Uses caching and request deduplication — NO API calls
     */
    async _fetchTierOperatorData(tierKey, country, service, operators, timeoutMs) {
        const cacheKey = `${country}:${service}:${tierKey}`;
        const cached = this._priceCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL.tierPrices) {
            // Filter cached data to only requested operators
            const cachedOps = cached.data.filter(op => operators.includes(op.operator));
            if (cachedOps.length === operators.length) {
                logger.debug('Using cached tier prices', { cacheKey, operators: operators.length });
                return cachedOps;
            }
        }

        // Deduplication: if another request is already fetching this, wait for it
        const pendingKey = `${cacheKey}:${operators.join(',')}`;
        if (this._pendingChecks.has(pendingKey)) {
            return this._pendingChecks.get(pendingKey);
        }

        const promise = this._fetchOperatorDataFromCache(country, service, operators);
        this._pendingChecks.set(pendingKey, promise);

        try {
            const result = await promise;
            
            // Update cache
            this._priceCache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });

            // Cleanup old cache entries
            this._cleanupCache(this._priceCache, CACHE_TTL.tierPrices * 2);

            return result;
        } finally {
            this._pendingChecks.delete(pendingKey);
        }
    }

    /**
     * FIXED: Read from provider's cached product catalog — ZERO API calls
     * Previously made individual API calls per operator causing 429s
     */
    async _fetchOperatorDataFromCache(country, service, operators) {
        const providerCountry = this.provider.mapCountry(country);
        const providerService = this.provider.mapService(service);

        // Get products from provider's cache — SINGLE call, already cached
        const products = await this.provider.getProducts();

        if (!products) {
            logger.error('Failed to fetch products for tier selection — provider cache empty');
            // Return all operators as unavailable
            return operators.map(operator => ({
                operator,
                price: null,
                stock: 0,
                responseTime: 0,
                source: 'error',
                error: 'Provider product cache unavailable'
            }));
        }

        const countryData = products[providerCountry];
        const serviceData = countryData?.[providerService];

        return operators.map(operator => {
            const opData = serviceData?.[operator];
            
            if (opData && typeof opData === 'object') {
                const price = opData.cost ?? opData.price ?? null;
                const stock = opData.count ?? 0;
                
                this._updateOperatorStats(operator, true, 0);

                return {
                    operator,
                    price: price !== null ? parseFloat(price) : null,
                    stock: parseInt(stock) || 0,
                    responseTime: 0,
                    source: 'cached'
                };
            }

            // Operator not found in catalog
            return {
                operator,
                price: null,
                stock: 0,
                responseTime: 0,
                source: 'unavailable'
            };
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Scoring
    // ═══════════════════════════════════════════════════════════════════════

    _calculateOperatorScore(op, sortPriority, tierKey) {
        const stats = this._operatorStats.get(op.operator) || { attempts: 0, successes: 0, avgResponseTime: 5000 };
        const successRate = stats.attempts > 0 ? stats.successes / stats.attempts : 0.5;
        const normalizedPrice = this._normalizePrice(op.price);
        const normalizedStock = Math.min(op.stock / 10, 1); // Cap at 10+ stock = 1.0
        const normalizedSpeed = Math.max(0, 1 - (op.responseTime / 10000)); // Faster = higher

        switch (sortPriority) {
            case 'price':
                // 70% price (lower is better, so invert), 20% stock, 10% success rate
                return (1 - normalizedPrice) * 0.7 + normalizedStock * 0.2 + successRate * 0.1;
            
            case 'balanced':
                // 40% price (inverted), 30% stock, 20% success rate, 10% speed
                return (1 - normalizedPrice) * 0.4 + normalizedStock * 0.3 + successRate * 0.2 + normalizedSpeed * 0.1;
            
            case 'quality':
                // 50% success rate, 25% stock, 15% speed, 10% price (inverted)
                return successRate * 0.5 + normalizedStock * 0.25 + normalizedSpeed * 0.15 + (1 - normalizedPrice) * 0.1;
            
            default:
                return (1 - normalizedPrice) * 0.5 + normalizedStock * 0.3 + successRate * 0.2;
        }
    }

    _normalizePrice(price) {
        if (price === null || price === undefined || price <= 0) return 1.0; // Worst score for unknown
        // Normalize to 0-1 range assuming $0.05-$2.00 range
        return Math.min(Math.max((price - 0.05) / 1.95, 0), 1);
    }

    _updateOperatorStats(operator, success, responseTime) {
        const stats = this._operatorStats.get(operator) || { attempts: 0, successes: 0, totalResponseTime: 0 };
        stats.attempts++;
        if (success) stats.successes++;
        stats.totalResponseTime = (stats.totalResponseTime || 0) + responseTime;
        stats.avgResponseTime = stats.totalResponseTime / stats.attempts;
        this._operatorStats.set(operator, stats);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Cache Management
    // ═══════════════════════════════════════════════════════════════════════

    _cleanupCache(map, maxAge) {
        const now = Date.now();
        for (const [key, entry] of map) {
            if (now - entry.timestamp > maxAge) {
                map.delete(key);
            }
        }
    }

    /**
     * Clear all caches (useful for admin operations or testing)
     */
    clearCaches() {
        this._priceCache.clear();
        this._healthCache.clear();
        logger.info('TierOperatorSelector caches cleared');
    }

    /**
     * Get runtime statistics for monitoring
     */
    getStats() {
        return {
            cacheSize: {
                prices: this._priceCache.size,
                health: this._healthCache.size
            },
            operatorStats: Object.fromEntries(this._operatorStats),
            pendingChecks: this._pendingChecks.size
        };
    }
}

export default TierOperatorSelector;
            
