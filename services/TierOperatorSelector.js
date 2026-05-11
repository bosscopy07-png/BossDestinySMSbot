// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierOperatorSelector.js — Intelligent Tier-Based Provider Selection
//  Core engine: selects best operator within tier using live data
//  FIXED: Rate limiting handled at CheapPanelProvider level
// ═══════════════════════════════════════════════════════════════════════════════

import { TIER_CONFIG, CACHE_TTL } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

/**
 * TierOperatorSelector — Selects the best available operator within a tier
 */
class TierOperatorSelector {
    constructor(cheapPanelProvider) {
        this.provider = cheapPanelProvider;
        
        this._priceCache = new Map();
        this._healthCache = new Map();
        this._operatorStats = new Map();
        this._pendingChecks = new Map();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Main Selection Entry Point
    // ═══════════════════════════════════════════════════════════════════════

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

        const operatorData = await this._fetchTierOperatorData(
            tierKey, country, service, operators, options.timeoutMs || 15000
        );

        const available = operatorData.filter(op => op.stock >= tier.minStock);
        
        if (available.length === 0) {
            const bestStock = Math.max(...operatorData.map(op => op.stock));
            throw new Error(`TIER_NO_STOCK: No ${tierKey} operators have stock for ${service} in ${country}. Best available: ${bestStock}`);
        }

        const scored = available.map(op => ({
            ...op,
            score: this._calculateOperatorScore(op, tier.sortPriority, tierKey)
        }));

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
            allOptions: scored.slice(0, 5),
            tier: tierKey
        };
    }

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

    getAllTierInfos() {
        return Object.entries(TIER_CONFIG).map(([key, tier]) => this.getTierInfo(key));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Data Fetching
    // ═══════════════════════════════════════════════════════════════════════

    async _fetchTierOperatorData(tierKey, country, service, operators, timeoutMs) {
        const cacheKey = `${country}:${service}:${tierKey}`;
        const cached = this._priceCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL.tierPrices) {
            const cachedOps = cached.data.filter(op => operators.includes(op.operator));
            if (cachedOps.length === operators.length) {
                logger.debug('Using cached tier prices', { cacheKey, operators: operators.length });
                return cachedOps;
            }
        }

        const pendingKey = `${cacheKey}:${operators.join(',')}`;
        if (this._pendingChecks.has(pendingKey)) {
            return this._pendingChecks.get(pendingKey);
        }

        const promise = this._fetchOperatorDataUncached(country, service, operators, timeoutMs);
        this._pendingChecks.set(pendingKey, promise);

        try {
            const result = await promise;
            
            this._priceCache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });

            this._cleanupCache(this._priceCache, CACHE_TTL.tierPrices * 2);

            return result;
        } finally {
            this._pendingChecks.delete(pendingKey);
        }
    }

    async _fetchOperatorDataUncached(country, service, operators, timeoutMs) {
        const providerCountry = this.provider.mapCountry(country);
        const providerService = this.provider.mapService(service);

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
                const targetedEndpoint = `${this.provider.endpoints.getPrices}?country=${providerCountry}&product=${providerService}&operator=${operator}`;
                
                let response;
                try {
                    response = await this.provider.request('get', targetedEndpoint, null, 8000);
                } catch (err) {
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
        const normalizedStock = Math.min(op.stock / 10, 1);
        const normalizedSpeed = Math.max(0, 1 - (op.responseTime / 10000));

        switch (sortPriority) {
            case 'price':
                return (1 - normalizedPrice) * 0.7 + normalizedStock * 0.2 + successRate * 0.1;
            case 'balanced':
                return (1 - normalizedPrice) * 0.4 + normalizedStock * 0.3 + successRate * 0.2 + normalizedSpeed * 0.1;
            case 'quality':
                return successRate * 0.5 + normalizedStock * 0.25 + normalizedSpeed * 0.15 + (1 - normalizedPrice) * 0.1;
            default:
                return (1 - normalizedPrice) * 0.5 + normalizedStock * 0.3 + successRate * 0.2;
        }
    }

    _normalizePrice(price) {
        if (price === null || price === undefined || price <= 0) return 1.0;
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

    clearCaches() {
        this._priceCache.clear();
        this._healthCache.clear();
        logger.info('TierOperatorSelector caches cleared');
    }

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
                                                                  
