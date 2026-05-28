// ═══════════════════════════════════════════════════════════════════════════════
//  services/ProviderRouter.js — Multi-Provider Selection Engine
//  Queries ALL cheap providers and returns the best option per country/service
//  Falls back automatically if one provider has no stock
// ═══════════════════════════════════════════════════════════════════════════════

import logger from '../../utils/logger.js';

/**
 * ProviderRouter — Routes CHEAP tier requests to the best available provider
 * 
 * Logic:
 *   1. Query ALL active cheap providers for price/availability
 *   2. Sort by: price (lowest first), then stock (highest first)
 *   3. Return best provider's data with providerKey attached
 *   4. Purchase uses the selected provider directly
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

        // Cache for provider price comparisons
        this._priceCache = new Map();
        this._cacheTtl = 30 * 1000; // 30 seconds — prices change fast
    }

    /**
     * Get all registered provider keys
     */
    getProviderKeys() {
        return Array.from(this.providers.keys());
    }

    /**
     * Get provider instance by key
     */
    getProvider(key) {
        return this.providers.get(key);
    }

    /**
     * Check if any cheap provider is available
     */
    hasAvailableProvider() {
        for (const provider of this.providers.values()) {
            if (provider.isActive) return true;
        }
        return false;
    }

    /**
     * Get best price across ALL providers for country/service
     * Returns: { providerKey, providerName, price, displayPrice, stock, operator, rawPrice }
     */
    async getBestPrice(country, service) {
        const cacheKey = `${country}:${service}:best`;
        const cached = this._priceCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < this._cacheTtl) {
            return cached.data;
        }

        const results = [];
        const errors = [];

        // Query all providers in parallel
        const promises = Array.from(this.providers.entries()).map(async ([key, provider]) => {
            try {
                const priceResult = await provider.getPrice(country, service);
                
                if (priceResult.success && priceResult.available && priceResult.stock > 0) {
                    results.push({
                        providerKey: key,
                        providerName: provider.name,
                        price: priceResult.displayPrice, // What user pays (raw + $0.10)
                        rawPrice: priceResult.simPrice,   // What provider charges
                        stock: priceResult.stock,
                        operator: priceResult.operator || 'any',
                        profit: priceResult.profit || 0.10
                    });
                }
            } catch (error) {
                errors.push({ provider: key, error: error.message });
            }
        });

        await Promise.allSettled(promises);

        if (errors.length > 0) {
            logger.debug('Provider price query errors', { errors });
        }

        if (results.length === 0) {
            logger.warn('No providers have stock', { country, service, providerCount: this.providers.size });
            return null;
        }

        // Sort by price ascending, then stock descending
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
            operator: best.operator,
            alternatives: results.length - 1
        });

        this._priceCache.set(cacheKey, {
            data: best,
            timestamp: Date.now()
        });

        return best;
    }

    /**
     * Get ALL available options across providers (for admin/debugging)
     */
    async getAllPrices(country, service) {
        const results = [];

        for (const [key, provider] of this.providers) {
            try {
                const priceResult = await provider.getPrice(country, service);
                if (priceResult.success) {
                    results.push({
                        providerKey: key,
                        providerName: provider.name,
                        price: priceResult.displayPrice,
                        rawPrice: priceResult.simPrice,
                        stock: priceResult.stock,
                        operator: priceResult.operator,
                        available: priceResult.available
                    });
                }
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
     * Get number from the BEST provider (auto-selected)
     */
    async getNumber(country, service, preferredOperator = 'any') {
        const best = await this.getBestPrice(country, service);
        
        if (!best) {
            throw new Error(`NO_NUMBERS: No providers have stock for ${service} in ${country}`);
        }

        const provider = this.providers.get(best.providerKey);
        if (!provider) {
            throw new Error(`PROVIDER_ERROR: Selected provider ${best.providerKey} not found`);
        }

        logger.info('Routing purchase to best provider', {
            country,
            service,
            provider: best.providerKey,
            price: best.price,
            operator: preferredOperator
        });

        const result = await provider.getNumber(country, service, preferredOperator);

        // Attach provider key so downstream knows which provider was used
        return {
            ...result,
            routedProvider: best.providerKey,
            routedProviderName: best.providerName,
            routedPrice: best.price,
            routedRawPrice: best.rawPrice
        };
    }

    /**
     * Check SMS using the correct provider
     */
    async checkSMS(providerKey, identifier) {
        const provider = this.providers.get(providerKey);
        if (!provider) {
            throw new Error(`PROVIDER_NOT_FOUND: ${providerKey}`);
        }
        return provider.checkSMS(identifier);
    }

    /**
     * Cancel number using the correct provider
     */
    async cancelNumber(providerKey, identifier) {
        const provider = this.providers.get(providerKey);
        if (!provider) {
            return { success: false, error: `PROVIDER_NOT_FOUND: ${providerKey}` };
        }
        return provider.cancelNumber(identifier);
    }

    /**
     * Finish number using the correct provider
     */
    async finishNumber(providerKey, identifier) {
        const provider = this.providers.get(providerKey);
        if (!provider) {
            return { success: false, error: `PROVIDER_NOT_FOUND: ${providerKey}` };
        }
        return provider.finishNumber(identifier);
    }

    /**
     * Get available countries across ALL providers (union)
     */
    async getAvailableCountries(service = 'Any') {
        const allCountries = new Map(); // code -> { code, name, providers: [] }

        for (const [key, provider] of this.providers) {
            try {
                const result = await provider.getAvailableCountries(service);
                if (result.success && result.countries) {
                    for (const country of result.countries) {
                        if (!allCountries.has(country.code)) {
                            allCountries.set(country.code, {
                                ...country,
                                providers: []
                            });
                        }
                        allCountries.get(country.code).providers.push(key);
                    }
                }
            } catch (error) {
                logger.warn('Provider country query failed', { provider: key, error: error.message });
            }
        }

        const countries = Array.from(allCountries.values())
            .sort((a, b) => a.name.localeCompare(b.name));

        return {
            success: true,
            countries,
            count: countries.length
        };
    }

    /**
     * Check balance across all providers
     */
    async checkBalances() {
        const results = {};
        
        for (const [key, provider] of this.providers) {
            try {
                results[key] = await provider.checkBalance();
            } catch (error) {
                results[key] = { success: false, error: error.message };
            }
        }

        return results;
    }

    clearCache() {
        this._priceCache.clear();
        logger.info('ProviderRouter price cache cleared');
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
                          
