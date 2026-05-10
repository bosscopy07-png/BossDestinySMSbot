// ═══════════════════════════════════════════════════════════════════════════════
//  config/tierIntegration.js — Integration Configuration for Tier System
//  Maps existing env vars, providers, and constants to tier system
//  ZERO hardcoded business logic — pure configuration
// ═══════════════════════════════════════════════════════════════════════════════

import config from './env.js';

/**
 * Tier Integration Configuration
 * 
 * This file bridges your existing architecture with the new tier system.
 * Modify ONLY this file to adjust tier behavior without touching business logic.
 */

export const TIER_INTEGRATION_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════
    //  FEATURE FLAGS
    // ═══════════════════════════════════════════════════════════════════════
    
    features: {
        // Enable the new 3-tier flow for CHEAP mode
        enableTierFlow: config.features?.enableTierFlow !== false,
        
        // Allow fallback to legacy CHEAP flow if tier system fails
        enableLegacyFallback: config.features?.enableLegacyFallback !== false,
        
        // Show tier baseline prices in selection UI (requires extra API calls)
        showTierPrices: config.features?.showTierPrices !== false,
        
        // Enable fallback operators within same tier on purchase failure
        enableTierFallback: config.features?.enableTierFallback !== false,
        
        // Enable provider health scoring for smart selection
        enableHealthScoring: config.features?.enableHealthScoring !== false,
        
        // Cache tier prices (reduces API calls)
        enablePriceCaching: config.features?.enablePriceCaching !== false
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  PROVIDER MAPPING
    //  Maps your existing CheapPanelProvider (5SIM) to tier system
    // ═══════════════════════════════════════════════════════════════════════
    
    providerMapping: {
        // The provider name in SMSProviderManager
        providerName: 'CHEAP_PANEL',
        
        // The mode this tier system replaces/enhances
        targetMode: 'CHEAP',
        
        // Provider-specific settings
        settings: {
            // Timeout for operator selection API calls
            selectTimeoutMs: 15000,
            
            // Timeout for individual operator price checks
            operatorTimeoutMs: 8000,
            
            // Batch size for parallel operator checks
            operatorBatchSize: 5,
            
            // Delay between batches (ms) to avoid rate limiting
            batchDelayMs: 100,
            
            // Minimum stock to consider operator available
            minStockThreshold: 1,
            
            // Price normalization range (for scoring)
            priceRange: { min: 0.05, max: 2.00 }
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  UI CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════
    
    ui: {
        // Services shown in "Popular" section
        popularServicesCount: 10,
        
        // Countries shown initially (before search/pagination)
        topCountriesCount: 20,
        
        // Services per page in browse view
        servicesPerPage: 15,
        
        // Countries per page in selection view
        countriesPerPage: 10,
        
        // Search results limit
        searchResultsLimit: 30,
        
        // Max fallback operators to show in UI
        maxFallbackDisplay: 3,
        
        // Whether to show stock counts in UI
        showStockCounts: true,
        
        // Whether to show operator names to users (should be FALSE)
        exposeOperators: false
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  CACHE CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════
    
    cache: {
        // Tier price cache TTL (ms)
        tierPricesTtl: 30 * 1000,        // 30 seconds
        
        // Country stock cache TTL
        countryStockTtl: 60 * 1000,      // 1 minute
        
        // Service list cache TTL
        serviceListTtl: 5 * 60 * 1000,   // 5 minutes
        
        // Provider health cache TTL
        providerHealthTtl: 2 * 60 * 1000, // 2 minutes
        
        // Baseline price cache TTL (for tier selection UI)
        baselinePriceTtl: 60 * 1000,      // 1 minute
        
        // Max cache entries before cleanup
        maxCacheEntries: 1000
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  FALLBACK CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════
    
    fallback: {
        // Max fallback attempts within same tier
        maxAttempts: 3,
        
        // Whether to suggest other tiers when current tier has no stock
        suggestOtherTiers: true,
        
        // Whether to suggest other countries when current country has no stock
        suggestOtherCountries: false,
        
        // Message shown when no operators available in tier
        noStockMessage: '⚠️ No {tier} numbers available for {service} in {country}.\n\nTry another tier or country.'
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  ERROR MESSAGES (User-facing)
    // ═══════════════════════════════════════════════════════════════════════
    
    messages: {
        sessionExpired: '❌ Session expired. Please start over with /otp',
        insufficientBalance: '💰 Insufficient balance. Required: {amount}, Available: {balance}',
        noNumbers: '❌ No numbers available. Try another country or tier.',
        providerError: '❌ Provider error. Please try again.',
        timeout: '⏱ Request timed out. Please try again.',
        invalidService: '❌ Invalid service selected.',
        invalidTier: '❌ Invalid tier selected.',
        invalidCountry: '❌ Invalid country selected.'
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  MONITORING & ALERTS
    // ═══════════════════════════════════════════════════════════════════════
    
    monitoring: {
        // Log level for tier operations
        logLevel: 'info',
        
        // Alert when tier success rate drops below threshold
        alertThreshold: 0.5,
        
        // Track operator performance metrics
        trackMetrics: true,
        
        // Report stats interval (ms)
        statsInterval: 60 * 60 * 1000 // 1 hour
    }
};

/**
 * Helper: Get merged config with env overrides
 */
export function getTierIntegrationConfig() {
    return {
        ...TIER_INTEGRATION_CONFIG,
        features: {
            ...TIER_INTEGRATION_CONFIG.features,
            ...(config.tierFeatures || {})
        },
        providerMapping: {
            ...TIER_INTEGRATION_CONFIG.providerMapping,
            ...(config.tierProvider || {})
        }
    };
}

export default TIER_INTEGRATION_CONFIG;
