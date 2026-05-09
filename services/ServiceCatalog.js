// ═══════════════════════════════════════════════════════════════════════════════
//  services/ServiceCatalog.js — Service Discovery, Search & Categorization
//  Handles 1100+ services without loading all at once
// ═══════════════════════════════════════════════════════════════════════════════

import { POPULAR_SERVICES, SERVICE_CATEGORIES, PAGINATION } from '../config/tierConfig.js';
import { SERVICES } from '../utils/constants.js';
import logger from '../utils/logger.js';

/**
 * ServiceCatalog — Manages service listing with search, categories, and pagination
 * 
 * Performance:
 *   - O(1) popular service lookup
 *   - O(n) search with early termination
 *   - Lazy loading via pagination
 *   - No full array loading into UI
 */
class ServiceCatalog {
    constructor() {
        // Build search index
        this._searchIndex = new Map();
        this._serviceMap = new Map();
        this._categoryMap = new Map(); // category -> Set of services
        this._buildIndex();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INDEX BUILDING
    // ═══════════════════════════════════════════════════════════════════════

    _buildIndex() {
        for (const service of SERVICES) {
            const lowerName = service.toLowerCase();
            this._serviceMap.set(lowerName, service);
            
            // Index by name parts
            const words = lowerName.split(/[\s\-_]+/);
            for (const word of words) {
                if (word.length < 2) continue;
                if (!this._searchIndex.has(word)) {
                    this._searchIndex.set(word, new Set());
                }
                this._searchIndex.get(word).add(service);
            }

            // Index by full name
            if (!this._searchIndex.has(lowerName)) {
                this._searchIndex.set(lowerName, new Set());
            }
            this._searchIndex.get(lowerName).add(service);
        }

        // Build category reverse index
        for (const [category, services] of Object.entries(SERVICE_CATEGORIES)) {
            const validServices = services.filter(s => this._serviceMap.has(s.toLowerCase()));
            this._categoryMap.set(category, new Set(validServices));
        }

        logger.info('Service catalog indexed', { 
            totalServices: SERVICES.length,
            indexEntries: this._searchIndex.size,
            categories: this._categoryMap.size
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Popular Services
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get popular services with their category info
     */
    getPopularServices() {
        return POPULAR_SERVICES
            .filter(name => this._serviceMap.has(name.toLowerCase()))
            .map(name => ({
                name,
                category: this._getServiceCategory(name),
                isPopular: true
            }));
    }

    /**
     * Get services by category
     */
    getServicesByCategory(categoryName) {
        const services = this._categoryMap.get(categoryName) || new Set();
        return Array.from(services)
            .filter(name => this._serviceMap.has(name.toLowerCase()))
            .map(name => ({
                name,
                category: categoryName,
                isPopular: POPULAR_SERVICES.includes(name)
            }));
    }

    /**
     * Get all categories with service counts
     */
    getCategories() {
        return Array.from(this._categoryMap.entries())
            .map(([name, services]) => ({
                name,
                count: services.size,
                services: Array.from(services).slice(0, 5) // Preview
            }))
            .filter(c => c.count > 0)
            .sort((a, b) => b.count - a.count); // Most services first
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Search
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Search services by query string
     * @param {string} query - Search term
     * @param {number} limit - Max results (default: 30)
     * @returns {Array<{name: string, category: string, matchScore: number}>}
     */
    searchServices(query, limit = PAGINATION.searchResultsLimit) {
        if (!query || query.trim().length < 1) {
            return [];
        }

        const normalizedQuery = query.toLowerCase().trim();
        const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length >= 2);
        
        const scores = new Map(); // service -> score

        // Exact match gets highest score
        if (this._serviceMap.has(normalizedQuery)) {
            scores.set(this._serviceMap.get(normalizedQuery), 100);
        }

        // Prefix match (e.g., "whats" matches "WhatsApp")
        for (const [key, service] of this._serviceMap) {
            if (key.startsWith(normalizedQuery)) {
                scores.set(service, (scores.get(service) || 0) + 50);
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
        const results = Array.from(scores.entries())
            .map(([name, score]) => ({
                name,
                category: this._getServiceCategory(name),
                matchScore: score,
                isPopular: POPULAR_SERVICES.includes(name)
            }))
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, limit);

        return results;
    }

    /**
     * Get paginated service list
     */
    getServicesPage(page = 1, perPage = PAGINATION.servicesPerPage, filter = null) {
        let services = Array.from(this._serviceMap.values());
        
        if (filter) {
            const normalized = filter.toLowerCase();
            services = services.filter(s => s.toLowerCase().includes(normalized));
        }

        const total = services.length;
        const start = (page - 1) * perPage;
        const end = start + perPage;
        const pageServices = services.slice(start, end);

        return {
            services: pageServices.map(name => ({
                name,
                category: this._getServiceCategory(name),
                isPopular: POPULAR_SERVICES.includes(name)
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
     * Get services starting from a specific letter (A-Z browsing)
     */
    getServicesByLetter(letter, page = 1, perPage = PAGINATION.servicesPerPage) {
        const normalizedLetter = letter.toUpperCase();
        const services = Array.from(this._serviceMap.values())
            .filter(s => s.toUpperCase().startsWith(normalizedLetter))
            .sort();

        const total = services.length;
        const start = (page - 1) * perPage;
        const end = start + perPage;
        const pageServices = services.slice(start, end);

        return {
            services: pageServices.map(name => ({
                name,
                category: this._getServiceCategory(name),
                isPopular: POPULAR_SERVICES.includes(name)
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
     * Check if a service exists
     */
    hasService(serviceName) {
        return this._serviceMap.has(serviceName.toLowerCase());
    }

    /**
     * Get service display name (preserves original casing)
     */
    getServiceName(serviceName) {
        return this._serviceMap.get(serviceName.toLowerCase()) || serviceName;
    }

    /**
     * Get service category
     */
    getServiceCategory(serviceName) {
        return this._getServiceCategory(serviceName);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Helpers
    // ═══════════════════════════════════════════════════════════════════════

    _getServiceCategory(serviceName) {
        const lower = serviceName.toLowerCase();
        for (const [category, services] of this._categoryMap) {
            if (services.has(serviceName)) {
                return category;
            }
        }
        return 'Other';
    }
}

export default ServiceCatalog;
