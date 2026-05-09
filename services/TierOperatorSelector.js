// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierOperatorSelector.js — Intelligent Tier-Based Provider Selection
//  Core engine: selects best operator within tier using live data
// ═══════════════════════════════════════════════════════════════════════════════

import { TIER_CONFIG, CACHE_TTL } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

/**
 * TierOperatorSelector — Selects the best available operator within a tier
 * 
 * Design principles:
 *   - NO cross-tier fallback (enforced)
 *   - All provider names come from config only
 *   - Async stock/price checks with timeout racing
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

        // Step 1: Get live data for ALL operators in tier (parallel with timeout)
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
        const displayPrice = selected.price ? parseFloat((selected.price * tier.priceMultiplier).toFixed(2)) : null;

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
    //  INTERNAL — Data Fetching
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Fetch live price/stock data for multiple operators in parallel
     * Uses caching and request deduplication
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

        const promise = this._fetchOperatorDataUncached(country, service, operators, timeoutMs);
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
     * Uncached fetch — hits 5SIM API for each operator
     * Uses Promise.all with individual timeouts
     */
    async _fetchOperatorDataUncached(country, service, operators, timeoutMs) {
        const providerCountry = this.provider.mapCountry(country);
        const providerService = this.provider.mapService(service);

        // Fetch full product catalog once (shared across operators)
        let products;
        try {
            products = await this.provider.getProducts();
        } catch (e) {
            logger.error('Failed to fetch products for tier selection', { error: e.message });
            products = null;
        }

        const requests = operators.map(async (operator) => {
            const startTime = Date.now();
            
            try {
                // Method 1: Try targeted endpoint first (fastest)
                const targetedEndpoint = `${this.provider.endpoints.getPrices}?country=${providerCountry}&product=${providerService}&operator=${operator}`;
                
                let response;
                try {
                    response = await this.provider.request('get', targetedEndpoint, null, 8000);
                } catch (err) {
                    // Fall through to catalog method
                    response = null;
                }

                let price = Infinity;
                let stock = 0;

                if (response && response.status < 400 && response.data) {
                    const data = response.data;
                    const countryData = data[providerCountry];
                    if (countryData) {
                        const serviceData = countryData[providerService];
                        if (serviceData && serviceData[operator]) {
                            const opData = serviceData[operator];
                            price = typeof opData === 'object' ? (opData.cost ?? opData.price ?? Infinity) : Infinity;
                            stock = typeof opData === 'object' ? (opData.count ?? 0) : 0;
                        }
                    }
                }

                // Method 2: Fallback to cached catalog
                if (price === Infinity && products) {
                    const countryData = products[providerCountry];
                    if (countryData) {
                        const serviceData = countryData[providerService];
                        if (serviceData && serviceData[operator]) {
                            const opData = serviceData[operator];
                            price = typeof opData === 'object' ? (opData.cost ?? opData.price ?? Infinity) : Infinity;
                            stock = typeof opData === 'object' ? (opData.count ?? 0) : 0;
                        }
                    }
                }

                // Update runtime stats
                this._updateOperatorStats(operator, true, Date.now() - startTime);

                return {
                    operator,
                    price: price === Infinity ? null : parseFloat(price),
                    stock: parseInt(stock) || 0,
                    responseTime: Date.now() - startTime,
                    source: price === Infinity ? 'unavailable' : 'live'
                };

            } catch (error) {
                this._updateOperatorStats(operator, false, Date.now() - startTime);
                return {
                    operator,
                    price: null,
                    stock: 0,
                    responseTime: Date.now() - startTime,
                    source: 'error',
                    error: error.message
                };
            }
        });

        // Race with overall timeout
        const results = await Promise.all(
            requests.map(p => 
                Promise.race([
                    p,
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('OPERATOR_TIMEOUT')), timeoutMs)
                    )
                ]).catch(err => ({
                    operator: 'unknown',
                    price: null,
                    stock: 0,
                    responseTime: timeoutMs,
                    source: 'timeout',
                    error: err.message
                }))
            )
        );

        // Map results back to operators (preserving order)
        return operators.map((op, i) => {
            const result = results[i];
            if (result.operator === 'unknown') result.operator = op;
            return result;
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
                                            
