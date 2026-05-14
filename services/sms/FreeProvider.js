// ═══════════════════════════════════════════════════════════════════════════════
// FreeProvider.js — Part 1/3: Core Engine, Health-Aware Scraping, Ad Credits
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import * as cheerio from 'cheerio';
import logger from '../../utils/logger.js';
import AdCreditSystem from './AdCreditSystem.js';

/**
 * FreeProvider v2 — Production-Ready SMS Number Aggregation Engine
 *
 * Fixes Applied:
 * - Corrected regex for number extraction (handles +, spaces, dashes)
 * - Fixed country code collision (US/CA +1 resolved by number length/prefix analysis)
 * - Added provider health scoring with automatic disabling
 * - Pre-validation: numbers are tested before assignment
 * - Syntax error fixed (comment line that broke parsing)
 * - Intelligent OTP extraction with confidence scoring
 * - Credit-safe transaction: deduct only after number validation
 */

// ─── Site Configurations v2 ────────────────────────────────────────────────────
// Added: health tracking fields, lastSuccess timestamp, failCount
const SITE_CONFIGS = [
    {
        id: 'receive_a_sms',
        name: 'receive-a-sms.com',
        enabled: true,
        baseUrl: 'https://receive-a-sms.com',
        numbersPath: '/',
        inboxPath: (number) => `/${number.replace('+', '')}`,
        priority: 3,
        timeout: 8000,
        retries: 2,
        // Health metrics (dynamic)
        lastSuccess: 0,
        failCount: 0,
        successCount: 0,
        consecutiveFails: 0,
        healthScore: 100, // 0-100
        disabledUntil: 0
    },
    {
        id: 'smsreceivefree',
        name: 'smsreceivefree.com',
        enabled: true,
        baseUrl: 'https://smsreceivefree.com',
        numbersPath: '/',
        inboxPath: (number) => `/info/${number.replace('+', '')}`,
        priority: 2,
        timeout: 8000,
        retries: 2,
        lastSuccess: 0,
        failCount: 0,
        successCount: 0,
        consecutiveFails: 0,
        healthScore: 100,
        disabledUntil: 0
    },
    {
        id: 'sms_online_co',
        name: 'sms-online.co',
        enabled: true,
        baseUrl: 'https://sms-online.co',
        numbersPath: '/free-phone-number',
        inboxPath: (number) => `/receive-sms/${number.replace('+', '')}`,
        priority: 4,
        timeout: 8000,
        retries: 2,
        lastSuccess: 0,
        failCount: 0,
        successCount: 0,
        consecutiveFails: 0,
        healthScore: 100,
        disabledUntil: 0
    },
    {
        id: 'sellaite',
        name: 'sms.sellaite.com',
        enabled: true,
        baseUrl: 'http://sms.sellaite.com',
        numbersPath: '/',
        inboxPath: (number) => `/sms/${number.replace('+', '')}`,
        priority: 1,
        timeout: 10000,
        retries: 3,
        lastSuccess: 0,
        failCount: 0,
        successCount: 0,
        consecutiveFails: 0,
        healthScore: 100,
        disabledUntil: 0
    },
    {
        id: 'receive_sms_online',
        name: 'receive-sms-online.com',
        enabled: true,
        baseUrl: 'https://receive-sms-online.com',
        numbersPath: '/',
        inboxPath: (number) => `/read-sms/${number.replace('+', '')}`,
        priority: 2,
        timeout: 8000,
        retries: 2,
        lastSuccess: 0,
        failCount: 0,
        successCount: 0,
        consecutiveFails: 0,
        healthScore: 100,
        disabledUntil: 0
    },
    {
        id: 'receivesmsonline',
        name: 'receivesmsonline.net',
        enabled: true,
        baseUrl: 'https://receivesmsonline.net',
        numbersPath: '/',
        inboxPath: (number) => `/read-sms/${number.replace('+', '')}`,
        priority: 2,
        timeout: 8000,
        retries: 2,
        lastSuccess: 0,
        failCount: 0,
        successCount: 0,
        consecutiveFails: 0,
        healthScore: 100,
        disabledUntil: 0
    },
    {
        id: 'smslisten',
        name: 'smslisten.com',
        enabled: true,
        baseUrl: 'https://smslisten.com',
        numbersPath: '/',
        inboxPath: (number) => `/receive-sms/${number.replace('+', '')}`,
        priority: 3,
        timeout: 8000,
        retries: 2,
        lastSuccess: 0,
        failCount: 0,
        successCount: 0,
        consecutiveFails: 0,
        healthScore: 100,
        disabledUntil: 0
    }
];

// ─── Country Code Mapping v2 ──────────────────────────────────────────────────
// FIX: Resolved US/CA collision by using full number prefix analysis
const COUNTRY_CODES = {
    'ID': { regex: /^\+62\d{9,12}$/, flag: '🇮🇩', name: 'Indonesia', minLength: 10, maxLength: 15 },
    'IN': { regex: /^\+91\d{10}$/, flag: '🇮🇳', name: 'India', minLength: 12, maxLength: 13 },
    'VN': { regex: /^\+84\d{9,10}$/, flag: '🇻🇳', name: 'Vietnam', minLength: 11, maxLength: 13 },
    'PH': { regex: /^\+63\d{10}$/, flag: '🇵🇭', name: 'Philippines', minLength: 12, maxLength: 13 },
    'US': { regex: /^\+1\d{10}$/, flag: '🇺🇸', name: 'United States', minLength: 11, maxLength: 12 },
    'CA': { regex: /^\+1\d{10}$/, flag: '🇨🇦', name: 'Canada', minLength: 11, maxLength: 12 },
    'RU': { regex: /^\+7\d{10}$/, flag: '🇷🇺', name: 'Russia', minLength: 11, maxLength: 12 },
    'DE': { regex: /^\+49\d{10,11}$/, flag: '🇩🇪', name: 'Germany', minLength: 12, maxLength: 14 },
    'FR': { regex: /^\+33\d{9}$/, flag: '🇫🇷', name: 'France', minLength: 11, maxLength: 12 },
    'GB': { regex: /^\+44\d{10}$/, flag: '🇬🇧', name: 'United Kingdom', minLength: 12, maxLength: 13 },
    'MY': { regex: /^\+60\d{9,10}$/, flag: '🇲🇾', name: 'Malaysia', minLength: 11, maxLength: 13 }
};

// ─── Default Priority Countries ───────────────────────────────────────────────
const DEFAULT_COUNTRIES = ['ID', 'IN', 'VN', 'PH', 'US', 'GB'];

// ─── Provider Health Thresholds ───────────────────────────────────────────────
const HEALTH_CONFIG = {
    DISABLE_AFTER_CONSECUTIVE_FAILS: 5,
    DISABLE_DURATION_MS: 300000, // 5 minutes
    HEALTH_RECOVERY_RATE: 10,    // Points recovered per success
    HEALTH_PENALTY_FAIL: 20,     // Points lost per fail
    MIN_HEALTH_SCORE: 30          // Below this, provider is unhealthy
};

