// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierIntegrationService.js — Tier Flow Orchestration Layer
//  Bridges ServiceCatalog → TierOperatorSelector → CountryCatalog → SMSProviderManager
//  Zero breaking changes to existing architecture.
// ═══════════════════════════════════════════════════════════════════════════════

import { TIER_CONFIG, CACHE_TTL } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

const PROFIT_MARGIN = 0.20; // $0.20 profit per number

/**
 * Apply profit margin to a raw provider price
 */
function applyProfitMargin(rawPrice) {
    if (rawPrice === null || rawPrice === undefined || isNaN(rawPrice)) return null;
    return parseFloat((rawPrice + PROFIT_MARGIN).toFixed(4));
}

/**
 * TierIntegrationService — Central orchestrator for the 3-tier CHEAP flow
 */
class TierIntegrationService {
    constructor(smsProviderManager, options = {}) {
        this.providerManager = smsProviderManager;
        
        this._serviceCatalog = null;
        this._tierSelector = null;
        this._countryCatalog = null;
        this._cheapProvider = null;
        
        this._baselinePriceCache = new Map();
        this._baselineCacheTtl = 60 * 1000;
        
        this._enabled = options.enableTierFlow !== false;
        this._legacyFallback = options.legacyFallback !== false;
        
        this._metrics = {
            tierSelections: 0,
            tierPurchases: 0,
            tierFallbacks: 0,
            legacyFallbacks: 0,
            errors: 0
        };

        logger.info('TierIntegrationService created', {
            enabled: this._enabled,
            legacyFallback: this._legacyFallback
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════

    async initialize() {
        if (!this._enabled) {
            logger.info('Tier flow disabled, skipping initialization');
            return;
        }

        try {
            this._cheapProvider = this.providerManager?.getProvider('CHEAP_PANEL');
            
            if (!this._cheapProvider) {
                logger.warn('CHEAP_PANEL provider not found in manager, tier flow unavailable');
                this._enabled = false;
                return;
            }

            if (!this._cheapProvider.isActive) {
                logger.warn('CHEAP_PANEL provider inactive, tier flow unavailable');
                this._enabled = false;
                return;
            }

            const { default: ServiceCatalog } = await import('./ServiceCatalog.js');
            const { default: TierOperatorSelector } = await import('./TierOperatorSelector.js');
            const { default: CountryCatalog } = await import('./CountryCatalog.js');

            this._serviceCatalog = new ServiceCatalog(this._cheapProvider);
            this._tierSelector = new TierOperatorSelector(this._cheapProvider);
            this._countryCatalog = new CountryCatalog(this._cheapProvider, this._tierSelector);

            logger.info('TierIntegrationService initialized successfully', {
                servicesIndexed: this._serviceCatalog ? 'yes' : 'no',
                countriesIndexed: this._countryCatalog ? 'yes' : 'no',
                tiersConfigured: Object.keys(TIER_CONFIG).length
            });

        } catch (error) {
            logger.error('TierIntegrationService initialization failed', { error: error.message });
            this._enabled = false;
            if (!this._legacyFallback) {
                throw error;
            }
        }
    }

    isAvailable() {
        return this._enabled && 
               this._serviceCatalog !== null && 
               this._tierSelector !== null && 
               this._countryCatalog !== null &&
               this._cheapProvider !== null &&
               this._cheapProvider.isActive;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SERVICE SELECTION (Step 1)
    // ═══════════════════════════════════════════════════════════════════════

    async getPopularServices() {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.getPopularServices();
    }

    async searchServices(query, limit = 30) {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.searchServices(query, limit);
    }

    async getServicesByCategory(category) {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.getServicesByCategory(category);
    }

    async getCategories() {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.getCategories();
    }

    async getServicesPage(page, perPage, filter = null) {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.getServicesPage(page, perPage, filter);
    }

    async isValidService(serviceName) {
        if (!this.isAvailable()) return false;
        return this._serviceCatalog.hasService(serviceName);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TIER SELECTION (Step 2)
    // ═══════════════════════════════════════════════════════════════════════

    getAllTierInfos() {
        if (!this.isAvailable()) return null;
        return this._tierSelector.getAllTierInfos();
    }

    getTierInfo(tierKey) {
        if (!this.isAvailable()) return null;
        return this._tierSelector.getTierInfo(tierKey);
    }

    async getTierBaselinePrices(service, country = 'US') {
        if (!this.isAvailable()) return null;

        const cacheKey = `${service}:${country}`;
        const cached = this._baselinePriceCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < this._baselineCacheTtl) {
            return cached.data;
        }

        const results = [];
        const tierInfos = this._tierSelector.getAllTierInfos();

        for (const tier of tierInfos) {
            try {
                const baseline = await this._tierSelector.selectOperator(
                    tier.key, country, service, { timeoutMs: 8000 }
                ).catch(() => null);

                const rawPrice = baseline?.displayPrice || baseline?.price || null;
                const markedUpPrice = applyProfitMargin(rawPrice);

                results.push({
                    tierKey: tier.key,
                    label: tier.label,
                    emoji: tier.emoji,
                    description: tier.description,
                    badge: tier.badge,
                    priceMultiplier: tier.priceMultiplier,
                    baselinePrice: markedUpPrice,
                    rawPrice: rawPrice,
                    baselineStock: baseline?.stock || 0,
                    operatorCount: tier.operatorCount
                });
            } catch (error) {
                results.push({
                    tierKey: tier.key,
                    label: tier.label,
                    emoji: tier.emoji,
                    description: tier.description,
                    badge: tier.badge,
                    priceMultiplier: tier.priceMultiplier,
                    baselinePrice: null,
                    rawPrice: null,
                    baselineStock: 0,
                    operatorCount: tier.operatorCount,
                    error: error.message
                });
            }
        }

        this._baselinePriceCache.set(cacheKey, {
            data: results,
            timestamp: Date.now()
        });

        return results;
    }

    async hasTierStock(tierKey, country, service) {
        if (!this.isAvailable()) return { available: false, reason: 'TIER_SYSTEM_UNAVAILABLE' };
        return this._tierSelector.hasTierStock(tierKey, country, service);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTION (Step 3)
    // ═══════════════════════════════════════════════════════════════════════

    async getCountriesForService(service, tierKey, options = {}) {
        if (!this.isAvailable()) {
            return { 
                countries: [], 
                pagination: { page: 1, perPage: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false }, 
                tierInfo: null,
                error: 'TIER_SYSTEM_UNAVAILABLE'
            };
        }

        try {
            return await this._countryCatalog.getCountriesForService(service, tierKey, options);
        } catch (error) {
            logger.error('Country catalog failed', { service, tierKey, error: error.message });
            return {
                countries: [],
                pagination: { page: 1, perPage: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
                tierInfo: this._tierSelector.getTierInfo(tierKey),
                error: error.message
            };
        }
    }

    searchCountries(query) {
        if (!this.isAvailable()) return [];
        return this._countryCatalog.searchCountries(query);
    }

    async getTopCountries(service, tierKey, limit = 20) {
        if (!this.isAvailable()) return { countries: [], tierInfo: null };
        return this._countryCatalog.getTopCountries(service, tierKey, limit);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PURCHASE ORCHESTRATION (Step 4)
    // ═══════════════════════════════════════════════════════════════════════

    async purchaseNumber(tierKey, country, service, options = {}) {
        if (!this.isAvailable()) {
            return { 
                success: false, 
                error: 'TIER_SYSTEM_UNAVAILABLE',
                recoverable: true 
            };
        }

        const startTime = Date.now();
        this._metrics.tierSelections++;

        try {
            const selection = await this._tierSelector.selectOperator(
                tierKey, country, service, { 
                    timeoutMs: options.timeoutMs || 15000,
                    skipCache: options.skipCache || false
                }
            );

            const purchaseResult = await this._cheapProvider.getNumber(
                country, service, selection.operator
            );

            this._metrics.tierPurchases++;

            const finalPrice = applyProfitMargin(selection.price);
            const finalDisplayPrice = applyProfitMargin(selection.displayPrice);

            logger.info('Tier purchase successful', {
                tier: tierKey,
                country,
                service,
                operator: selection.operator,
                price: finalPrice,
                displayPrice: finalDisplayPrice,
                rawPrice: selection.price,
                duration: Date.now() - startTime
            });

            return {
                success: true,
                phoneNumber: purchaseResult.phoneNumber,
                providerNumberId: purchaseResult.providerNumberId,
                operator: selection.operator,
                price: finalPrice,
                displayPrice: finalDisplayPrice,
                rawPrice: selection.price,
                rawDisplayPrice: selection.displayPrice,
                stock: selection.stock,
                score: selection.score,
                tier: tierKey,
                country,
                service,
                providerCost: purchaseResult.cost,
                providerDisplayCost: purchaseResult.displayCost
            };

        } catch (error) {
            this._metrics.errors++;

            if (options.allowFallback !== false && 
                (error.message?.includes('NO_NUMBERS') || 
                 error.message?.includes('NOT_AVAILABLE') ||
                 error.message?.includes('TIMEOUT'))) {
                
                return this._attemptFallbackPurchase(tierKey, country, service, options, error);
            }

            logger.error('Tier purchase failed', {
                tier: tierKey, country, service, error: error.message, duration: Date.now() - startTime
            });

            return {
                success: false,
                error: this._normalizeError(error),
                recoverable: this._isRecoverable(error),
                tier: tierKey,
                country,
                service
            };
        }
    }

    async _attemptFallbackPurchase(tierKey, country, service, options, originalError) {
        this._metrics.tierFallbacks++;

        try {
            const fallbackOps = await this._tierSelector.getFallbackOperators(
                tierKey, country, service, null
            );

            if (!fallbackOps || fallbackOps.length === 0) {
                return {
                    success: false,
                    error: `TIER_NO_STOCK: No operators available in ${tierKey} tier`,
                    recoverable: false,
                    fallbackAttempted: true
                };
            }

            for (const fallback of fallbackOps.slice(0, 3)) {
                try {
                    const purchaseResult = await this._cheapProvider.getNumber(
                        country, service, fallback.operator
                    );

                    this._metrics.tierPurchases++;

                    const finalPrice = applyProfitMargin(fallback.price);
                    const finalDisplayPrice = applyProfitMargin(fallback.displayPrice);

                    logger.info('Fallback purchase successful', {
                        tier: tierKey,
                        country,
                        service,
                        originalOperator: originalError?.operator || 'unknown',
                        fallbackOperator: fallback.operator,
                        score: fallback.score,
                        price: finalPrice,
                        displayPrice: finalDisplayPrice
                    });

                    return {
                        success: true,
                        phoneNumber: purchaseResult.phoneNumber,
                        providerNumberId: purchaseResult.providerNumberId,
                        operator: fallback.operator,
                        price: finalPrice,
                        displayPrice: finalDisplayPrice,
                        rawPrice: fallback.price,
                        rawDisplayPrice: fallback.displayPrice,
                        stock: fallback.stock,
                        score: fallback.score,
                        tier: tierKey,
                        country,
                        service,
                        fallback: true
                    };

                } catch (fallbackError) {
                    logger.warn('Fallback operator failed', {
                        tier: tierKey,
                        operator: fallback.operator,
                        error: fallbackError.message
                    });
                    continue;
                }
            }

            return {
                success: false,
                error: 'TIER_NO_STOCK: All fallback operators exhausted',
                recoverable: false,
                fallbackAttempted: true
            };

        } catch (error) {
            return {
                success: false,
                error: this._normalizeError(originalError),
                recoverable: false,
                fallbackAttempted: true,
                fallbackError: error.message
            };
        }
    }

    async getFallbackOperators(tierKey, country, service, excludeOperator = null) {
        if (!this.isAvailable()) return [];
        return this._tierSelector.getFallbackOperators(tierKey, country, service, excludeOperator);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  LEGACY COMPATIBILITY
    // ═══════════════════════════════════════════════════════════════════════

    async getLegacyCheapPrice(country, service) {
        try {
            return await this.providerManager.getCheapPrice(country, service);
        } catch (error) {
            return null;
        }
    }

    async getLegacyCheapNumber(country, service) {
        return this.providerManager.getCheapNumber(country, service);
    }

    async getLegacyCheapCountries(service) {
        return this.providerManager.getCheapCountries(service);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ERROR HANDLING
    // ═══════════════════════════════════════════════════════════════════════

    _normalizeError(error) {
        const message = error?.message || error?.toString() || 'Unknown error';
        
        if (message.includes('TIER_NO_STOCK')) return 'NO_NUMBERS';
        if (message.includes('NO_BALANCE')) return 'NO_BALANCE';
        if (message.includes('NOT_AVAILABLE')) return 'NOT_AVAILABLE';
        if (message.includes('TIMEOUT')) return 'TIMEOUT';
        if (message.includes('INVALID_TIER')) return 'INVALID_TIER';
        if (message.includes('TIER_EMPTY')) return 'TIER_EMPTY';
        if (message.includes('BAD_COUNTRY')) return 'BAD_COUNTRY';
        if (message.includes('BAD_SERVICE')) return 'BAD_SERVICE';
        if (message.includes('NO_NUMBERS')) return 'NO_NUMBERS';
        
        return 'PROVIDER_ERROR';
    }

    _isRecoverable(error) {
        const message = error?.message || '';
        const recoverableCodes = ['NO_NUMBERS', 'NOT_AVAILABLE', 'TIMEOUT', 'CONNECTION_ERROR'];
        return recoverableCodes.some(code => message.includes(code));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  METRICS & HEALTH
    // ═══════════════════════════════════════════════════════════════════════

    getMetrics() {
        return { ...this._metrics };
    }

    getHealth() {
        return {
            available: this.isAvailable(),
            enabled: this._enabled,
            legacyFallback: this._legacyFallback,
            components: {
                serviceCatalog: this._serviceCatalog !== null,
                tierSelector: this._tierSelector !== null,
                countryCatalog: this._countryCatalog !== null,
                cheapProvider: this._cheapProvider !== null && this._cheapProvider.isActive
            },
            metrics: this._metrics,
            cacheSizes: {
                baselinePrices: this._baselinePriceCache.size
            }
        };
    }

    clearCaches() {
        this._baselinePriceCache.clear();
        this._countryCatalog?.clearCache();
        this._tierSelector?.clearCaches();
        this._serviceCatalog?.clearCache();
        logger.info('TierIntegrationService caches cleared');
    }
}

export default TierIntegrationService;
                    
