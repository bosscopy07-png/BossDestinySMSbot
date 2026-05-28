// ═══════════════════════════════════════════════════════════════════════════════
//  services/TierIntegrationService.js — Tier Flow Orchestration Layer
//  Bridges ServiceCatalog → TierOperatorSelector → CountryCatalog → ProviderRouter
//  Zero breaking changes to existing architecture.
// ═══════════════════════════════════════════════════════════════════════════════

import { TIER_CONFIG, CACHE_TTL, getTierConfig } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

/**
 * TierIntegrationService — Central orchestrator for the 3-tier CHEAP flow
 * 
 * Pricing Model (FIXED):
 *   - displayCost = raw provider price + $0.10 (from CheapPanelProvider.getDisplayPrice)
 *   - finalPrice = displayCost × tier.priceMultiplier
 *   - Budget:  1.0× = no extra markup
 *   - Standard: 1.15× = +15% extra profit
 *   - Premium: 1.35× = +35% extra profit
 * 
 * Responsibilities:
 *   - Initializes and wires all tier components
 *   - Provides single entry point for bot handlers
 *   - Normalizes errors across the flow
 *   - Manages cross-cutting concerns (caching, logging, metrics)
 *   - Falls back to legacy flow if tier system unavailable
 */
class TierIntegrationService {
    constructor(smsProviderManager, options = {}) {
        this.providerManager = smsProviderManager;
        
        // Lazy-loaded components (initialized on first use)
        this._serviceCatalog = null;
        this._tierSelector = null;
        this._countryCatalog = null;
        this._cheapProvider = null;
        this._providerRouter = null;
        
        // Cache for tier baseline prices (used in tier selection UI)
        this._baselinePriceCache = new Map();
        this._baselineCacheTtl = 60 * 1000; // 1 minute
        
        // Feature flags
        this._enabled = options.enableTierFlow !== false;
        this._legacyFallback = options.legacyFallback !== false;
        
        // Metrics
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

    /**
     * Initialize all tier components. Call once after construction.
     */
    async initialize() {
        if (!this._enabled) {
            logger.info('Tier flow disabled, skipping initialization');
            return;
        }

        try {
            // Get CheapPanelProvider instance from manager
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

            // Dynamic imports to avoid circular dependencies
            const { default: ServiceCatalog } = await import('./ServiceCatalog.js');
            const { default: TierOperatorSelector } = await import('./TierOperatorSelector.js');
            const { default: CountryCatalog } = await import('./CountryCatalog.js');
            const { default: ProviderRouter } = await import('./sms/ProviderRouter.js');
            
            // FIXED: Pass cheapPanelProvider to ServiceCatalog for dynamic catalog loading
            this._serviceCatalog = new ServiceCatalog(this._cheapProvider);
            this._tierSelector = new TierOperatorSelector(this._cheapProvider);
            this._countryCatalog = new CountryCatalog(this._cheapProvider, this._tierSelector);

            // FIXED: Initialize ProviderRouter with all cheap providers
            const cheapProviders = [];
            const cheapPanel = this.providerManager?.getProvider('CHEAP_PANEL');
            const onlineSim = this.providerManager?.getProvider('ONLINE_SIM');
            
            if (cheapPanel?.isActive) cheapProviders.push(cheapPanel);
            if (onlineSim?.isActive) cheapProviders.push(onlineSim);
            
            this._providerRouter = new ProviderRouter(cheapProviders);

            logger.info('TierIntegrationService initialized successfully', {
                servicesIndexed: this._serviceCatalog ? 'yes' : 'no',
                countriesIndexed: this._countryCatalog ? 'yes' : 'no',
                tiersConfigured: Object.keys(TIER_CONFIG).length,
                cheapProviders: cheapProviders.map(p => p.providerKey || p.name)
            });

        } catch (error) {
            logger.error('TierIntegrationService initialization failed', { error: error.message });
            this._enabled = false;
            if (!this._legacyFallback) {
                throw error;
            }
        }
    }

    /**
     * Check if tier flow is available and initialized
     */
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

    /**
     * Get popular services for initial display
     * FIXED: Now async due to dynamic catalog loading
     */
    async getPopularServices() {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.getPopularServices();
    }

    /**
     * Search services by query
     * FIXED: Now async due to dynamic catalog loading
     */
    async searchServices(query, limit = 30) {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.searchServices(query, limit);
    }

    /**
     * Get services by category
     * FIXED: Now async due to dynamic catalog loading
     */
    async getServicesByCategory(category) {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.getServicesByCategory(category);
    }

    /**
     * Get all categories with counts
     * FIXED: Now async due to dynamic catalog loading
     */
    async getCategories() {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.getCategories();
    }

    /**
     * Get paginated service list
     * FIXED: Now async due to dynamic catalog loading
     */
    async getServicesPage(page, perPage, filter = null) {
        if (!this.isAvailable()) return null;
        return this._serviceCatalog.getServicesPage(page, perPage, filter);
    }

    /**
     * Validate service exists
     * FIXED: Removed hardcoded SERVICES fallback. Dynamic catalog is the only source of truth.
     */
    async isValidService(serviceName) {
        if (!this.isAvailable()) {
            // No fallback to hardcoded list — dynamic catalog is the only source of truth
            return false;
        }
        return this._serviceCatalog.hasService(serviceName);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TIER SELECTION (Step 2)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get all tier infos for display
     */
    getAllTierInfos() {
        if (!this.isAvailable()) return null;
        return this._tierSelector.getAllTierInfos();
    }

    /**
     * Get tier info by key
     */
    getTierInfo(tierKey) {
        if (!this.isAvailable()) return null;
        return this._tierSelector.getTierInfo(tierKey);
    }

    /**
     * Get tier baseline prices for a service (for UI display)
     * 
     * Pricing Model (FIXED):
     *   - displayCost = raw + $0.10 (from CheapPanelProvider.getDisplayPrice)
     *   - finalPrice = displayCost × tier.priceMultiplier
     *   - Budget: 1.0× = no extra markup
     *   - Standard: 1.15× = +15% extra profit
     *   - Premium: 1.35× = +35% extra profit
     */
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

                // FIXED: displayCost already includes $0.10 profit from provider
                // Just apply tier multiplier
                const displayCost = baseline?.price || 0;
                const finalPrice = Number((displayCost * tier.priceMultiplier).toFixed(2));

                results.push({
                    tierKey: tier.key,
                    label: tier.label,
                    emoji: tier.emoji,
                    description: tier.description,
                    badge: tier.badge,
                    priceMultiplier: tier.priceMultiplier,
                    baselinePrice: finalPrice,        // What user pays
                    displayCost: displayCost,         // Raw + $0.10 (from provider)
                    rawPrice: baseline?.price ? Number((baseline.price - 0.10).toFixed(4)) : 0, // Approximate raw
                    baseProfit: 0.10,                 // Always $0.10
                    extraProfit: Number((finalPrice - displayCost).toFixed(2)), // Tier markup amount
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
                    displayCost: null,
                    rawPrice: null,
                    baseProfit: 0.10,
                    extraProfit: 0,
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

    /**
     * Check if a tier has ANY stock for service/country (lightweight)
     */
    async hasTierStock(tierKey, country, service) {
        if (!this.isAvailable()) return { available: false, reason: 'TIER_SYSTEM_UNAVAILABLE' };
        return this._tierSelector.hasTierStock(tierKey, country, service);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTION (Step 3)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get countries for service with tier-aware pricing
     */
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

    /**
     * Search countries by query
     */
    searchCountries(query) {
        if (!this.isAvailable()) return [];
        return this._countryCatalog.searchCountries(query);
    }

    /**
     * Get top countries with pricing
     */
    async getTopCountries(service, tierKey, limit = 20) {
        if (!this.isAvailable()) return { countries: [], tierInfo: null };
        return this._countryCatalog.getTopCountries(service, tierKey, limit);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PURCHASE ORCHESTRATION (Step 4)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Select best operator and purchase number
     * 
     * Pricing Model (FIXED):
     *   - displayCost = raw + $0.10 (from provider)
     *   - finalPrice = displayCost × tier.priceMultiplier
     * 
     * FIXED: Uses ProviderRouter for multi-provider support
     * FIXED: Validates operator selection before purchase
     * FIXED: Logs operator mismatch
     * FIXED: Ensures exact selected operator is passed to provider
     * FIXED: Excludes failed operator from fallback
     */
    
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
            // Step 1: Select best operator
            const selection = await this._tierSelector.selectOperator(
                tierKey, country, service, { 
                    timeoutMs: options.timeoutMs || 15000,
                    skipCache: options.skipCache || false
                }
            );

            // Validate operator selection
            if (!selection.operator || selection.operator === 'any') {
                logger.warn('Tier selector returned "any" or empty operator', {
                    tier: tierKey, country, service, selection
                });
            }

            // Step 2: Build purchase payload with EXACT selected operator
            const purchasePayload = {
                country, 
                service, 
                operator: selection.operator
            };

            // VALIDATION: Ensure selected operator is used
            if (selection.operator !== purchasePayload.operator) {
                logger.error('OPERATOR MISMATCH DETECTED', {
                    selectedOperator: selection.operator,
                    purchaseOperator: purchasePayload.operator
                });
                throw new Error('OPERATOR_MISMATCH: Selected operator does not match purchase payload');
            }

            logger.info('Purchasing with selected operator', {
                selectedOperator: selection.operator,
                purchaseOperator: purchasePayload.operator,
                tier: tierKey,
                country,
                service,
                expectedPrice: selection.price,
                expectedDisplayPrice: selection.displayPrice
            });

            // FIXED: Use ProviderRouter for multi-provider purchase
            // ProviderRouter selects the cheapest provider with stock
            let purchaseResult;
            let usedProviderKey = 'CHEAP_PANEL';
            
            if (this._providerRouter && this._providerRouter.hasAvailableProvider()) {
                purchaseResult = await this._providerRouter.getNumber(
                    purchasePayload.country, 
                    purchasePayload.service, 
                    purchasePayload.operator
                );
                usedProviderKey = purchaseResult.routedProvider || 'CHEAP_PANEL';
            } else {
                // Fallback to direct CheapPanelProvider
                purchaseResult = await this._cheapProvider.getNumber(
                    purchasePayload.country, 
                    purchasePayload.service, 
                    purchasePayload.operator
                );
            }

            this._metrics.tierPurchases++;

            // VALIDATION: Verify purchased operator matches selected
            if (purchaseResult.operator && purchaseResult.operator !== selection.operator) {
                logger.warn('Provider returned different operator than requested', {
                    requestedOperator: selection.operator,
                    returnedOperator: purchaseResult.operator,
                    providerNumberId: purchaseResult.providerNumberId
                });
            }

            // FIXED: Pricing — displayCost already includes $0.10 from provider
            // Just apply tier multiplier
            const displayCost = purchaseResult.displayCost || selection.price || 0;
            const tier = getTierConfig(tierKey);
            const finalPrice = Number((displayCost * tier.priceMultiplier).toFixed(2));

            logger.info('Tier purchase successful', {
                tier: tierKey,
                country,
                service,
                operator: selection.operator,
                purchasedOperator: purchaseResult.operator || selection.operator,
                provider: usedProviderKey,
                displayCost,
                finalPrice,
                baseProfit: 0.10,
                extraProfit: Number((finalPrice - displayCost).toFixed(2)),
                duration: Date.now() - startTime
            });

            return {
                success: true,
                phoneNumber: purchaseResult.phoneNumber,
                providerNumberId: purchaseResult.providerNumberId,
                operator: selection.operator,
                purchasedOperator: purchaseResult.operator || selection.operator,
                routedProvider: usedProviderKey,
                price: finalPrice,              // User pays this
                displayPrice: finalPrice,       // Same as price
                displayCost: displayCost,       // Raw + $0.10
                rawPrice: purchaseResult.cost || 0, // Provider raw cost
                baseProfit: 0.10,               // Always $0.10
                extraProfit: Number((finalPrice - displayCost).toFixed(2)), // Tier markup
                stock: selection.stock,
                score: selection.score,
                tier: tierKey,
                country,
                service
            };

        } catch (error) {
            this._metrics.errors++;

            const shouldFallback = error.message?.includes('NO_NUMBERS') || 
                 error.message?.includes('NOT_AVAILABLE') ||
                 error.message?.includes('TIMEOUT') ||
                 error.message?.includes('INVALID_RESPONSE') ||
                 error.message?.includes('PROVIDER_ERROR');

            if (options.allowFallback !== false && shouldFallback) {
                logger.warn('Primary operator failed, attempting fallback', {
                    tier: tierKey,
                    country,
                    service,
                    error: error.message,
                    failedOperator: selection?.operator
                });
                // FIXED: Pass failed operator to exclude from fallback
                return this._attemptFallbackPurchase(
                    tierKey, country, service, options, error, selection?.operator
                );
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

    /**
     * Attempt fallback purchase with next-best operator in same tier
     * FIXED: Excludes the failed operator from fallback candidates
     */
    async _attemptFallbackPurchase(tierKey, country, service, options, originalError, failedOperator = null) {
        this._metrics.tierFallbacks++;

        try {
            // FIXED: Pass failedOperator to exclude from fallback candidates
            const fallbackOps = await this._tierSelector.getFallbackOperators(
                tierKey, country, service, failedOperator
            );

            if (!fallbackOps || fallbackOps.length === 0) {
                return {
                    success: false,
                    error: `TIER_NO_STOCK: No operators available in ${tierKey} tier`,
                    recoverable: false,
                    fallbackAttempted: true
                };
            }

            // Try each fallback operator
            for (const fallback of fallbackOps.slice(0, 3)) {
                try {
                    let purchaseResult;
                    let usedProviderKey = 'CHEAP_PANEL';

                    if (this._providerRouter && this._providerRouter.hasAvailableProvider()) {
                        purchaseResult = await this._providerRouter.getNumber(
                            country, service, fallback.operator
                        );
                        usedProviderKey = purchaseResult.routedProvider || 'CHEAP_PANEL';
                    } else {
                        purchaseResult = await this._cheapProvider.getNumber(
                            country, service, fallback.operator
                        );
                    }

                    this._metrics.tierPurchases++;

                    // FIXED: Pricing — same model as main purchase
                    const displayCost = purchaseResult.displayCost || fallback.price || 0;
                    const tier = getTierConfig(tierKey);
                    const finalPrice = Number((displayCost * tier.priceMultiplier).toFixed(2));

                    logger.info('Fallback purchase successful', {
                        tier: tierKey,
                        country,
                        service,
                        failedOperator: failedOperator || 'unknown',
                        fallbackOperator: fallback.operator,
                        provider: usedProviderKey,
                        score: fallback.score,
                        displayCost,
                        finalPrice,
                        baseProfit: 0.10,
                        extraProfit: Number((finalPrice - displayCost).toFixed(2))
                    });

                    return {
                        success: true,
                        phoneNumber: purchaseResult.phoneNumber,
                        providerNumberId: purchaseResult.providerNumberId,
                        operator: fallback.operator,
                        routedProvider: usedProviderKey,
                        price: finalPrice,
                        displayPrice: finalPrice,
                        displayCost: displayCost,
                        rawPrice: purchaseResult.cost || 0,
                        baseProfit: 0.10,
                        extraProfit: Number((finalPrice - displayCost).toFixed(2)),
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

    /**
     * Get fallback operators for display (when primary fails)
     */
    async getFallbackOperators(tierKey, country, service, excludeOperator = null) {
        if (!this.isAvailable()) return [];
        return this._tierSelector.getFallbackOperators(tierKey, country, service, excludeOperator);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  LEGACY COMPATIBILITY
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get legacy CHEAP price (for non-tier fallback)
     */
    async getLegacyCheapPrice(country, service) {
        try {
            return await this.providerManager.getCheapPrice(country, service);
        } catch (error) {
            return null;
        }
    }

    /**
     * Get legacy CHEAP number (for non-tier fallback)
     */
    async getLegacyCheapNumber(country, service) {
        return this.providerManager.getCheapNumber(country, service);
    }

    /**
     * Get legacy CHEAP countries (for non-tier fallback)
     */
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
        if (message.includes('INSUFFICIENT_FUNDS')) return 'NO_BALANCE';
        if (message.includes('NOT_AVAILABLE')) return 'NOT_AVAILABLE';
        if (message.includes('TIMEOUT')) return 'TIMEOUT';
        if (message.includes('INVALID_TIER')) return 'INVALID_TIER';
        if (message.includes('TIER_EMPTY')) return 'TIER_EMPTY';
        if (message.includes('BAD_COUNTRY')) return 'BAD_COUNTRY';
        if (message.includes('BAD_SERVICE')) return 'BAD_SERVICE';
        if (message.includes('NO_NUMBERS')) return 'NO_NUMBERS';
        if (message.includes('INVALID_RESPONSE')) return 'NOT_AVAILABLE';
        if (message.includes('PROVIDER_ERROR')) return 'NOT_AVAILABLE';
        
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
                cheapProvider: this._cheapProvider !== null && this._cheapProvider.isActive,
                providerRouter: this._providerRouter !== null && this._providerRouter.hasAvailableProvider()
            },
            metrics: this._metrics,
            cacheSizes: {
                baselinePrices: this._baselinePriceCache.size
            }
        };
    }

    /**
     * Clear all caches
     */
    clearCaches() {
        this._baselinePriceCache.clear();
        this._countryCatalog?.clearCache();
        this._tierSelector?.clearCaches();
        this._serviceCatalog?.clearCache();
        this._providerRouter?.clearCache();
        logger.info('TierIntegrationService caches cleared');
    }
}

export default TierIntegrationService;
