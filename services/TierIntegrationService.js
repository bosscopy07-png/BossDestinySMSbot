// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierIntegrationService.js — Tier Flow Orchestration Layer
//  COMPLETE REWRITE:
//   1. FIXED: Queries ALL providers for cheapest tier baseline price
//   2. FIXED: Preserves original service name through entire purchase flow
//   3. FIXED: Cross-provider fallback on purchase failure (same tier only)
//   4. FIXED: Country selection now checks ALL virtuals in tier, not just one
//   5. Cache TTL: 60 minutes with auto-prewarm
//   6. Provider fallback chain: 5sim → SMSPool → Hero → OnlineSim
// ═══════════════════════════════════════════════════════════════════════════════

import { TIER_CONFIG, CACHE_TTL, getTierConfig } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

/**
 * TierIntegrationService — Central orchestrator for the 3-tier CHEAP flow
 * 
 * Pricing Model:
 *   - rawPrice      = provider's base cost for the number
 *   - displayCost   = rawPrice + BASE_PROFIT ($0.10)
 *   - finalPrice    = displayCost × tier.priceMultiplier
 *   - Budget:   1.00× = no extra markup (profit = $0.10)
 *   - Standard: 1.15× = +15% extra profit
 *   - Premium:  1.35× = +35% extra profit
 * 
 * Provider Fallback Chain:
 *   1. CHEAP_PANEL (5sim) — primary
 *   2. SMSPOOL — secondary
 *   3. HERO_SMS — tertiary
 *   4. ONLINE_SIM — quaternary
 */
class TierIntegrationService {
    static BASE_PROFIT = 0.10;
    static BASELINE_CACHE_TTL = 60 * 60 * 1000;
    static FALLBACK_MAX_ATTEMPTS = 3;

    constructor(smsProviderManager, options = {}) {
        this.providerManager = smsProviderManager;
        
        this._serviceCatalog = null;
        this._tierSelector = null;
        this._countryCatalog = null;
        this._cheapProvider = null;
        this._onlineSimProvider = null;
        this._smsPoolProvider = null;
        this._heroSmsProvider = null;
        this._providerRouter = null;
        
        this._baselinePriceCache = new Map();
        
        this._enabled = options.enableTierFlow !== false;
        this._legacyFallback = options.legacyFallback !== false;
        
        this._metrics = {
            tierSelections: 0,
            tierPurchases: 0,
            tierFallbacks: 0,
            crossProviderFallbacks: 0,
            legacyFallbacks: 0,
            errors: 0
        };

        this._cacheRefreshInterval = null;

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
            this._onlineSimProvider = this.providerManager?.getProvider('ONLINE_SIM');
            this._smsPoolProvider = this.providerManager?.getProvider('SMSPOOL');
            this._heroSmsProvider = this.providerManager?.getProvider('HERO_SMS');
            
            if (!this._cheapProvider) {
                logger.warn('CHEAP_PANEL provider not found, tier flow unavailable');
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
            const { default: ProviderRouter } = await import('./sms/ProviderRouter.js');

            const allProviders = [];
            if (this._cheapProvider?.isActive) allProviders.push(this._cheapProvider);
            if (this._smsPoolProvider?.isActive) allProviders.push(this._smsPoolProvider);
            if (this._heroSmsProvider?.isActive) allProviders.push(this._heroSmsProvider);
            if (this._onlineSimProvider?.isActive) allProviders.push(this._onlineSimProvider);

            this._serviceCatalog = new ServiceCatalog(this._cheapProvider);
            this._tierSelector = new TierOperatorSelector(allProviders);
            this._countryCatalog = new CountryCatalog(this._cheapProvider, this._tierSelector);
            this._providerRouter = new ProviderRouter(allProviders);

            this._startCachePrewarm();

            logger.info('TierIntegrationService initialized successfully', {
                servicesIndexed: !!this._serviceCatalog,
                countriesIndexed: !!this._countryCatalog,
                tiersConfigured: Object.keys(TIER_CONFIG).length,
                providers: allProviders.map(p => p.providerKey || p.name)
            });

        } catch (error) {
            logger.error('TierIntegrationService initialization failed', { error: error.message });
            this._enabled = false;
            if (!this._legacyFallback) {
                throw error;
            }
        }
    }

