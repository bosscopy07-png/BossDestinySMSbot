// ═══════════════════════════════════════════════════════════════════════════════
//  services/ServiceCatalog.js — Service Discovery with Dynamic 5SIM Catalog
//  Handles 1100+ services from live API without loading all at once
//  NO hardcoded SERVICES import. All data from CheapPanelProvider.
//  FIXED: Proper cache invalidation, stable indexing, robust error handling
// ═══════════════════════════════════════════════════════════════════════════════

import { POPULAR_SERVICES, SERVICE_CATEGORIES, PAGINATION, CACHE_TTL } from '../config/tierConfig.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reverse service map: 5SIM internal name -> display name
 * Built dynamically from provider's serviceMap
 */
function buildReverseServiceMap(providerServiceMap) {
    const reverse = new Map();
    for (const [display, internal] of Object.entries(providerServiceMap || {})) {
        // Handle duplicates: prefer shorter/cleaner display name
        if (!reverse.has(internal) || display.length < reverse.get(internal).length) {
            reverse.set(internal, display);
        }
    }
    return reverse;
}

/**
 * Clean service display name from 5SIM raw key
 */
function cleanServiceName(rawName) {
    if (!rawName || typeof rawName !== 'string') return 'Unknown';
    return rawName
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class ServiceCatalog {
    constructor(cheapPanelProvider) {
        if (!cheapPanelProvider) {
            throw new Error('ServiceCatalog requires cheapPanelProvider');
        }

        this.provider = cheapPanelProvider;

        // Dynamic indexes — populated from provider API
        this._serviceMap = new Map();        // normalized name -> display name
        this._searchIndex = new Map();       // word -> Set of display names
        this._categoryMap = new Map();       // category -> Set of display names
        this._allServices = new Set();       // All display names

        // Reverse mapping: 5SIM internal -> display
        this._reverseServiceMap = buildReverseServiceMap(cheapPanelProvider.serviceMap);

        // Cache
        this._servicesCache = null;
        this._servicesCacheTime = 0;
        this._cacheTtl = CACHE_TTL.tierPrices || 2 * 60 * 1000; // 2 minutes

        // Build static category mapping (categories are config hints)
        this._buildCategoryIndex();

        logger.info('ServiceCatalog initialized', {
            provider: cheapPanelProvider.name || 'unknown',
            providerActive: cheapPanelProvider.isActive,
            knownMappings: this._reverseServiceMap.size
        });
    }

    _buildCategoryIndex() {
        // SERVICE_CATEGORIES contains display names -> we validate against dynamic catalog later
        for (const [category, services] of Object.entries(SERVICE_CATEGORIES || {})) {
            this._categoryMap.set(category, new Set(services || []));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  DYNAMIC CATALOG LOADING
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Load all services from 5SIM product catalog
     * This is the SINGLE SOURCE OF TRUTH for service availability
     */
    async _loadServices() {
        const now = Date.now();

        // Return cached if fresh
        if (this._servicesCache && (now - this._servicesCacheTime) < this._cacheTtl) {
            logger.debug('Using cached service catalog', { count: this._allServices.size });
            return;
        }

        try {
            const products = await this.provider.getProducts();

            if (!products || typeof products !== 'object') {
                logger.error('Failed to load services: invalid products data', { 
                    type: typeof products,
                    isNull: products === null
                });
                return;
            }

            // Extract all unique services across all countries
            const serviceSet = new Set();

            for (const [countryCode, services] of Object.entries(products)) {
                if (!services || typeof services !== 'object') continue;

                for (const serviceKey of Object.keys(services)) {
                    serviceSet.add(serviceKey);
                }
            }

            // Build display names and indexes
            this._serviceMap.clear();
            this._searchIndex.clear();
            this._allServices.clear();

            for (const serviceKey of serviceSet) {
                // Map to display name
                const displayName = this._reverseServiceMap.get(serviceKey) || cleanServiceName(serviceKey);
                const normalized = displayName.toLowerCase().trim();

                this._serviceMap.set(normalized, displayName);
                this._allServices.add(displayName);

                // Index by words
                const words = normalized.split(/\s+/).filter(w => w.length >= 2);
                for (const word of words) {
                    if (!this._searchIndex.has(word)) {
                        this._searchIndex.set(word, new Set());
                    }
                    this._searchIndex.get(word).add(displayName);
                }

                // Index full name
                if (!this._searchIndex.has(normalized)) {
                    this._searchIndex.set(normalized, new Set());
                }
                this._searchIndex.get(normalized).add(displayName);
            }

            // Update category mappings with validated services
            for (const [category, services] of this._categoryMap) {
                const valid = new Set();
                for (const s of services) {
                    const normalized = s.toLowerCase().trim();
                    if (this._serviceMap.has(normalized)) {
                        valid.add(this._serviceMap.get(normalized));
                    }
                }
                this._categoryMap.set(category, valid);
            }

            this._servicesCache = true;
            this._servicesCacheTime = now;

            logger.info('Service catalog loaded from provider', {
                totalServices: this._allServices.size,
                indexEntries: this._searchIndex.size,
                categories: this._categoryMap.size
            });

        } catch (error) {
            logger.error('Failed to load services from provider', { error: error.message });
            // If we have cached data, keep using it even if stale
            if (!this._servicesCache) {
                logger.warn('No cached services available, catalog is empty');
            }
        }
    }

    /**
     * Ensure catalog is loaded before operations
     */
    async _ensureLoaded() {
        if (!this._servicesCache) {
            await this._loadServices();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Popular Services with Backfill
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get popular services, backfilled to minCount (default 25) from dynamic catalog
     */
    async getPopularServices(minCount = 25) {
        await this._ensureLoaded();

        if (this._allServices.size === 0) {
            return [];
        }

        // Start with configured popular services that exist in dynamic catalog
        const result = [];
        const added = new Set();

        for (const name of POPULAR_SERVICES || []) {
            const normalized = name.toLowerCase().trim();
            if (this._serviceMap.has(normalized)) {
                const displayName = this._serviceMap.get(normalized);
                if (!added.has(displayName)) {
                    result.push({
                        name: displayName,
                        category: this._getServiceCategory(displayName),
                        isPopular: true
                    });
                    added.add(displayName);
                }
            }
        }

        // Backfill: add more services from catalog until minCount reached
        const needed = minCount - result.length;
        if (needed > 0) {
            // Get services not already added, sorted alphabetically for stability
            const remaining = Array.from(this._allServices)
                .filter(s => !added.has(s))
                .sort((a, b) => a.localeCompare(b));

            for (const name of remaining.slice(0, needed)) {
                result.push({
                    name,
                    category: this._getServiceCategory(name),
                    isPopular: false
                });
                added.add(name);
            }
        }

        logger.debug('Popular services with backfill', {
            popularCount: result.filter(s => s.isPopular).length,
            backfillCount: result.filter(s => !s.isPopular).length,
            total: result.length
        });

        return result;
    }

    /**
     * Get services by category
     */
    async getServicesByCategory(categoryName) {
        await this._ensureLoaded();

        const services = this._categoryMap.get(categoryName) || new Set();
        return Array.from(services)
            .filter(name => this._allServices.has(name))
            .map(name => ({
                name,
                category: categoryName,
                isPopular: (POPULAR_SERVICES || []).map(s => s.toLowerCase().trim()).includes(name.toLowerCase())
            }));
    }

    /**
     * Get all categories with service counts
     */
    async getCategories() {
        await this._ensureLoaded();

        return Array.from(this._categoryMap.entries())
            .map(([name, services]) => ({
                name,
                count: services.size,
                services: Array.from(services).slice(0, 5)
            }))
            .filter(c => c.count > 0)
            .sort((a, b) => b.count - a.count);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Search
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Search services by query string against FULL dynamic catalog
     */
    async searchServices(query, limit = PAGINATION?.searchResultsLimit || 30) {
        await this._ensureLoaded();

        if (!query || query.trim().length < 1) {
            return [];
        }

        if (this._allServices.size === 0) {
            return [];
        }

        const normalizedQuery = query.toLowerCase().trim();
        const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length >= 2);

        const scores = new Map(); // displayName -> score

        // Exact match = highest score
        if (this._serviceMap.has(normalizedQuery)) {
            scores.set(this._serviceMap.get(normalizedQuery), 100);
        }

        // Prefix match
        for (const [key, displayName] of this._serviceMap) {
            if (key.startsWith(normalizedQuery)) {
                scores.set(displayName, (scores.get(displayName) || 0) + 50);
            }
        }

        // Word matches
        for (const word of queryWords) {
            for (const [indexWord, services] of this._searchIndex) {
                if (indexWord.includes(word) || word.includes(indexWord)) {
                    const matchScore = indexWord === word ? 30 : 15;
                    for (const service of services) {
                        scores.set(service, (scores.get(service) || 0) + matchScore);
                    }
                }
            }
        }

        // Sort by score and return top results
        return Array.from(scores.entries())
            .map(([name, score]) => ({
                name,
                category: this._getServiceCategory(name),
                matchScore: score,
                isPopular: (POPULAR_SERVICES || []).map(s => s.toLowerCase().trim()).includes(name.toLowerCase())
            }))
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, limit);
    }

    /**
     * Get paginated service list from FULL dynamic catalog
     */
    async getServicesPage(page = 1, perPage = PAGINATION?.servicesPerPage || 20, filter = null) {
        await this._ensureLoaded();

        let services = Array.from(this._allServices).sort((a, b) => a.localeCompare(b));

        if (filter) {
            const normalized = filter.toLowerCase().trim();
            services = services.filter(s => s.toLowerCase().includes(normalized));
        }

        const total = services.length;
        const start = (page - 1) * perPage;
        const end = Math.min(start + perPage, total);
        const pageServices = services.slice(start, end);

        return {
            services: pageServices.map(name => ({
                name,
                category: this._getServiceCategory(name),
                isPopular: (POPULAR_SERVICES || []).map(s => s.toLowerCase().trim()).includes(name.toLowerCase())
            })),
            pagination: {
                page,
                perPage,
                total,
                totalPages: Math.ceil(total / perPage),
                hasNext: end < total,
                hasPrev: page > 1
            }
        };
    }

    /**
     * Get services starting from a specific letter
     */
    async getServicesByLetter(letter, page = 1, perPage = PAGINATION?.servicesPerPage || 20) {
        await this._ensureLoaded();

        const normalizedLetter = letter.toUpperCase();
        const services = Array.from(this._allServices)
            .filter(s => s.toUpperCase().startsWith(normalizedLetter))
            .sort((a, b) => a.localeCompare(b));

        const total = services.length;
        const start = (page - 1) * perPage;
        const end = Math.min(start + perPage, total);
        const pageServices = services.slice(start, end);

        return {
            services: pageServices.map(name => ({
                name,
                category: this._getServiceCategory(name),
                isPopular: (POPULAR_SERVICES || []).map(s => s.toLowerCase().trim()).includes(name.toLowerCase())
            })),
            pagination: {
                page,
                perPage,
                total,
                totalPages: Math.ceil(total / perPage),
                hasNext: end < total,
                hasPrev: page > 1
            }
        };
    }

    /**
     * Check if a service exists in dynamic catalog
     */
    async hasService(serviceName) {
        await this._ensureLoaded();
        if (!serviceName || typeof serviceName !== 'string') return false;
        return this._serviceMap.has(serviceName.toLowerCase().trim());
    }

    /**
     * Get service display name (preserves original casing)
     */
    async getServiceName(serviceName) {
        await this._ensureLoaded();
        if (!serviceName || typeof serviceName !== 'string') return serviceName;
        return this._serviceMap.get(serviceName.toLowerCase().trim()) || serviceName;
    }

    /**
     * Get service category
     */
    async getServiceCategory(serviceName) {
        await this._ensureLoaded();
        return this._getServiceCategory(serviceName);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Helpers
    // ═══════════════════════════════════════════════════════════════════════

    _getServiceCategory(serviceName) {
        if (!serviceName || typeof serviceName !== 'string') return 'Other';
        const lower = serviceName.toLowerCase().trim();
        for (const [category, services] of this._categoryMap) {
            for (const s of services) {
                if (s.toLowerCase().trim() === lower) return category;
            }
        }
        return 'Other';
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CACHE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    clearCache() {
        this._servicesCache = null;
        this._servicesCacheTime = 0;
        this._serviceMap.clear();
        this._searchIndex.clear();
        this._allServices.clear();
        logger.info('ServiceCatalog cache cleared');
    }

    getCacheStats() {
        return {
            cached: !!this._servicesCache,
            cacheAge: this._servicesCache ? Date.now() - this._servicesCacheTime : null,
            totalServices: this._allServices.size,
            indexEntries: this._searchIndex.size
        };
    }
}

export default ServiceCatalog;
    