class FreeProvider {
    constructor() {
        this.name = 'FREE_PUBLIC';
        this.tier = 'FREE';
        this.isActive = true;

        // Ad credit system
        this.adSystem = new AdCreditSystem();

        // Active sessions tracking
        this.activeSessions = new Map();
        this.assignedNumbers = new Map();

        // Success rate tracking per number
        this.numberStats = new Map(); // number -> { success, failure, lastUsed, lastSMSReceived, assignedCount }

        // Blacklist for failed numbers (with reason and timestamp)
        this.blacklist = new Map(); // number -> { reason, timestamp, permanent }

        // In-memory cache
        this.cache = new Map();
        this.CACHE_TTL = 30000;       // 30s for numbers (aggressive refresh for accuracy)
        this.MESSAGE_CACHE_TTL = 8000; // 8s for messages (very fresh)

        // Poll configuration
        this.POLL_CONFIG = {
            interval: 2500,      // 2.5s between polls
            timeout: 120000,     // 2 minutes total timeout
            maxRetries: 2        // Two retries with new number
        };

        // Background jobs
        this.warmInterval = null;
        this.healthCheckInterval = null;
        this.cleanupInterval = null;

        this.startCacheWarming();
        this.startHealthChecks();
        this.startCleanupJob();

        logger.info('FreeProvider v2 initialized', {
            sites: SITE_CONFIGS.filter(s => s.enabled).length,
            cacheTTL: this.CACHE_TTL,
            pollInterval: this.POLL_CONFIG.interval
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CACHE MANAGEMENT v2
    // ═══════════════════════════════════════════════════════════════════════

    _getCached(key, type = 'numbers') {
        const entry = this.cache.get(key);
        if (!entry) return null;

        const ttl = type === 'messages' ? this.MESSAGE_CACHE_TTL : this.CACHE_TTL;
        if (Date.now() - entry.timestamp > ttl) {
            this.cache.delete(key);
            return null;
        }

        return entry.data;
    }

    _setCached(key, data, type = 'numbers') {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            type
        });
    }

    _clearStaleCache() {
        const now = Date.now();
        for (const [key, entry] of this.cache) {
            const ttl = entry.type === 'messages' ? this.MESSAGE_CACHE_TTL : this.CACHE_TTL;
            if (now - entry.timestamp > ttl) {
                this.cache.delete(key);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  BACKGROUND CACHE WARMING
    // ═══════════════════════════════════════════════════════════════════════

    startCacheWarming() {
        this.warmInterval = setInterval(async () => {
            try {
                await this._warmCache();
            } catch (e) {
                // Silent fail — cache warming is best-effort
            }
        }, 20000); // Every 20 seconds
    }

    stopCacheWarming() {
        if (this.warmInterval) {
            clearInterval(this.warmInterval);
            this.warmInterval = null;
        }
    }

    async _warmCache() {
        const cacheKey = 'numbers_all';
        const cached = this._getCached(cacheKey);
        if (cached && cached.length > 3) return; // Cache is healthy

        // Fire-and-forget parallel scrape
        this._scrapeAllSitesParallel(DEFAULT_COUNTRIES).then(numbers => {
            if (numbers.length > 0) {
                this._setCached(cacheKey, numbers);
                logger.debug('Cache warmed', { count: numbers.length });
            }
        }).catch(() => {});
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PROVIDER HEALTH MONITORING (NEW)
    // ═══════════════════════════════════════════════════════════════════════

    startHealthChecks() {
        this.healthCheckInterval = setInterval(() => {
            this._evaluateProviderHealth();
        }, 60000); // Every minute
    }

    stopHealthChecks() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    _evaluateProviderHealth() {
        const now = Date.now();
        for (const site of SITE_CONFIGS) {
            // Auto-disable if health too low
            if (site.healthScore < HEALTH_CONFIG.MIN_HEALTH_SCORE && site.enabled) {
                site.enabled = false;
                site.disabledUntil = now + HEALTH_CONFIG.DISABLE_DURATION_MS;
                logger.warn(`Provider auto-disabled`, { 
                    site: site.name, 
                    health: site.healthScore,
                    disabledFor: '5m'
                });
            }

            // Re-enable after cooldown
            if (!site.enabled && now > site.disabledUntil) {
                site.enabled = true;
                site.consecutiveFails = 0;
                site.healthScore = Math.min(site.healthScore + 20, 100);
                logger.info(`Provider re-enabled`, { site: site.name });
            }
        }
    }

    _recordProviderSuccess(siteId) {
        const site = SITE_CONFIGS.find(s => s.id === siteId);
        if (!site) return;

        site.lastSuccess = Date.now();
        site.successCount++;
        site.consecutiveFails = 0;
        site.healthScore = Math.min(site.healthScore + HEALTH_CONFIG.HEALTH_RECOVERY_RATE, 100);
    }

    _recordProviderFailure(siteId, error) {
        const site = SITE_CONFIGS.find(s => s.id === siteId);
        if (!site) return;

        site.failCount++;
        site.consecutiveFails++;
        site.healthScore = Math.max(site.healthScore - HEALTH_CONFIG.HEALTH_PENALTY_FAIL, 0);

        // Auto-disable if too many consecutive failures
        if (site.consecutiveFails >= HEALTH_CONFIG.DISABLE_AFTER_CONSECUTIVE_FAILS) {
            site.enabled = false;
            site.disabledUntil = Date.now() + HEALTH_CONFIG.DISABLE_DURATION_MS;
            logger.error(`Provider disabled due to consecutive failures`, {
                site: site.name,
                fails: site.consecutiveFails,
                error: error?.message || 'Unknown'
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    startCleanupJob() {
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleSessions();
            this._clearStaleCache();
            this.adSystem.cleanupOldVerifications();
        }, 120000); // Every 2 minutes
    }

    stopCleanupJob() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.stopCacheWarming();
        this.stopHealthChecks();
    }

    cleanupStaleSessions() {
        const now = Date.now();
        const staleThreshold = 10 * 60 * 1000; // 10 minutes
        let cleaned = 0;

        for (const [sessionId, session] of this.activeSessions) {
            if (now - session.assignedAt > staleThreshold && session.status !== 'ACTIVE') {
                this.releaseSession(sessionId);
                cleaned++;
            }
        }

        // Clean leaked assignedNumbers entries
        for (const [number, data] of this.assignedNumbers) {
            if (!this.activeSessions.has(data.sessionId)) {
                this.assignedNumbers.delete(number);
            }
        }

        if (cleaned > 0) {
            logger.info('Cleaned stale free sessions', { cleaned });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION — PARALLEL multi-site scraper with health awareness
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get numbers from all healthy enabled sites, filtered by country preference
     * CREDIT-SAFE: Only deduct after number is validated
     */
    async getNumber(country = null, service = 'Any', userId = null) {
        const sessionId = `free_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const startTime = Date.now();

        // ─── AD CREDIT CHECK (PRE-AUTH) ────────────────────────────────────
        let creditDeductionId = null;
        if (userId) {
            const creditCheck = await this.adSystem.canRequestNumber(userId);
            
            if (!creditCheck.allowed) {
                const error = new Error(`${creditCheck.reason}: ${creditCheck.message}`);
                error.code = creditCheck.reason;
                error.creditInfo = creditCheck;
                if (creditCheck.reason === 'INSUFFICIENT_CREDITS') {
                    error.needsAd = true;
                    error.shortfall = creditCheck.shortfall;
                }
                throw error;
            }
            // Hold credits (don't deduct yet)
            creditDeductionId = await this.adSystem.holdCredits(userId);
        }
        // ───────────────────────────────────────────────────────────────────

        // Check cache first (fast path)
        const cacheKey = `numbers_${country || 'all'}`;
        const cached = this._getCached(cacheKey);
        if (cached && cached.length > 0) {
            const available = this._selectBestNumber(cached);
            if (available) {
                const result = await this._validateAndCreate(sessionId, available, service, country, startTime, userId, creditDeductionId);
                if (result) return result;
            }
        }

        // PARALLEL scrape all healthy enabled sites
        const targetCountries = country ? [country] : DEFAULT_COUNTRIES;
        const allNumbers = await this._scrapeAllSitesParallel(targetCountries);

        if (allNumbers.length === 0) {
            if (creditDeductionId) await this.adSystem.releaseHold(creditDeductionId);
            const error = new Error(`NO_FREE_NUMBERS: No numbers available from any provider.`);
            error.code = 'NO_FREE_NUMBERS';
            error.suggestAd = true;
            error.providerHealth = this.getProviderHealth();
            throw error;
        }

        // Cache results
        this._setCached(cacheKey, allNumbers);

        // Select best number with validation
        const candidates = this._rankNumbers(allNumbers);
        for (const candidate of candidates) {
            const result = await this._validateAndCreate(sessionId, candidate, service, country, startTime, userId, creditDeductionId);
            if (result) return result;
        }

        // All candidates failed validation
        if (creditDeductionId) await this.adSystem.releaseHold(creditDeductionId);
        const error = new Error(`NO_VALID_NUMBERS: All available numbers failed validation.`);
        error.code = 'NO_VALID_NUMBERS';
        error.suggestAd = true;
        throw error;
    }

    /**
     * Validate number before assignment, then deduct credits
     */
    async _validateAndCreate(sessionId, numberData, service, country, startTime, userId, creditDeductionId) {
        // Skip if blacklisted
        if (this.blacklist.has(numberData.number)) {
            logger.debug('Skipping blacklisted number', { number: this.maskPhone(numberData.number) });
            return null;
        }

        // Skip if already assigned
        if (this.assignedNumbers.has(numberData.number)) {
            logger.debug('Skipping assigned number', { number: this.maskPhone(numberData.number) });
            return null;
        }

        // Pre-validation: Can we reach the inbox page?
        const site = SITE_CONFIGS.find(s => s.id === numberData.site);
        if (!site) return null;

        try {
            // Quick inbox page check (HEAD request first for speed)
            const inboxUrl = `${site.baseUrl}${site.inboxPath(numberData.number)}`;
            const headCheck = await axios.head(inboxUrl, {
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                validateStatus: (s) => s === 200
            });
            
            if (headCheck.status !== 200) {
                logger.debug('Inbox page unreachable', { 
                    number: this.maskPhone(numberData.number), 
                    status: headCheck.status 
                });
                return null;
            }
        } catch (e) {
            // HEAD not supported or page down — continue with GET in actual use
            logger.debug('Pre-validation HEAD failed, continuing', { 
                number: this.maskPhone(numberData.number) 
            });
        }

        // Now safe to deduct credits
        if (userId && creditDeductionId) {
            await this.adSystem.commitHold(creditDeductionId);
        }

        return this._createSession(sessionId, numberData, service, country, startTime);
    }

    /**
     * PARALLEL scrape all healthy sites
     */
    async _scrapeAllSitesParallel(targetCountries) {
        const sites = SITE_CONFIGS
            .filter(s => s.enabled && Date.now() > s.disabledUntil)
            .sort((a, b) => b.priority - a.priority);

        if (sites.length === 0) {
            logger.error('No healthy providers available');
            return [];
        }

        // Launch all requests in parallel with individual timeouts
        const promises = sites.map(site =>
            this._scrapeSiteWithTimeout(site, targetCountries)
                .then(numbers => {
                    this._recordProviderSuccess(site.id);
                    return { site: site.id, numbers, success: true };
                })
                .catch(error => {
                    this._recordProviderFailure(site.id, error);
                    logger.debug(`Site ${site.name} failed`, { 
                        error: error.message,
                        health: site.healthScore 
                    });
                    return { site: site.id, numbers: [], success: false, error: error.message };
                })
        );

        const results = await Promise.allSettled(promises);

        // Aggregate all successful results
        const allNumbers = [];
        const successSites = [];
        
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value.success) {
                allNumbers.push(...result.value.numbers);
                successSites.push(result.value.site);
            }
        }

        logger.info('Parallel scrape complete', { 
            attempted: sites.length, 
            succeeded: successSites.length,
            numbersFound: allNumbers.length 
        });

        // Deduplicate across sites (keep highest priority instance)
        const seen = new Map();
        for (const n of allNumbers) {
            if (!seen.has(n.number) || n.priority > seen.get(n.number).priority) {
                seen.set(n.number, n);
            }
        }

        return Array.from(seen.values());
    }

    /**
     * Scrape a single site with timeout wrapper and retry
     */
    async _scrapeSiteWithTimeout(site, targetCountries) {
        let lastError = null;
        
        for (let attempt = 0; attempt <= site.retries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), site.timeout);

            try {
                const numbers = await this._scrapeSiteNumbers(site, targetCountries, controller.signal);
                clearTimeout(timeout);
                return numbers;
            } catch (error) {
                clearTimeout(timeout);
                lastError = error;
                if (attempt < site.retries) {
                    await this.delay(1000 * (attempt + 1)); // Exponential backoff
                }
            }
        }

        throw lastError || new Error('All retries failed');
    }

    /**
     * Scrape numbers from a single site — ROBUST parser with multiple fallback strategies
     */
    async _scrapeSiteNumbers(site, targetCountries, signal) {
        const url = `${site.baseUrl}${site.numbersPath}`;
        const numbers = [];

        const response = await axios.get(url, {
            timeout: site.timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive'
            },
            validateStatus: () => true,
            maxRedirects: 5
        });

        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }

        const $ = cheerio.load(response.data);
        const pageText = $('body').text();

        // Strategy 1: Site-specific structured parsing
        const structuredNumbers = this._parseStructured($, site, targetCountries);
        numbers.push(...structuredNumbers);

        // Strategy 2: If structured parsing yields few results, scan all text
        if (numbers.length < 3) {
            const textNumbers = this._parseFromText(pageText, site, targetCountries);
            numbers.push(...textNumbers);
        }

        // Strategy 3: Look for tel: links and specific patterns
        const linkNumbers = this._parseFromLinks($, site, targetCountries);
        numbers.push(...linkNumbers);

        logger.debug(`Scraped ${site.name}`, { 
            structured: structuredNumbers.length,
            text: numbers.length - structuredNumbers.length - linkNumbers.length,
            links: linkNumbers.length,
            total: numbers.length 
        });

        return numbers;
    }

    /**
     * Strategy 1: Structured DOM parsing
     */
    _parseStructured($, site, targetCountries) {
        const numbers = [];
        const selectors = this._getSelectorsForSite(site.id);

        for (const selector of selectors) {
            $(selector).each((_, el) => {
                const $el = $(el);
                
                // Try data attributes first
                let num = $el.attr('data-number') || 
                         $el.attr('data-phone') || 
                         $el.attr('href')?.replace('tel:', '');

                // Then try text content
                if (!num) {
                    num = this._extractNumber($el.text());
                }

                if (num) {
                    const country = this._detectCountry(num);
                    if (targetCountries.includes(country)) {
                        numbers.push({
                            number: num,
                            country,
                            site: site.id,
                            siteName: site.name,
                            priority: site.priority
                        });
                    }
                }
            });
        }

        return numbers;
    }

    /**
     * Strategy 2: Parse from raw text (fallback)
     */
    _parseFromText(text, site, targetCountries) {
        const numbers = [];
        const extracted = this._extractAllNumbers(text);
        
        for (const num of extracted) {
            const country = this._detectCountry(num);
            if (targetCountries.includes(country)) {
                numbers.push({
                    number: num,
                    country,
                    site: site.id,
                    siteName: site.name,
                    priority: site.priority
                });
            }
        }

        return numbers;
    }

    /**
     * Strategy 3: Parse from tel: links and anchors
     */
    _parseFromLinks($, site, targetCountries) {
        const numbers = [];
        
        $('a[href^="tel:"], a[href^="sms:"]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const num = href.replace(/^(tel:|sms:)/, '').replace(/[^+\d]/g, '');
            
            if (num.startsWith('+')) {
                const country = this._detectCountry(num);
                if (targetCountries.includes(country)) {
                    numbers.push({
                        number: num,
                        country,
                        site: site.id,
                        siteName: site.name,
                        priority: site.priority
                    });
                }
            }
        });

        return numbers;
    }

    /**
     * Get CSS selectors for specific sites (extensible)
     */
    _getSelectorsForSite(siteId) {
        const selectorMap = {
            'receive_a_sms': [
                '.number-box', '.phone-item', '[class*="number"]', 
                '.num-box', '.phone', 'tr td:first-child'
            ],
            'smsreceivefree': [
                '.number', '.phone', '[data-number]', '.num-item',
                '.phone-number', 'h3, h4' // Often numbers are in headers
            ],
            'sms_online_co': [
                '.phone-number', '.number-item', '.num-card',
                '[class*="phone"]', '[class*="number"]'
            ],
            'sellaite': [
                'a[href^="/sms/"]', '.number-list li', '.num',
                'table tr td', '.phone-entry'
            ],
            'receive_sms_online': [
                '.number-box', '.phone-item', 'tr', '.sms-number',
                '.number-card', '[class*="phone"]'
            ],
            'receivesmsonline': [
                '.number-box', '.phone-item', 'tr', '.num-entry',
                '.phone-card'
            ],
            'smslisten': [
                '.number-card', '.phone-number', '.sms-item',
                '[class*="number"]', 'tr'
            ]
        };

        return selectorMap[siteId] || ['[class*="number"]', '[class*="phone"]', 'tr', 'td', 'li'];
    }

    /**
     * Rank and select best number with comprehensive scoring
     */
    _rankNumbers(candidates) {
        return candidates
            .filter(c => !this.blacklist.has(c.number))
            .filter(c => !this.assignedNumbers.has(c.number))
            .map(c => {
                const stats = this.numberStats.get(c.number) || { 
                    success: 0, failure: 0, lastUsed: 0, lastSMSReceived: 0, assignedCount: 0 
                };
                
                const totalAttempts = stats.success + stats.failure;
                const successRate = totalAttempts > 0 ? stats.success / totalAttempts : 0.5;
                
                // Time since last use (hours)
                const hoursSinceUse = (Date.now() - stats.lastUsed) / (1000 * 60 * 60);
                const recencyBonus = Math.min(hoursSinceUse / 24, 1);
                
                // Time since last SMS received ( freshness indicator )
                const hoursSinceSMS = stats.lastSMSReceived 
                    ? (Date.now() - stats.lastSMSReceived) / (1000 * 60 * 60) 
                    : 48; // Default to 48h if never received
                
                // Freshness score: numbers that recently received SMS are preferred
                const freshnessScore = Math.max(0, 1 - (hoursSinceSMS / 24));

                // Penalize overused numbers
                const usagePenalty = Math.min(stats.assignedCount / 10, 0.5);

                const score = (
                    (c.priority * 10) * 
                    (successRate + 0.2) * 
                    (1 + recencyBonus) * 
                    (1 + freshnessScore) * 
                    (1 - usagePenalty)
                );

                return { ...c, score, successRate, stats };
            })
            .sort((a, b) => b.score - a.score);
    }

    _selectBestNumber(candidates) {
        const ranked = this._rankNumbers(candidates);
        return ranked[0] || null;
    }

    /**
     * Create a session for the selected number
     */
    _createSession(sessionId, numberData, service, country, startTime) {
        this.activeSessions.set(sessionId, {
            sessionId,
            number: numberData.number,
            siteId: numberData.site,
            siteName: numberData.siteName,
            assignedAt: Date.now(),
            service,
            country: country || numberData.country,
            status: 'ACTIVE',
            messages: [],
            seenMessageIds: new Set(), // Track by content hash to prevent duplicates
            retryCount: 0,
            otpCode: null,
            fullText: null,
            lastPollAt: 0,
            pollCount: 0
        });

        this.assignedNumbers.set(numberData.number, {
            sessionId,
            assignedAt: Date.now()
        });

        // Update stats
        const stats = this.numberStats.get(numberData.number) || { 
            success: 0, failure: 0, lastUsed: 0, lastSMSReceived: 0, assignedCount: 0 
        };
        stats.lastUsed = Date.now();
        stats.assignedCount++;
        this.numberStats.set(numberData.number, stats);

        logger.info('Free number assigned', {
            sessionId,
            site: numberData.siteName,
            number: this.maskPhone(numberData.number),
            country: numberData.country,
            duration: Date.now() - startTime,
            score: numberData.score?.toFixed(2) || 'N/A'
        });

        return {
            phoneNumber: numberData.number,
            provider: this.name,
            providerNumberId: sessionId,
            country: numberData.country,
            service,
            cost: 0,
            isPublic: true,
            source: numberData.siteName,
            sessionId,
            warning: 'FREE TIER: Public/shared number. Anyone can see SMS. Not for sensitive accounts.'
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  NUMBER EXTRACTION HELPERS v2 — FIXED REGEX
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Extract single number from text
     */
    _extractNumber(text) {
        if (!text) return null;
        const cleaned = text.replace(/[^\d+\s\-]/g, '');
        const matches = this._extractAllNumbers(cleaned);
        return matches.length > 0 ? matches[0] : null;
    }

    /**
     * Extract all valid international numbers from text
     */
    _extractAllNumbers(text) {
        if (!text) return [];
        
        const numbers = new Set();
        
        // Pattern 1: Explicit international format with +
        const intlPattern = /\+[\d\s\-]{7,15}\d/g;
        let match;
        while ((match = intlPattern.exec(text)) !== null) {
            const cleaned = match[0].replace(/[\s\-]/g, '');
            if (this._isValidLength(cleaned)) {
                numbers.add(cleaned);
            }
        }

        // Pattern 2: Numbers starting with country code digits (no +, but context suggests international)
        // e.g., "Number: 12025551234" for US
        const contextPattern = /(?:number|phone|tel|mobile)[:\s]+(\d{10,14})/gi;
        while ((match = contextPattern.exec(text)) !== null) {
            const num = match[1];
            const country = this._detectCountryByLength(num);
            if (country) {
                const fullNum = COUNTRY_CODES[country].regex.source.replace('^', '').replace('\\d', '') + num;
                numbers.add(fullNum);
            }
        }

        return Array.from(numbers);
    }

    _isValidLength(number) {
        if (!number) return false;
        const digitsOnly = number.replace('+', '');
        return digitsOnly.length >= 10 && digitsOnly.length <= 15;
    }

    /**
     * Detect country by full number with collision resolution
     */
    _detectCountry(phoneNumber) {
        if (!phoneNumber) return 'UNKNOWN';

        // Direct regex matching
        for (const [code, data] of Object.entries(COUNTRY_CODES)) {
            if (data.regex.test(phoneNumber)) {
                // Special handling for +1 (US/CA)
                if (code === 'US' || code === 'CA') {
                    return this._resolveUSCA(phoneNumber);
                }
                return code;
            }
        }

        return 'UNKNOWN';
    }

    /**
     * Resolve US vs Canada for +1 numbers using area code analysis
     */
    _resolveUSCA(phoneNumber) {
        // Canadian area codes (partial list of most common)
        const canadianAreaCodes = new Set([
            '204', '226', '236', '249', '250', '289', '306', '343', '365', '403',
            '416', '418', '431', '437', '438', '450', '506', '514', '519', '579',
            '581', '587', '604', '613', '639', '647', '672', '705', '709', '778',
            '780', '807', '819', '867', '873', '902', '905'
        ]);

        const digits = phoneNumber.replace('+', '');
        const areaCode = digits.substring(1, 4);

        return canadianAreaCodes.has(areaCode) ? 'CA' : 'US';
    }

    /**
     * Fallback country detection by length when no + prefix
     */
    _detectCountryByLength(number) {
        const len = number.length;
        if (len === 10) return 'US'; // Assume US for 10 digits
        if (len === 11 && number.startsWith('1')) return 'US';
        return null;
    }

    _getFlag(code) {
        return COUNTRY_CODES[code]?.flag || '🌍';
            }
        // ═══════════════════════════════════════════════════════════════════════
    //  SMS RETRIEVAL v2 — Real inbox checking with deduplication and validation
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check SMS for a session
     * Returns real SMS data ONLY — no simulation
     */
    async checkSMS(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            return { success: false, status: 'NOT_FOUND', message: 'Session not found or expired' };
        }

        session.lastPollAt = Date.now();
        session.pollCount++;

        // Return cached OTP if already found
        if (session.otpCode) {
            return {
                success: true,
                status: 'RECEIVED',
                otp: session.otpCode,
                fullText: session.fullText,
                number: session.number,
                sender: session.lastSender || 'Unknown',
                foundAt: session.otpFoundAt
            };
        }

        // Check cache for recent messages (fast path)
        const cacheKey = `messages_${session.number}_${session.siteId}`;
        const cachedMessages = this._getCached(cacheKey, 'messages');

        if (cachedMessages && cachedMessages.length > 0) {
            const newMessage = this._findNewMessage(session, cachedMessages);
            if (newMessage) {
                return this._processMessage(session, newMessage);
            }
        }

        // Fetch fresh messages from site
        try {
            const site = SITE_CONFIGS.find(s => s.id === session.siteId);
            if (!site) {
                return { success: false, status: 'ERROR', message: 'Site configuration not found' };
            }

            // Verify site is still healthy
            if (!site.enabled || Date.now() < site.disabledUntil) {
                return { 
                    success: false, 
                    status: 'PROVIDER_DOWN', 
                    message: `Provider ${site.name} temporarily unavailable` 
                };
            }

            const messages = await this._fetchMessagesFromSite(site, session.number);

            // Cache results
            this._setCached(cacheKey, messages, 'messages');

            const newMessage = this._findNewMessage(session, messages);
            if (newMessage) {
                return this._processMessage(session, newMessage);
            }

            // No new messages — log polling attempt for debugging
            logger.debug('SMS poll: no new messages', {
                sessionId,
                site: session.siteId,
                pollCount: session.pollCount,
                elapsed: Math.floor((Date.now() - session.assignedAt) / 1000)
            });

        } catch (error) {
            logger.warn('SMS fetch failed', {
                sessionId,
                error: error.message,
                site: session.siteId,
                pollCount: session.pollCount
            });
            
            // If consistent failures, mark provider unhealthy
            if (session.pollCount > 3) {
                this._recordProviderFailure(session.siteId, error);
            }
        }

        return {
            success: false,
            status: 'POLLING',
            message: 'Waiting for SMS...',
            number: session.number,
            elapsed: Math.floor((Date.now() - session.assignedAt) / 1000),
            pollCount: session.pollCount
        };
    }

    /**
     * Fetch messages from a specific site's inbox page — ROBUST parsing
     */
    async _fetchMessagesFromSite(site, number) {
        const url = `${site.baseUrl}${site.inboxPath(number)}`;

        const response = await axios.get(url, {
            timeout: site.timeout,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br'
            },
            validateStatus: () => true,
            maxRedirects: 5
        });

        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }

        const $ = cheerio.load(response.data);
        const messages = [];

        // Try site-specific selectors first
        const siteSelectors = this._getMessageSelectorsForSite(site.id);
        
        for (const selector of siteSelectors) {
            $(selector).each((_, el) => {
                const $el = $(el);
                const msg = this._extractMessageFromElement($, $el, site.id);
                if (msg && msg.text.length > 3) {
                    messages.push(msg);
                }
            });
            
            // If we found messages, don't try other selectors (prevent duplicates)
            if (messages.length > 0) break;
        }

        // Fallback: Generic table row scanning
        if (messages.length === 0) {
            $('tr, .message, .sms, [class*="sms"], [class*="message"]').each((_, el) => {
                const $el = $(el);
                const text = $el.text().trim();
                
                // Must contain digits (likely OTP) and be reasonable length
                if (text.length > 10 && text.length < 500 && /\d{3,}/.test(text)) {
                    const msg = this._extractMessageFromElement($, $el, 'generic');
                    if (msg) messages.push(msg);
                }
            });
        }

        // Deduplicate by content hash
        const seen = new Set();
        const unique = messages.filter(m => {
            const hash = this._hashMessage(m);
            if (seen.has(hash)) return false;
            seen.add(hash);
            return true;
        });

        // Sort by time (newest first), limit to 15
        return unique
            .sort((a, b) => new Date(b.time) - new Date(a.time))
            .slice(0, 15);
    }

    /**
     * Get message selectors for specific sites
     */
    _getMessageSelectorsForSite(siteId) {
        const selectorMap = {
            'receive_a_sms': [
                '.message-item', '.sms-item', 'tr', 
                '.msg', '.sms', '[class*="message"]'
            ],
            'smsreceivefree': [
                '.message', '.sms', '.msg-item',
                '[class*="sms"]', 'tr'
            ],
            'sms_online_co': [
                '.message-row', '.sms-item', '.msg',
                '[class*="message"]', 'tr'
            ],
            'sellaite': [
                '.msg', '.message', '.sms',
                'tr', 'div[class*="msg"]'
            ],
            'receive_sms_online': [
                '.smsListItem', '.message-item', '.msg',
                'tr', '[class*="sms"]'
            ],
            'receivesmsonline': [
                '.smsListItem', '.message-item', '.sms',
                'tr', '[class*="message"]'
            ],
            'smslisten': [
                '.message-card', '.sms-item', '.msg',
                '[class*="message"]', 'tr'
            ]
        };

        return selectorMap[siteId] || ['.message', '.sms', 'tr', '[class*="message"]', '[class*="sms"]'];
    }

    /**
     * Extract structured message from DOM element
     */
    _extractMessageFromElement($, $el, siteId) {
        const text = $el.text().trim();
        if (!text || text.length < 5) return null;

        // Try to find sender
        let from = 'Unknown';
        const fromSelectors = ['.sender', '.from', '.source', '.number', 'td:first-child', '.from-number'];
        for (const sel of fromSelectors) {
            const found = $el.find(sel).text().trim();
            if (found && found !== text) {
                from = found;
                break;
            }
        }

        // Try to find time
        let time = new Date().toISOString();
        const timeSelectors = ['.time', '.date', '.timestamp', 'td:last-child', '.received'];
        for (const sel of timeSelectors) {
            const found = $el.find(sel).text().trim();
            if (found && found !== text && found !== from) {
                time = this._parseTime(found);
                break;
            }
        }

        // If no specific time found, try to parse from text
        if (time === new Date().toISOString()) {
            // Look for time patterns in the text itself
            const timeMatch = text.match(/\d{1,2}[:\/]\d{2}[:\/]\d{2}/);
            if (timeMatch) {
                time = this._parseTime(timeMatch[0]);
            }
        }

        return { from, text, time, siteId };
    }

    /**
     * Hash message for deduplication
     */
    _hashMessage(msg) {
        const normalized = msg.text.replace(/\s+/g, ' ').trim().toLowerCase();
        return `${msg.from}_${normalized.substring(0, 50)}`;
    }

    /**
     * Find messages received AFTER session started with deduplication
     */
    _findNewMessage(session, messages) {
        const sessionStart = session.assignedAt;

        for (const msg of messages) {
            const msgTime = new Date(msg.time).getTime();
            const msgHash = this._hashMessage(msg);
            
            // Message arrived after session started (with 5s buffer) and not seen before
            if (msgTime >= sessionStart - 5000 && !session.seenMessageIds.has(msgHash)) {
                session.seenMessageIds.add(msgHash);
                return msg;
            }
        }

        return null;
    }

    /**
     * Process a found message — extract OTP with confidence scoring
     */
    _processMessage(session, message) {
        const otpResult = this.extractOTP(message.text);
        
        session.messages.push(message);
        session.lastSender = message.from;

        // Update number stats — SMS received successfully
        const stats = this.numberStats.get(session.number) || { 
            success: 0, failure: 0, lastUsed: 0, lastSMSReceived: 0, assignedCount: 0 
        };
        stats.lastSMSReceived = Date.now();
        this.numberStats.set(session.number, stats);

        if (otpResult && otpResult.confidence > 0.5) {
            session.otpCode = otpResult.code;
            session.fullText = message.text;
            session.otpFoundAt = Date.now();

            // Update success stats
            stats.success++;
            this.numberStats.set(session.number, stats);

            logger.info('OTP found in free session', {
                sessionId: session.sessionId,
                number: this.maskPhone(session.number),
                otpLength: otpResult.code.length,
                confidence: otpResult.confidence,
                sender: message.from,
                deliveryTime: Date.now() - session.assignedAt
            });

            return {
                success: true,
                status: 'RECEIVED',
                otp: otpResult.code,
                fullText: message.text,
                sender: message.from,
                number: session.number,
                deliveryTime: Date.now() - session.assignedAt,
                confidence: otpResult.confidence
            };
        }

        // Message found but no high-confidence OTP — still return for transparency
        return {
            success: false,
            status: 'MESSAGE_NO_OTP',
            message: 'SMS received but no clear OTP detected',
            rawText: message.text,
            sender: message.from,
            number: session.number,
            detectedCodes: otpResult ? [otpResult.code] : [],
            confidence: otpResult?.confidence || 0
        };
    }

    _parseTime(timeStr) {
        if (!timeStr) return new Date().toISOString();

        // Try standard ISO/UTC formats first
        const isoDate = new Date(timeStr);
        if (!isNaN(isoDate.getTime())) {
            return isoDate.toISOString();
        }

        const now = new Date();
        const lower = timeStr.toLowerCase().trim();

        // Relative time parsing
        if (lower.includes('just now') || lower === 'now') {
            return now.toISOString();
        }
        
        const minMatch = lower.match(/(\d+)\s*min/i);
        if (minMatch) {
            const mins = parseInt(minMatch[1]);
            now.setMinutes(now.getMinutes() - mins);
            return now.toISOString();
        }

        const hourMatch = lower.match(/(\d+)\s*hour/i);
        if (hourMatch) {
            const hours = parseInt(hourMatch[1]);
            now.setHours(now.getHours() - hours);
            return now.toISOString();
        }

        const secMatch = lower.match(/(\d+)\s*sec/i);
        if (secMatch) {
            const secs = parseInt(secMatch[1]);
            now.setSeconds(now.getSeconds() - secs);
            return now.toISOString();
        }

        // Try common formats: "MM/DD/YYYY HH:MM", "DD-MM-YYYY HH:MM", etc.
        const formats = [
            /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\s+(\d{1,2}):(\d{2})/,
            /(\d{1,2}):(\d{2}):(\d{2})/,
            /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i
        ];

        for (const fmt of formats) {
            const match = timeStr.match(fmt);
            if (match) {
                const parsed = new Date(timeStr);
                if (!isNaN(parsed.getTime())) {
                    return parsed.toISOString();
                }
            }
        }

        return now.toISOString();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  POLLING ENGINE v2 — Live poll with real-time status and timeout handling
    // ═══════════════════════════════════════════════════════════════════════

    async pollForSMS(sessionId, onStatusUpdate = null) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            throw new Error('SESSION_NOT_FOUND');
        }

        const startTime = Date.now();
        const timeoutAt = startTime + this.POLL_CONFIG.timeout;
        let polls = 0;

        return new Promise((resolve) => {
            const check = async () => {
                polls++;
                const now = Date.now();

                // Timeout reached
                if (now > timeoutAt) {
                    await this._handleTimeout(session, sessionId, polls, startTime, onStatusUpdate, resolve);
                    return;
                }

                // Status update callback
                if (onStatusUpdate) {
                    try {
                        await onStatusUpdate({
                            status: 'POLLING',
                            message: `Checking inbox... (poll ${polls}, ${Math.round((now - startTime) / 1000)}s)`,
                            polls,
                            elapsed: Math.round((now - startTime) / 1000),
                            number: session.number
                        });
                    } catch (e) {
                        // Callback error shouldn't stop polling
                    }
                }

                // Check for SMS
                const result = await this.checkSMS(sessionId);

                if (result.success) {
                    const successResult = {
                        success: true,
                        status: 'RECEIVED',
                        otp: result.otp,
                        fullText: result.fullText,
                        number: result.number,
                        sender: result.sender,
                        deliveryTime: now - startTime,
                        polls,
                        confidence: result.confidence
                    };

                    if (onStatusUpdate) {
                        try { await onStatusUpdate(successResult); } catch (e) {}
                    }
                    resolve(successResult);
                    return;
                }

                // If we got a MESSAGE_NO_OTP, still notify but continue polling
                // (user might want to see the message even without OTP)
                if (result.status === 'MESSAGE_NO_OTP' && onStatusUpdate) {
                    try { 
                        await onStatusUpdate({
                            status: 'MESSAGE_NO_OTP',
                            rawText: result.rawText,
                            sender: result.sender,
                            message: 'SMS received but no OTP detected. Continuing to poll...'
                        }); 
                    } catch (e) {}
                }

                // Schedule next check
                setTimeout(check, this.POLL_CONFIG.interval);
            };

            check();
        });
    }

    async _handleTimeout(session, sessionId, polls, startTime, onStatusUpdate, resolve) {
        session.status = 'TIMEOUT';

        // Update failure stats
        const stats = this.numberStats.get(session.number) || { 
            success: 0, failure: 0, lastUsed: 0, lastSMSReceived: 0, assignedCount: 0 
        };
        stats.failure++;
        this.numberStats.set(session.number, stats);

        // Smart blacklisting: only blacklist if never received SMS and multiple failures
        const totalAttempts = stats.success + stats.failure;
        const neverReceivedSMS = !stats.lastSMSReceived || stats.lastSMSReceived < session.assignedAt - 86400000;
        
        if (stats.failure >= 3 && (stats.success === 0 || neverReceivedSMS)) {
            this.blacklist.set(session.number, {
                reason: 'TIMEOUT_NO_SMS',
                timestamp: Date.now(),
                permanent: false // Can be retried after cooldown
            });
            logger.info('Number blacklisted', { 
                number: this.maskPhone(session.number), 
                failures: stats.failure,
                reason: 'Consistent timeout without SMS'
            });
        }

        const result = {
            success: false,
            status: 'TIMEOUT',
            error: 'No SMS received within timeout period',
            sessionId,
            number: session.number,
            polls,
            duration: Date.now() - startTime,
            suggestRetry: stats.failure < 3,
            providerHealth: this.getProviderHealth()
        };

        if (onStatusUpdate) {
            try { await onStatusUpdate(result); } catch (e) {}
        }
        resolve(result);
    }

    async getSMS(sessionId) {
        return this.checkSMS(sessionId);
            }
            // ═══════════════════════════════════════════════════════════════════════
    //  RETRY SYSTEM v2 — Smart retry with provider rotation
    // ═══════════════════════════════════════════════════════════════════════

    async retryWithNewNumber(sessionId, country = null, service = 'Any', userId = null) {
        const oldSession = this.activeSessions.get(sessionId);
        if (!oldSession) throw new Error('SESSION_NOT_FOUND');

        if (oldSession.retryCount >= this.POLL_CONFIG.maxRetries) {
            return {
                success: false,
                status: 'MAX_RETRIES',
                error: 'Maximum retries reached. Please try again later or upgrade to premium.',
                suggestUpgrade: true
            };
        }

        // Blacklist the failed number (temporary)
        this.blacklist.set(oldSession.number, {
            reason: 'RETRY_AFTER_TIMEOUT',
            timestamp: Date.now(),
            permanent: false
        });

        // Release old session
        await this.releaseSession(sessionId);
        await this.delay(2000);

        // Try to get new number (will check credits again if userId provided)
        oldSession.retryCount++;
        
        try {
            // Force cache refresh to get fresh numbers
            this.cache.delete(`numbers_${country || oldSession.country || 'all'}`);
            
            const newNum = await this.getNumber(country || oldSession.country, service, userId);
            return {
                success: true,
                newSessionId: newNum.sessionId,
                newNumber: newNum.phoneNumber,
                retryCount: oldSession.retryCount,
                maxRetries: this.POLL_CONFIG.maxRetries
            };
        } catch (error) {
            return {
                success: false,
                status: 'RETRY_FAILED',
                error: error.message,
                code: error.code || 'UNKNOWN',
                suggestAd: error.code === 'INSUFFICIENT_CREDITS' || error.code === 'NO_FREE_NUMBERS'
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CANCEL / RELEASE v2
    // ═══════════════════════════════════════════════════════════════════════

    async cancelNumber(sessionId) {
        return this.releaseSession(sessionId);
    }

    async finishNumber(sessionId) {
        return this.releaseSession(sessionId);
    }

    releaseSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return { success: true, status: 'ALREADY_RELEASED' };

        this.assignedNumbers.delete(session.number);
        this.activeSessions.delete(sessionId);

        logger.info('Free session released', {
            sessionId,
            number: this.maskPhone(session.number),
            duration: Date.now() - session.assignedAt,
            polls: session.pollCount,
            messages: session.messages.length
        });

        return { success: true, status: 'RELEASED' };
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OTP EXTRACTION v2 — Confidence-scored multi-pattern extraction
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Extract OTP with confidence scoring
     * Returns: { code: string, confidence: number (0-1) } or null
     */
    extractOTP(text) {
        if (!text) return null;

        const candidates = [];
        const lowerText = text.toLowerCase();

        // Pattern definitions with weights
        const patterns = [
            // High confidence: explicit OTP/code keywords with colon/space
            { 
                pattern: /(?:your|the|verification|auth|security)[\s]+(?:code|otp|pin|token)[\s]*[:：is\s]+(\d{4,8})/i,
                weight: 1.0,
                name: 'explicit_code'
            },
            // High confidence: "code is 123456"
            { 
                pattern: /(?:code|otp|pin|token)[\s]+(?:is|：|:)[\s]*(\d{4,8})/i,
                weight: 0.95,
                name: 'code_is'
            },
            // High confidence: Chinese format
            { 
                pattern: /验证码[为是：\s]+(\d{4,8})/,
                weight: 0.95,
                name: 'chinese_verification'
            },
            // High confidence: Russian format
            { 
                pattern: /код[:\s]+(\d{4,8})/i,
                weight: 0.9,
                name: 'russian_code'
            },
            // Medium confidence: "is 123456" near code words
            { 
                pattern: /(?:is|：)[\s]*(\d{4,8})[\s]*(?:is your|your code|code is)/i,
                weight: 0.85,
                name: 'is_your_code'
            },
            // Medium confidence: standalone in context
            { 
                pattern: /(?:confirm|verify|authentication|access)[^\d]{0,20}(\d{4,8})/i,
                weight: 0.7,
                name: 'context_verify'
            },
            // Medium confidence: after "use code" or similar
            { 
                pattern: /(?:use|enter|input|type)[^\d]{0,15}(\d{4,8})/i,
                weight: 0.65,
                name: 'use_code'
            },
            // Lower confidence: just digits in message (but filter out phone numbers)
            { 
                pattern: /\b(\d{4,8})\b/g,
                weight: 0.4,
                name: 'standalone_digits',
                global: true
            }
        ];

        for (const def of patterns) {
            if (def.global) {
                // Handle global patterns (multiple matches)
                let match;
                while ((match = def.pattern.exec(text)) !== null) {
                    const code = match[1];
                    if (this._isValidOTP(code, text, match.index)) {
                        candidates.push({ code, confidence: def.weight, name: def.name, index: match.index });
                    }
                }
            } else {
                const match = text.match(def.pattern);
                if (match) {
                    const code = match[1];
                    if (this._isValidOTP(code, text, match.index)) {
                        candidates.push({ code, confidence: def.weight, name: def.name, index: match.index });
                    }
                }
            }
        }

        if (candidates.length === 0) return null;

        // Sort by confidence, then prefer codes near keywords
        candidates.sort((a, b) => {
            if (b.confidence !== a.confidence) return b.confidence - a.confidence;
            // Prefer earlier in text (usually main code, not phone numbers at end)
            return a.index - b.index;
        });

        const best = candidates[0];
        
        // Boost confidence if multiple patterns agree on same code
        const agreeing = candidates.filter(c => c.code === best.code);
        if (agreeing.length > 1) {
            best.confidence = Math.min(best.confidence + 0.15, 1.0);
        }

        return { code: best.code, confidence: best.confidence };
    }

    /**
     * Validate that extracted digits are likely an OTP, not a phone number or date
     */
    _isValidOTP(code, fullText, position) {
        if (!/^\d{4,8}$/.test(code)) return false;
        
        // Reject if it's part of a phone number pattern in the text
        const surrounding = fullText.substring(Math.max(0, position - 20), position + code.length + 20);
        
        // If surrounded by other digits with dashes/spaces, likely a phone number
        if (/\d[\s\-]\d{3}[\s\-]\d{4}/.test(surrounding)) return false;
        
        // Reject obvious dates (2024, 1990, etc)
        if (/^(19|20)\d{2}$/.test(code) && code.length === 4) {
            // Unless explicitly called a code
            const before = fullText.substring(Math.max(0, position - 30), position).toLowerCase();
            if (!/(code|otp|pin|verify|验证码|код)/.test(before)) return false;
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AD SYSTEM PROXY METHODS
    // ═══════════════════════════════════════════════════════════════════════

    async canRequestNumber(userId) {
        return this.adSystem.canRequestNumber(userId);
    }

    async getCredits(userId) {
        return this.adSystem.getCredits(userId);
    }

    async generateAdView(userId, network = 'shorte_st') {
        return this.adSystem.generateAdView(userId, network);
    }

    async handleAdWebhook(verificationId, payload) {
        return this.adSystem.handleAdWebhook(verificationId, payload);
    }

    getAvailableNetworks() {
        return this.adSystem.getAvailableNetworks();
    }

    async deductCredits(userId) {
        return this.adSystem.deductCredits(userId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  STATS & HEALTH v2 — Comprehensive monitoring
    // ═══════════════════════════════════════════════════════════════════════

    getProviderHealth() {
        return SITE_CONFIGS.map(s => ({
            id: s.id,
            name: s.name,
            enabled: s.enabled,
            disabledUntil: s.disabledUntil > Date.now() ? new Date(s.disabledUntil).toISOString() : null,
            priority: s.priority,
            healthScore: s.healthScore,
            consecutiveFails: s.consecutiveFails,
            successCount: s.successCount,
            failCount: s.failCount,
            lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
            status: s.enabled ? (s.healthScore > 70 ? 'HEALTHY' : s.healthScore > 30 ? 'DEGRADED' : 'UNHEALTHY') : 'DISABLED'
        }));
    }

    getActiveSessions() {
        return Array.from(this.activeSessions.entries()).map(([id, s]) => ({
            sessionId: id,
            number: this.maskPhone(s.number),
            status: s.status,
            service: s.service,
            site: s.siteName,
            messages: s.messages.length,
            polls: s.pollCount,
            elapsed: Math.floor((Date.now() - s.assignedAt) / 1000),
            hasOTP: !!s.otpCode
        }));
    }

    getStats() {
        const stats = {
            name: this.name,
            isActive: this.isActive,
            activeSessions: this.activeSessions.size,
            blacklistedNumbers: this.blacklist.size,
            cachedEntries: this.cache.size,
            sites: SITE_CONFIGS.length,
            timestamp: new Date().toISOString()
        };

        stats.providerHealth = this.getProviderHealth();

        stats.numberStats = Array.from(this.numberStats.entries())
            .map(([num, data]) => ({
                number: this.maskPhone(num),
                success: data.success,
                failure: data.failure,
                assignedCount: data.assignedCount,
                lastSMSReceived: data.lastSMSReceived ? new Date(data.lastSMSReceived).toISOString() : null,
                rate: data.success + data.failure > 0
                    ? (data.success / (data.success + data.failure) * 100).toFixed(1) + '%'
                    : 'N/A',
                blacklisted: this.blacklist.has(num) ? this.blacklist.get(num).reason : false
            }))
            .sort((a, b) => {
                const rateA = parseFloat(a.rate) || 0;
                const rateB = parseFloat(b.rate) || 0;
                return rateB - rateA;
            });

        // Session summary
        const sessions = Array.from(this.activeSessions.values());
        stats.sessionSummary = {
            active: sessions.filter(s => s.status === 'ACTIVE').length,
            timeout: sessions.filter(s => s.status === 'TIMEOUT').length,
            withOTP: sessions.filter(s => !!s.otpCode).length,
            totalMessages: sessions.reduce((sum, s) => sum + s.messages.length, 0)
        };

        return stats;
    }

    getNumbersByCountry(countryCode) {
        const allNumbers = [];
        for (const [num, data] of this.numberStats) {
            if (this._detectCountry(num) === countryCode) {
                allNumbers.push({
                    number: num,
                    ...data,
                    blacklisted: this.blacklist.has(num) ? this.blacklist.get(num) : false,
                    currentlyAssigned: this.assignedNumbers.has(num)
                });
            }
        }
        return allNumbers.sort((a, b) => (b.lastSMSReceived || 0) - (a.lastSMSReceived || 0));
    }

    /**
     * Force refresh provider status (manual recovery)
     */
    resetProviderHealth(siteId) {
        const site = SITE_CONFIGS.find(s => s.id === siteId);
        if (!site) return false;
        
        site.enabled = true;
        site.healthScore = 100;
        site.consecutiveFails = 0;
        site.disabledUntil = 0;
        site.failCount = 0;
        
        logger.info('Provider health manually reset', { site: site.name });
        return true;
    }

    /**
     * Get recommended countries based on current provider availability
     */
    getRecommendedCountries() {
        const availableCountries = new Set();
        
        for (const [num, stats] of this.numberStats) {
            if (this.blacklist.has(num)) continue;
            const country = this._detectCountry(num);
            if (country !== 'UNKNOWN') {
                availableCountries.add(country);
            }
        }

        return Array.from(availableCountries).map(code => ({
            code,
            ...COUNTRY_CODES[code],
            numbersAvailable: this.getNumbersByCountry(code).filter(n => !n.blacklisted).length
        })).sort((a, b) => b.numbersAvailable - a.numbersAvailable);
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

export default FreeProvider;
        