    _startCachePrewarm() {
        this._prewarmAllCaches().catch(() => {});
        this._cacheRefreshInterval = setInterval(() => {
            this._prewarmAllCaches().catch(err => 
                logger.debug('Cache prewarm failed', { error: err.message })
            );
        }, 50 * 60 * 1000);
    }

    async _prewarmAllCaches() {
        try {
            if (this._cheapProvider?.isActive) {
                await this._cheapProvider.prewarmCache();
            }
            if (this._smsPoolProvider?.isActive && this._smsPoolProvider.prewarmCache) {
                await this._smsPoolProvider.prewarmCache();
            }
            if (this._heroSmsProvider?.isActive && this._heroSmsProvider.prewarmCache) {
                await this._heroSmsProvider.prewarmCache();
            }
            logger.info('All caches prewarmed');
        } catch (error) {
            logger.warn('Cache prewarm error', { error: error.message });
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
    //  FIXED: Queries ALL providers, gets ALL virtuals, shows cheapest per tier
    // ═══════════════════════════════════════════════════════════════════════

    getAllTierInfos() {
        if (!this.isAvailable()) return null;
        return this._tierSelector.getAllTierInfos();
    }

    getTierInfo(tierKey) {
        if (!this.isAvailable()) return null;
        return this._tierSelector.getTierInfo(tierKey);
    }

    /**
     * Get tier baseline prices for a service (for UI display)
     * FIXED: Now queries ALL virtuals in tier range across ALL providers
     */
    async getTierBaselinePrices(service, country = 'US') {
        if (!this.isAvailable()) return null;

        const cacheKey = `${service}:${country}`;
        const cached = this._baselinePriceCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < TierIntegrationService.BASELINE_CACHE_TTL) {
            return cached.data;
        }

        const results = [];
        const tierInfos = this._tierSelector.getAllTierInfos();

        for (const tier of tierInfos) {
            try {
                // FIXED: selectOperator now checks ALL virtuals in tier range
                const baseline = await this._tierSelector.selectOperator(
                    tier.key, country, service, { timeoutMs: 8000 }
                ).catch(() => null);

                const rawPrice = baseline?.price || 0;
                const displayCost = Number((rawPrice + TierIntegrationService.BASE_PROFIT).toFixed(4));
                const finalPrice = Number((displayCost * tier.priceMultiplier).toFixed(2));
                const extraProfit = Number((finalPrice - displayCost).toFixed(2));

                results.push({
                    tierKey: tier.key,
                    label: tier.label,
                    emoji: tier.emoji,
                    description: tier.description,
                    badge: tier.badge,
                    priceMultiplier: tier.priceMultiplier,
                    baselinePrice: finalPrice,
                    displayCost: displayCost,
                    rawPrice: rawPrice,
                    baseProfit: TierIntegrationService.BASE_PROFIT,
                    extraProfit: extraProfit,
                    baselineStock: baseline?.stock || 0,
                    operatorCount: baseline?.allCandidatesCount || tier.operatorCount,
                    viableOperators: baseline?.viableCandidatesCount || 0,
                    bestOperator: baseline?.operator || null,
                    providerKey: baseline?.providerKey || null,
                    provider: baseline?.provider || null,
                    cheapestProvider: baseline?.providerKey || null
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
                    displayCost: null,
                    rawPrice: null,
                    baseProfit: TierIntegrationService.BASE_PROFIT,
                    extraProfit: 0,
                    baselineStock: 0,
                    operatorCount: tier.operatorCount,
                    viableOperators: 0,
                    bestOperator: null,
                    providerKey: null,
                    provider: null,
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
        if (!this.isAvailable()) {
            return { available: false, reason: 'TIER_SYSTEM_UNAVAILABLE' };
        }
        // FIXED: hasTierStock now checks ALL virtuals in tier
        return this._tierSelector.hasTierStock(tierKey, country, service);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTION (Step 3)
    //  FIXED: CountryCatalog now uses getAvailableCountriesForService
    //  which checks ALL virtuals in tier range
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
    //  Cross-provider fallback: same tier, different provider/operator
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

        let selection = null;
        const originalService = service;

        try {
            // Step 1: Select best operator across ALL providers and ALL virtuals
            selection = await this._tierSelector.selectOperator(
                tierKey, country, service, { 
                    timeoutMs: options.timeoutMs || 15000,
                    skipCache: options.skipCache || false
                }
            );

            if (!selection.operator) {
                throw new Error('NO_OPERATOR: No operator selected');
            }

            // Step 2: Build purchase payload
            const purchasePayload = {
                country, 
                service: originalService,
                operator: selection.operator
            };

            logger.info('Purchasing with selected operator', {
                selectedOperator: selection.operator,
                tier: tierKey,
                country,
                originalService,
                mappedService: selection.mappedService,
                expectedPrice: selection.price,
                expectedDisplayPrice: selection.displayPrice,
                provider: selection.providerKey,
                totalCandidates: selection.allCandidatesCount,
                viableCandidates: selection.viableCandidatesCount
            });

            // Step 3: Execute purchase
            let usedProvider = this._getProviderByKey(selection.providerKey);

            if (!usedProvider) {
                throw new Error(`PROVIDER_NOT_FOUND: ${selection.providerKey}`);
            }

            const purchaseResult = await usedProvider.getNumber(
                purchasePayload.country, 
                purchasePayload.service, 
                purchasePayload.operator
            );

            this._metrics.tierPurchases++;

            const displayCost = purchaseResult.displayCost || selection.displayPrice || 0;
            const tier = getTierConfig(tierKey);
            const finalPrice = Number((displayCost * tier.priceMultiplier).toFixed(2));
            const extraProfit = Number((finalPrice - displayCost).toFixed(2));

            logger.info('Tier purchase successful', {
                tier: tierKey,
                country,
                originalService,
                mappedService: purchaseResult.mappedService || selection.mappedService,
                operator: selection.operator,
                purchasedOperator: purchaseResult.operator || selection.operator,
                provider: selection.providerKey,
                displayCost,
                finalPrice,
                baseProfit: TierIntegrationService.BASE_PROFIT,
                extraProfit,
                duration: Date.now() - startTime
            });

            return {
                success: true,
                phoneNumber: purchaseResult.phoneNumber,
                providerNumberId: purchaseResult.providerNumberId,
                operator: selection.operator,
                purchasedOperator: purchaseResult.operator || selection.operator,
                routedProvider: selection.providerKey,
                price: finalPrice,
                displayPrice: finalPrice,
                displayCost: displayCost,
                rawPrice: purchaseResult.cost || 0,
                baseProfit: TierIntegrationService.BASE_PROFIT,
                extraProfit: extraProfit,
                stock: selection.stock,
                score: selection.score,
                tier: tierKey,
                country,
                service: originalService,
                mappedService: purchaseResult.mappedService || selection.mappedService
            };

        } catch (error) {
            this._metrics.errors++;

            const shouldFallback = [
                'NO_NUMBERS',
                'NOT_AVAILABLE',
                'TIMEOUT',
                'INVALID_RESPONSE',
                'PROVIDER_ERROR',
                'NO_OPERATOR'
            ].some(code => error.message?.includes(code));

            if (options.allowFallback !== false && shouldFallback) {
                logger.warn('Primary purchase failed, attempting fallback', {
                    tier: tierKey,
                    country,
                    originalService,
                    error: error.message,
                    failedOperator: selection?.operator,
                    failedProvider: selection?.providerKey
                });

                return this._attemptFallbackPurchase(
                    tierKey, country, originalService, options, error, selection
                );
            }

            logger.error('Tier purchase failed', {
                tier: tierKey, country, originalService, error: error.message, duration: Date.now() - startTime
            });

            return {
                success: false,
                error: this._normalizeError(error),
                recoverable: this._isRecoverable(error),
                tier: tierKey,
                country,
                service: originalService
            };
        }
    }

    /**
     * Attempt fallback purchase
     * Strategy:
     *   1. Try other operators in same tier on SAME provider
     *   2. Try same tier on OTHER providers
     *   3. Return failure if all exhausted
     */
    
        async _attemptFallbackPurchase(tierKey, country, originalService, options, originalError, failedSelection = null) {
        this._metrics.tierFallbacks++;

        const failedOperator = failedSelection?.operator;
        const failedProvider = failedSelection?.providerKey;

        try {
            // Phase 1: Try other operators in same tier
            const fallbackOps = await this._tierSelector.getFallbackOperators(
                tierKey, country, originalService, failedOperator
            );

            if (fallbackOps?.length > 0) {
                for (const fallback of fallbackOps.slice(0, TierIntegrationService.FALLBACK_MAX_ATTEMPTS)) {
                    // Skip same provider as failed (we want cross-provider)
                    if (fallback.providerKey === failedProvider) continue;

                    try {
                        const provider = this._getProviderByKey(fallback.providerKey);
                        if (!provider) continue;

                        const purchaseResult = await provider.getNumber(
                            country, originalService, fallback.operator
                        );

                        this._metrics.tierPurchases++;
                        this._metrics.crossProviderFallbacks++;

                        const displayCost = purchaseResult.displayCost || fallback.displayPrice || 0;
                        const tier = getTierConfig(tierKey);
                        const finalPrice = Number((displayCost * tier.priceMultiplier).toFixed(2));
                        const extraProfit = Number((finalPrice - displayCost).toFixed(2));

                        logger.info('Cross-provider fallback purchase successful', {
                            tier: tierKey,
                            country,
                            originalService,
                            failedProvider,
                            fallbackProvider: fallback.providerKey,
                            fallbackOperator: fallback.operator,
                            displayCost,
                            finalPrice
                        });

                        return {
                            success: true,
                            phoneNumber: purchaseResult.phoneNumber,
                            providerNumberId: purchaseResult.providerNumberId,
                            operator: fallback.operator,
                            routedProvider: fallback.providerKey,
                            price: finalPrice,
                            displayPrice: finalPrice,
                            displayCost: displayCost,
                            rawPrice: purchaseResult.cost || 0,
                            baseProfit: TierIntegrationService.BASE_PROFIT,
                            extraProfit: extraProfit,
                            stock: fallback.stock,
                            score: fallback.score,
                            tier: tierKey,
                            country,
                            service: originalService,
                            fallback: true,
                            crossProvider: true
                        };

                    } catch (fallbackError) {
                        logger.warn('Fallback operator failed', {
                            tier: tierKey,
                            operator: fallback.operator,
                            provider: fallback.providerKey,
                            error: fallbackError.message
                        });
                        continue;
                    }
                }
            }

            // Phase 2: Try same tier on other providers directly with 'any'
            const otherProviders = this._getOtherProviders(failedProvider);
            for (const provider of otherProviders) {
                try {
                    const purchaseResult = await provider.getNumber(
                        country, originalService, 'any'
                    );

                    this._metrics.tierPurchases++;
                    this._metrics.crossProviderFallbacks++;

                    const displayCost = purchaseResult.displayCost || 0;
                    const tier = getTierConfig(tierKey);
                    const finalPrice = Number((displayCost * tier.priceMultiplier).toFixed(2));

                    logger.info('Provider direct fallback successful', {
                        tier: tierKey,
                        country,
                        originalService,
                        fallbackProvider: provider.providerKey
                    });

                    return {
                        success: true,
                        phoneNumber: purchaseResult.phoneNumber,
                        providerNumberId: purchaseResult.providerNumberId,
                        operator: purchaseResult.operator || 'any',
                        routedProvider: provider.providerKey,
                        price: finalPrice,
                        displayPrice: finalPrice,
                        displayCost: displayCost,
                        rawPrice: purchaseResult.cost || 0,
                        baseProfit: TierIntegrationService.BASE_PROFIT,
                        extraProfit: Number((finalPrice - displayCost).toFixed(2)),
                        tier: tierKey,
                        country,
                        service: originalService,
                        fallback: true,
                        crossProvider: true
                    };

                } catch (providerError) {
                    logger.warn('Provider direct fallback failed', {
                        provider: provider.providerKey,
                        error: providerError.message
                    });
                    continue;
                }
            }

            return {
                success: false,
                error: 'TIER_NO_STOCK: All fallback operators and providers exhausted',
                recoverable: false,
                fallbackAttempted: true,
                tier: tierKey,
                country,
                service: originalService
            };

        } catch (error) {
            return {
                success: false,
                error: this._normalizeError(originalError),
                recoverable: false,
                fallbackAttempted: true,
                fallbackError: error.message,
                tier: tierKey,
                country,
                service: originalService
            };
        }
    }

    _getProviderByKey(key) {
        const providers = {
            'CHEAP_PANEL': this._cheapProvider,
            'ONLINE_SIM': this._onlineSimProvider,
            'SMSPOOL': this._smsPoolProvider,
            'HERO_SMS': this._heroSmsProvider
        };
        return providers[key];
    }

    _getOtherProviders(excludeKey) {
        const all = [
            this._cheapProvider,
            this._smsPoolProvider,
            this._heroSmsProvider,
            this._onlineSimProvider
        ].filter(p => p && p.isActive && p.providerKey !== excludeKey);

        const priority = ['CHEAP_PANEL', 'SMSPOOL', 'HERO_SMS', 'ONLINE_SIM'];
        return all.sort((a, b) => {
            const idxA = priority.indexOf(a.providerKey);
            const idxB = priority.indexOf(b.providerKey);
            if (idxA === -1) return 1;
            if (idxB === -1) return -1;
            return idxA - idxB;
        });
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
        
        const errorMap = {
            'TIER_NO_STOCK': 'NO_NUMBERS',
            'NO_BALANCE': 'NO_BALANCE',
            'INSUFFICIENT_FUNDS': 'NO_BALANCE',
            'NOT_AVAILABLE': 'NOT_AVAILABLE',
            'TIMEOUT': 'TIMEOUT',
            'INVALID_TIER': 'INVALID_TIER',
            'TIER_EMPTY': 'TIER_EMPTY',
            'BAD_COUNTRY': 'BAD_COUNTRY',
            'BAD_SERVICE': 'BAD_SERVICE',
            'NO_NUMBERS': 'NO_NUMBERS',
            'NO_OPERATOR': 'NO_NUMBERS',
            'INVALID_RESPONSE': 'NOT_AVAILABLE',
            'PROVIDER_ERROR': 'NOT_AVAILABLE',
            'PROVIDER_NOT_FOUND': 'NOT_AVAILABLE'
        };

        for (const [key, value] of Object.entries(errorMap)) {
            if (message.includes(key)) return value;
        }
        
        return 'PROVIDER_ERROR';
    }

    _isRecoverable(error) {
        const message = error?.message || '';
        const recoverableCodes = ['NO_NUMBERS', 'NOT_AVAILABLE', 'TIMEOUT', 'CONNECTION_ERROR', 'NO_OPERATOR'];
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
                cheapProvider: this._cheapProvider !== null && this._cheapProvider.isActive,
                smsPoolProvider: this._smsPoolProvider !== null && this._smsPoolProvider.isActive,
                heroSmsProvider: this._heroSmsProvider !== null && this._heroSmsProvider.isActive,
                onlineSimProvider: this._onlineSimProvider !== null && this._onlineSimProvider.isActive,
                providerRouter: this._providerRouter !== null
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
        this._providerRouter?.clearCache();
        logger.info('TierIntegrationService caches cleared');
    }

    destroy() {
        if (this._cacheRefreshInterval) {
            clearInterval(this._cacheRefreshInterval);
            this._cacheRefreshInterval = null;
        }
        this.clearCaches();
        logger.info('TierIntegrationService destroyed');
    }
}

export default TierIntegrationService;
