// ═══════════════════════════════════════════════════════════════════════════════
//  services/ProviderRouter.js — Multi-Provider Selection Engine
//  Primary: CheapPanelProvider (5sim)
//  Fallbacks: SMSPoolProvider, HeroSMSProvider, OnlineSimProvider
//  FIXED:
//   1. Queries ALL providers in parallel with stagger
//   2. Returns cheapest price across all providers
//   3. Cache TTL: 60 minutes
//   4. Staggered requests to avoid rate limit storms
// ═══════════════════════════════════════════════════════════════════════════════

import logger from '../../utils/logger.js';

/**
 * ProviderRouter — Routes CHEAP tier requests across multiple providers
 * 
 * Strategy:
 *   1. Query ALL active providers in parallel (with stagger)
 *   2. Sort by: price (lowest), then stock (highest)
 *   3. Return best option with providerKey attached
 * 
 * Provider priority is DYNAMIC based on price/stock, not hardcoded.
 * But 5sim (CheapPanel) usually wins on price for common services.
 */
class ProviderRouter {
    constructor(providers = []) {
        this.providers = new Map();
        
        for (const provider of providers) {
            if (provider?.isActive && provider?.providerKey) {
                this.providers.set(provider.providerKey, provider);
                logger.info('ProviderRouter registered provider', {
                    key: provider.providerKey,
                    name: provider.name,
                    active: provider.isActive
                });
            }
        }

        // Price comparison cache
        this._priceCache = new Map();
        this._cacheTtl = 60 * 60 * 1000; // 60 minutes

        // Request staggering to avoid rate limit storms
        this._staggerDelay = 200; // ms between provider queries
    }

    getProviderKeys() {
        return Array.from(this.providers.keys());
    }

    getProvider(key) {
        return this.providers.get(key);
    }

    hasAvailableProvider() {
        for (const provider of this.providers.values()) {
            if (provider.isActive) return true;
        }
        return false;
    }

    /**
     * Get best price across ALL providers
     * Returns: { providerKey, providerName, price, rawPrice, stock, operator, profit }
     */
    async getBestPrice(country, service) {
        const cacheKey = `${country}:${service}:best`;
        const cached = this._priceCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < this._cacheTtl) {
            return cached.data;
        }

        const results = [];
        const errors = [];

        const providerEntries = Array.from(this.providers.entries());
        
        for (let i = 0; i < providerEntries.length; i++) {
            const [key, provider] = providerEntries[i];
            
            // Stagger to avoid simultaneous rate limits
            if (i > 0) {
                await new Promise(r => setTimeout(r, this._staggerDelay));
            }

            try {
                const priceResult = await provider.getPrice(country, service);
                
                if (priceResult.success && priceResult.available && priceResult.stock > 0) {
                    results.push({
                        providerKey: key,
                        providerName: provider.name,
                        price: priceResult.displayPrice,
                        rawPrice: priceResult.simPrice,
                        stock: priceResult.stock,
                        operator: priceResult.operator || 'any',
                        profit: priceResult.profit || 0.10,
                        pool: priceResult.pool || null
                    });
                } else if (!priceResult.success) {
                    errors.push({ provider: key, error: priceResult.error });
                }
            } catch (error) {
                errors.push({ provider: key, error: error.message });
            }
        }

        if (results.length === 0) {
            logger.warn('No providers have stock', { 
                country, 
                service, 
                providerCount: this.providers.size,
                errors 
            });
            return null;
        }

        // Sort: price asc, then stock desc
        results.sort((a, b) => {
            if (a.price !== b.price) return a.price - b.price;
            return b.stock - a.stock;
        });

        const best = results[0];

        logger.info('Best provider selected', {
            country,
            service,
            provider: best.providerKey,
            price: best.price,
            rawPrice: best.rawPrice,
            stock: best.stock,
            alternatives: results.length - 1
        });

        this._priceCache.set(cacheKey, {
            data: best,
            timestamp: Date.now()
        });

