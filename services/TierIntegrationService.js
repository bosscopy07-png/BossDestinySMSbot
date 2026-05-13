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

            // FIXED: Pass cheapPanelProvider to ServiceCatalog for dynamic catalog loading
            this._serviceCatalog = new ServiceCatalog(this._cheapProvider);
            this._tierSelector = new TierOperatorSelector(this._cheapProvider);
            this._countryCatalog = new CountryCatalog(this._cheapProvider, this._tierSelector);

            logger.info('TierIntegrationService initialized successfully', {
                servicesIndexed: this._serviceCatalog ? 'yes' : 'no',
                countriesIndexed: this._countryCatalog ? 'yes' : 'no',
                tiersConfigured: Object.keys(TIER_CONFIG).length
            });

        } catch (error) {
            logger {
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
     * Caches results to avoid hammering the API
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

                // FIXED: Apply profit margin to display price
                const rawPrice = baseline?.displayPrice || baseline?.price || null;
                const markedUpPrice = applyProfitMargin(rawPrice);

                results.push({
                    tierKey: tier.key,
                    label: tier.label,
                    emoji: tier.emoji,
                    description: tier.description,
                    badge: tier.badge,
                    priceMultiplier: tier.priceMultiplier,
                    baselinePrice: markedUpPrice,  // FIXED: was raw price
                    rawPrice: rawPrice,            // Keep raw for reference
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
     * This is the MAIN entry point for automatic provider selection + purchase
     * 
     * FIXED: Validates operator selection before purchase, logs operator mismatch,
     * ensures exact selected operator is passed to provider.
     * 
     * @returns {Promise<{
     *   success: boolean,
     *   phoneNumber: string,
     *   providerNumberId: string,
     *   operator: string,
     *   price: number,
     *   displayPrice: number,
     *   stock: number,
     *   score: number,
     *   tier: string,
     *   country: string,
     *   service: string,
     *   error: string
     * }>}
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

            // CRITICAL FIX: Validate operator selection
            if (!selection.operator || selection.operator === 'any') {
                logger.warn('Tier selector returned "any" or empty operator', {
                    tier: tierKey, country, service, selection
                });
            }

            // Step 2: Build purchase payload with EXACT selected operator
            const purchasePayload = {
                country, 
                service, 
                operator: selection.operator  // EXACT operator from selector
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

            // Step 3: Purchase via CheapPanelProvider with selected operator
            const purchaseResult = await this._cheapProvider.getNumber(
                purchasePayload.country, 
                purchasePayload.service, 
                purchasePayload.operator  // EXACT operator passed
            );

            this._metrics.tierPurchases++;

            // VALIDATION: Verify purchased operator matches selected
            if (purchaseResult.operator && purchaseResult.operator !== selection.operator) {
                logger.warn('Provider returned different operator than requested', {
                    requestedOperator: selection.operator,
                    returnedOperator: purchaseResult.operator,
                    providerNumberId: purchaseResult.providerNumberId
                });
            }

            // FIXED: Apply profit margin to prices
            const finalPrice = applyProfitMargin(selection.price);
            const finalDisplayPrice = applyProfitMargin(selection.displayPrice);

            logger.info('Tier purchase successful', {
                tier: tierKey,
                country,
                service,
                operator: selection.operator,           // What we selected
                purchasedOperator: purchaseResult.operator || selection.operator,  // What provider used
                price: finalPrice,
                displayPrice: finalDisplayPrice,
                rawPrice: selection.price,
                duration: Date.now() - startTime
            });

            return {
                success: true,
                phoneNumber: purchaseResult.phoneNumber,
                providerNumberId: purchaseResult.providerNumberId,
                operator: selection.operator,           // EXACT selected operator
                purchasedOperator: purchaseResult.operator || selection.operator,  // Actual provider operator
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

            // CRITICAL FIX: Add INVALID_RESPONSE and PROVIDER_ERROR to fallback triggers
            // Empty response from 5SIM usually means operator/country combo doesn't work
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
                    error: error.message
                });
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

    /**
     * Attempt fallback purchase with next-best operator in same tier
     */
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

            // Try each fallback operator
            for (const fallback of fallbackOps.slice(0, 3)) {
                try {
                    const purchaseResult = await this._cheapProvider.getNumber(
                        country, service, fallback.operator
                    );

                    this._metrics.tierPurchases++;

                    // FIXED: Apply profit margin
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

    /**
     * Get fallback operators for display (when primary fails)
     */
    async getFallbackOperators(tierKey, country, service, excludeOperator = null) {
        if (!this.isAvailable()) return [];
        return this._tierSelector.getFallbackOperators(tierKey, country, service, excludeOperator);
                        }

    // ═══════════════════════════════════════════════════════════════════════════════
//  TierIntegrationService.js — Part 2/2
//  Legacy Compatibility, Error Handling, Metrics & Health
// ═══════════════════════════════════════════════════════════════════════════════

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
                cheapProvider: this._cheapProvider !== null && this._cheapProvider.isActive
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
        logger.info('TierIntegrationService caches cleared');
    }
}

export default TierIntegrationService;