        return best;
    }

    /**
     * Get ALL provider prices (for admin/debug)
     */
    async getAllPrices(country, service) {
        const results = [];

        for (const [key, provider] of this.providers) {
            try {
                const priceResult = await provider.getPrice(country, service);
                results.push({
                    providerKey: key,
                    providerName: provider.name,
                    price: priceResult.displayPrice,
                    rawPrice: priceResult.simPrice,
                    stock: priceResult.stock,
                    operator: priceResult.operator,
                    available: priceResult.available,
                    error: priceResult.success ? null : priceResult.error
                });
            } catch (error) {
                results.push({
                    providerKey: key,
                    providerName: provider.name,
                    error: error.message,
                    available: false
                });
            }
        }

        results.sort((a, b) => {
            if (a.error) return 1;
            if (b.error) return -1;
            if (a.price !== b.price) return a.price - b.price;
            return b.stock - a.stock;
        });

        return results;
    }

    /**
     * Purchase number from BEST provider
     */
    async getNumber(country, service, preferredOperator = null) {
        const best = await this.getBestPrice(country, service);
        
        if (!best) {
            throw new Error(`NO_NUMBERS: No providers have stock for ${service} in ${country}`);
        }

        const provider = this.providers.get(best.providerKey);
        if (!provider) {
            throw new Error(`PROVIDER_ERROR: ${best.providerKey} not found`);
        }

        logger.info('Routing purchase to provider', {
            country,
            service,
            provider: best.providerKey,
            price: best.price,
            operator: preferredOperator || best.operator
        });

        const result = await provider.getNumber(
            country, 
            service, 
            preferredOperator || best.operator
        );

        return {
            ...result,
            routedProvider: best.providerKey,
            routedProviderName: best.providerName,
            routedPrice: best.price,
            routedRawPrice: best.rawPrice
        };
    }

    /**
     * Check SMS on specific provider
     */
    async checkSMS(providerKey, identifier) {
        const provider = this.providers.get(providerKey);
        if (!provider) {
            throw new Error(`PROVIDER_NOT_FOUND: ${providerKey}`);
        }
        return provider.checkSMS(identifier);
    }

    /**
     * Cancel on specific provider
     */
    async cancelNumber(providerKey, identifier) {
        const provider = this.providers.get(providerKey);
        if (!provider) {
            return { success: false, error: `PROVIDER_NOT_FOUND: ${providerKey}` };
        }
        return provider.cancelNumber(identifier);
    }

    /**
     * Finish on specific provider
     */
    async finishNumber(providerKey, identifier) {
        const provider = this.providers.get(providerKey);
        if (!provider) {
            return { success: false, error: `PROVIDER_NOT_FOUND: ${providerKey}` };
        }
        return provider.finishNumber(identifier);
    }

    /**
     * Union of available countries across all providers
     */
    async getAvailableCountries(service = 'Any') {
        const allCountries = new Map();

        for (const [key, provider] of this.providers) {
            try {
                const result = await provider.getAvailableCountries(service);
                if (result.success && result.countries) {
                    for (const country of result.countries) {
                        const code = country.code || country.iso || country.simCode;
                        if (!code) continue;
                        
                        if (!allCountries.has(code)) {
                            allCountries.set(code, {
                                ...country,
                                providers: []
                            });
                        }
                        allCountries.get(code).providers.push(key);
                    }
                }
            } catch (error) {
                logger.warn('Provider country query failed', { provider: key, error: error.message });
            }
        }

        const countries = Array.from(allCountries.values())
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        return {
            success: true,
            countries,
            count: countries.length
        };
    }

    /**
     * Check all provider balances
     */
    async checkBalances() {
        const results = {};
        
        for (const [key, provider] of this.providers) {
            try {
                results[key] = provider.checkBalance 
                    ? await provider.checkBalance() 
                    : { success: false, error: 'NO_BALANCE_METHOD' };
            } catch (error) {
                results[key] = { success: false, error: error.message, balance: 0 };
            }
        }

        return results;
    }

    clearCache() {
        this._priceCache.clear();
        logger.info('ProviderRouter cache cleared');
    }

    getStats() {
        const stats = {
            registeredProviders: this.providers.size,
            providerKeys: Array.from(this.providers.keys()),
            cacheSize: this._priceCache.size
        };

        for (const [key, provider] of this.providers) {
            stats[key] = provider.getStats ? provider.getStats() : { isActive: provider.isActive };
        }

        return stats;
    }
}

export default ProviderRouter;
        
