// ═══════════════════════════════════════════════════════════════════════════════
// FreeProvider.js — Part 1/3: Core Engine, Fast Parallel Scraping, Ad Credits
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import * as cheerio from 'cheerio';
import logger from '../../utils/logger.js';
import AdCreditSystem from './AdCreditSystem.js';

/**
 * FreeProvider — FREE Tier SMS Number Aggregation Engine
 *
 * Architecture:
 * - Multi-site scraper with PARALLEL fetching (fast)
 * - In-memory LRU cache with TTL + background pre-warm
 * - Priority-based number selection (success-rate weighted)
 * - AdCreditSystem integration: credits required for free numbers
 * - Real SMS retrieval ONLY — no simulation
 */

// ─── Site Configurations ──────────────────────────────────────────────────────
const SITE_CONFIGS = [
    {
        id: 'receive_a_sms',
        name: 'receive-a-sms.com',
        enabled: true,
        baseUrl: 'https://receive-a-sms.com',
        numbersPath: '/',
        inboxPath: (number) => `/${number.replace('+', '')}`,
        priority: 3,
        timeout: 10000,  // REDUCED: 10s for faster response
        retries: 1
    },
    {
        id: 'smsreceivefree',
        name: 'smsreceivefree.com',
        enabled: true,
        baseUrl: 'https://smsreceivefree.com',
        numbersPath: '/',
        inboxPath: (number) => `/info/${number.replace('+', '')}`,
        priority: 2,
        timeout: 10000,
        retries: 1
    },
    {
        id: 'sms_online_co',
        name: 'sms-online.co',
        enabled: true,
        baseUrl: 'https://sms-online.co',
        numbersPath: '/free-phone-number',
        inboxPath: (number) => `/receive-sms/${number.replace('+', '')}`,
        priority: 4,
        timeout: 10000,
        retries: 1
    },
    {
        id: 'sellaite',
        name: 'sms.sellaite.com',
        enabled: true,
        baseUrl: 'http://sms.sellaite.com',
        numbersPath: '/',
        inboxPath: (number) => `/sms/${number.replace('+', '')}`,
        priority: 1,
        timeout: 12000,
        retries: 2
    },
    {
        id: 'receive_sms_online',
        name: 'receive-sms-online.com',
        enabled: true,
        baseUrl: 'https://receive-sms-online.com',
        numbersPath: '/',
        inboxPath: (number) => `/read-sms/${number.replace('+', '')}`,
        priority: 2,
        timeout: 10000,
        retries: 1
    },
    {
        id: 'receivesmsonline',
        name: 'receivesmsonline.net',
        enabled: true,
        baseUrl: 'https://receivesmsonline.net',
        numbersPath: '/',
        inboxPath: (number) => `/read-sms/${number.replace('+', '')}`,
        priority: 2,
        timeout: 10000,
        retries: 1
    },
    {
        id: 'smslisten',
        name: 'smslisten.com',
        enabled: true,
        baseUrl: 'https://smslisten.com',
        numbersPath: '/',
        inboxPath: (number) => `/receive-sms/${number.replace('+', '')}`,
        priority: 3,
        timeout: 10000,
        retries: 1
    }
];

// ─── Country Code Mapping ─────────────────────────────────────────────────────
const COUNTRY_CODES = {
    'ID': { regex: /^\+62/, flag: '🇮🇩', name: 'Indonesia' },
    'IN': { regex: /^\+91/, flag: '🇮🇳', name: 'India' },
    'VN': { regex: /^\+84/, flag: '🇻🇳', name: 'Vietnam' },
    'PH': { regex: /^\+63/, flag: '🇵🇭', name: 'Philippines' },
    'US': { regex: /^\+1/, flag: '🇺🇸', name: 'United States' },
    'UK': { regex: /^\+44/, flag: '🇬🇧', name: 'United Kingdom' },
    'CA': { regex: /^\+1/, flag: '🇨🇦', name: 'Canada' },
    'RU': { regex: /^\+7/, flag: '🇷🇺', name: 'Russia' },
    'DE': { regex: /^\+49/, flag: '🇩🇪', name: 'Germany' },
    'FR': { regex: /^\+33/, flag: '🇫🇷', name: 'France' }
};

// ─── Default Priority Countries ───────────────────────────────────────────────
const DEFAULT_COUNTRIES = ['ID', 'IN', 'VN', 'PH'];

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
        this.numberStats = new Map(); // number -> { success, failure, lastUsed }

        // Blacklist for failed numbers
        this.blacklist = new Set();

        // In-memory cache
        this.cache = new Map();
        this.CACHE_TTL = 45000;       // REDUCED: 45s for numbers (was 60s)
        this.MESSAGE_CACHE_TTL = 10000; // REDUCED: 10s for messages (was 15s)

        // Poll configuration
        this.POLL_CONFIG = {
            interval: 3000,      // REDUCED: 3s between polls (was 4s)
            timeout: 90000,      // 90s total timeout
            maxRetries: 1        // One retry with new number
        };

        // Background cache warming
        this.warmInterval = null;
        this.startCacheWarming();

        // Cleanup
        this.cleanupInterval = null;
        this.startCleanupJob();

        logger.info('FreeProvider initialized', {
            sites: SITE_CONFIGS.filter(s => s.enabled).length,
            cacheTTL: this.CACHE_TTL,
            pollInterval: this.POLL_CONFIG.interval
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CACHE MANAGEMENT
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
    //  BACKGROUND CACHE WARMING (NEW)
    // ═══════════════════════════════════════════════════════════════════════

    startCacheWarming() {
        // Pre-warm cache every 30 seconds in background
        this.warmInterval = setInterval(async () => {
            try {
                await this._warmCache();
            } catch (e) {
                // Silent fail — cache warming is best-effort
            }
        }, 30000);
    }

    stopCacheWarming() {
        if (this.warmInterval) {
            clearInterval(this.warmInterval);
            this.warmInterval = null;
        }
    }

    async _warmCache() {
        // Only warm if cache is empty or stale
        const cacheKey = 'numbers_all';
        const cached = this._getCached(cacheKey);
        if (cached && cached.length > 5) return; // Cache is healthy

        // Fire-and-forget parallel scrape
        this._scrapeAllSitesParallel(DEFAULT_COUNTRIES).then(numbers => {
            if (numbers.length > 0) {
                this._setCached(cacheKey, numbers);
                logger.debug('Cache warmed', { count: numbers.length });
            }
        }).catch(() => {});
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
    }

    cleanupStaleSessions() {
        const now = Date.now();
        const staleThreshold = 15 * 60 * 1000; // 15 minutes
        let cleaned = 0;

        for (const [sessionId, session] of this.activeSessions) {
            if (now - session.assignedAt > staleThreshold && session.status !== 'ACTIVE') {
                this.releaseSession(sessionId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info('Cleaned stale free sessions', { cleaned });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION — PARALLEL multi-site scraper with priority
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get numbers from all enabled sites, filtered by country preference
     * PARALLEL fetching for speed — returns on first success or aggregated results
     *
     * NEW: Integrated AdCreditSystem — checks credits before returning number
     */
    async getNumber(country = null, service = 'Any', userId = null) {
        const sessionId = `free_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const startTime = Date.now();

        // ─── AD CREDIT CHECK (NEW) ─────────────────────────────────────────
        if (userId) {
            const creditCheck = await this.adSystem.canRequestNumber(userId);

            if (!creditCheck.allowed && creditCheck.reason === 'DAILY_LIMIT_REACHED') {
                const error = new Error(`DAILY_LIMIT_REACHED: ${creditCheck.message}`);
                error.code = 'DAILY_LIMIT_REACHED';
                error.creditInfo = creditCheck;
                throw error;
            }

            if (!creditCheck.allowed && creditCheck.reason === 'INSUFFICIENT_CREDITS') {
                const error = new Error(`INSUFFICIENT_CREDITS: ${creditCheck.message}`);
                error.code = 'INSUFFICIENT_CREDITS';
                error.creditInfo = creditCheck;
                error.needsAd = true;
                error.shortfall = creditCheck.shortfall;
                throw error;
            }

            // Deduct credits now
            await this.adSystem.deductCredits(userId);
        }
        // ───────────────────────────────────────────────────────────────────

        // Check cache first (fast path)
        const cacheKey = `numbers_${country || 'all'}`;
        const cached = this._getCached(cacheKey);
        if (cached && cached.length > 0) {
            const available = this._selectBestNumber(cached);
            if (available) {
                return this._createSession(sessionId, available, service, country, startTime);
            }
        }

        // PARALLEL scrape all enabled sites (FAST)
        const targetCountries = country ? [country] : DEFAULT_COUNTRIES;
        const allNumbers = await this._scrapeAllSitesParallel(targetCountries);

        if (allNumbers.length === 0) {
            // NEW: When no numbers available, suggest ad-watching or upgrade
            const error = new Error(`NO_FREE_NUMBERS: No numbers available. All sites failed or empty.`);
            error.code = 'NO_FREE_NUMBERS';
            error.suggestAd = true;
            throw error;
        }

        // Cache results
        this._setCached(cacheKey, allNumbers);

        // Select best number
        const selected = this._selectBestNumber(allNumbers);
        if (!selected) {
            const error = new Error(`NO_FREE_NUMBERS: All available numbers blacklisted or exhausted.`);
            error.code = 'NO_FREE_NUMBERS';
            error.suggestAd = true;
            throw error;
        }

        return this._createSession(sessionId, selected, service, country, startTime);
    }

    /**
     * PARALLEL scrape all sites — returns aggregated results from all successful sites
     * This is the FAST path vs the old sequential approach
     */
    async _scrapeAllSitesParallel(targetCountries) {
        const sites = [...SITE_CONFIGS]
            .filter(s => s.enabled)
            .sort((a, b) => b.priority - a.priority);

        // Launch all requests in parallel with individual timeouts
        const promises = sites.map(site =>
            this._scrapeSiteWithTimeout(site, targetCountries)
                .then(numbers => ({ site: site.id, numbers, success: true }))
                .catch(error => {
                    logger.debug(`Site ${site.name} failed`, { error: error.message });
                    return { site: site.id, numbers: [], success: false, error: error.message };
                })
        );

        const results = await Promise.allSettled(promises);

        // Aggregate all successful results
        const allNumbers = [];
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value.success) {
                allNumbers.push(...result.value.numbers);
            }
        }

        // Deduplicate across sites
        const seen = new Set();
        return allNumbers.filter(n => {
            if (seen.has(n.number)) return false;
            seen.add(n.number);
            return true;
        });
    }

    /**
     * Scrape a single site with timeout wrapper
     */
    async _scrapeSiteWithTimeout(site, targetCountries) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), site.timeout);

        try {
            const numbers = await this._scrapeSiteNumbers(site, targetCountries, controller.signal);
            return numbers;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Scrape numbers from a single site
     */
    async _scrapeSiteNumbers(site, targetCountries, signal) {
        const url = `${site.baseUrl}${site.numbersPath}`;
        const numbers = [];

        const response = await axios.get(url, {
            timeout: site.timeout,
            signal, // AbortController signal for cancellation
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            validateStatus: () => true
        });

        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }

        const $ = cheerio.load(response.data);

        // Site-specific parsing
        switch (site.id) {
            case 'receive_a_sms':
                $('.number-box, .phone-item, [class*="number"]').each((_, el) => {
                    const num = this._extractNumber($(el).text());
                    const country = this._detectCountry(num);
                    if (num && targetCountries.includes(country)) {
                        numbers.push({
                            number: num,
                            country,
                            site: site.id,
                            siteName: site.name,
                            priority: site.priority
                        });
                    }
                });
                break;

            case 'smsreceivefree':
                $('.number, .phone, [data-number]').each((_, el) => {
                    const num = $(el).attr('data-number') || this._extractNumber($(el).text());
                    const country = this._detectCountry(num);
                    if (num && targetCountries.includes(country)) {
                        numbers.push({ number: num, country, site: site.id, siteName: site.name, priority: site.priority });
                    }
                });
                break;

            case 'sms_online_co':
                $('.phone-number, .number-item').each((_, el) => {
                    const num = this._extractNumber($(el).text());
                    const country = this._detectCountry(num);
                    if (num && targetCountries.includes(country)) {
                        numbers.push({ number: num, country, site: site.id, siteName: site.name, priority: site.priority });
                    }
                });
                break;

            case 'sellaite':
                $('a[href^="/sms/"], .number-list li').each((_, el) => {
                    const text = $(el).text();
                    const num = this._extractNumber(text);
                    const country = this._detectCountry(num);
                    if (num && targetCountries.includes(country)) {
                        numbers.push({ number: num, country, site: site.id, siteName: site.name, priority: site.priority });
                    }
                });
                break;

            case 'receive_sms_online':
            case 'receivesmsonline':
                $('.number-box, .phone-item, tr').each((_, el) => {
                    const num = this._extractNumber($(el).text());
                    const country = this._detectCountry(num);
                    if (num && targetCountries.includes(country)) {
                        numbers.push({ number: num, country, site: site.id, siteName: site.name, priority: site.priority });
                    }
                });
                break;

            case 'smslisten':
                $('.number-card, .phone-number').each((_, el) => {
                    const num = this._extractNumber($(el).text());
                    const country = this._detectCountry(num);
                    if (num && targetCountries.includes(country)) {
                        numbers.push({ number: num, country, site: site.id, siteName: site.name, priority: site.priority });
                    }
                });
                break;

            default:
                // Generic fallback
                $('body').find('*').each((_, el) => {
                    const text = $(el).text();
                    const num = this._extractNumber(text);
                    if (num) {
                        const country = this._detectCountry(num);
                        if (targetCountries.includes(country)) {
                            numbers.push({ number: num, country, site: site.id, siteName: site.name, priority: site.priority });
                        }
                    }
                });
        }

        return numbers;
    }

    /**
     * Select best number based on priority, success rate, and blacklist
     */
    _selectBestNumber(candidates) {
        const scored = candidates
            .filter(c => !this.blacklist.has(c.number))
            .filter(c => !this.assignedNumbers.has(c.number))
            .map(c => {
                const stats = this.numberStats.get(c.number) || { success: 0, failure: 0, lastUsed: 0 };
                const successRate = stats.success + stats.failure > 0
                    ? stats.success / (stats.success + stats.failure)
                    : 0.5; // Default 50% for new numbers

                // Score: priority * successRate * recency bonus
                const hoursSinceUse = (Date.now() - stats.lastUsed) / (1000 * 60 * 60);
                const recencyBonus = Math.min(hoursSinceUse / 24, 1); // Max bonus after 24h

                return {
                    ...c,
                    score: (c.priority * 10) * (successRate + 0.1) * (1 + recencyBonus)
                };
            });

        scored.sort((a, b) => b.score - a.score);

        return scored[0] || null;
    }

    /**
     * Create a session for the selected number
     */
    _createSession(sessionId, numberData, service, country, startTime) {
        this.activeSessions.set(sessionId, {
            sessionId,
            number: numberData







            // ═══════════════════════════════════════════════════════════════════════════════
// FreeProvider.js — Part 2/3: SMS Retrieval, Parallel Message Fetching, Polling
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  SMS RETRIEVAL — Real inbox checking from scraped sites
    //  OPTIMIZED: Parallel message fetching, smarter caching
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check SMS for a session
     * Returns real SMS data ONLY — no simulation
     */
    async checkSMS(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            return { success: false, status: 'NOT_FOUND', message: 'Session not found' };
        }

        // Return cached OTP if already found
        if (session.otpCode) {
            return {
                success: true,
                status: 'RECEIVED',
                otp: session.otpCode,
                fullText: session.fullText,
                number: session.number,
                sender: session.lastSender || 'Unknown'
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
                return { success: false, status: 'ERROR', message: 'Site config not found' };
            }

            const messages = await this._fetchMessagesFromSite(site, session.number);

            // Cache results
            this._setCached(cacheKey, messages, 'messages');

            const newMessage = this._findNewMessage(session, messages);
            if (newMessage) {
                return this._processMessage(session, newMessage);
            }

        } catch (error) {
            logger.debug('SMS fetch failed', {
                sessionId,
                error: error.message,
                site: session.siteId
            });
        }

        return {
            success: false,
            status: 'POLLING',
            message: 'Waiting for SMS...',
            number: session.number,
            elapsed: Math.floor((Date.now() - session.assignedAt) / 1000)
        };
    }

    /**
     * Fetch messages from a specific site's inbox page
     */
    async _fetchMessagesFromSite(site, number) {
        const url = `${site.baseUrl}${site.inboxPath(number)}`;

        const response = await axios.get(url, {
            timeout: site.timeout,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            validateStatus: () => true
        });

        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }

        const $ = cheerio.load(response.data);
        const messages = [];

        // Site-specific message parsing
        switch (site.id) {
            case 'receive_a_sms':
                $('.message-item, .sms-item, tr').each((_, el) => {
                    const $el = $(el);
                    const from = $el.find('.sender, .from, td:first-child').text().trim();
                    const text = $el.find('.text, .body, td:nth-child(2)').text().trim();
                    const time = $el.find('.time, .date, td:nth-child(3)').text().trim();

                    if (text && text.length > 5) {
                        messages.push({ from: from || 'Unknown', text, time: this._parseTime(time) });
                    }
                });
                break;

            case 'smsreceivefree':
                $('.message, .sms').each((_, el) => {
                    const $el = $(el);
                    const from = $el.find('.from, .sender').text().trim();
                    const text = $el.find('.text, .body').text().trim();
                    const time = $el.find('.time').text().trim();

                    if (text && text.length > 5) {
                        messages.push({ from: from || 'Unknown', text, time: this._parseTime(time) });
                    }
                });
                break;

            case 'sms_online_co':
                $('.message-row, .sms-item').each((_, el) => {
                    const $el = $(el);
                    const from = $el.find('.sender-name, .from').text().trim();
                    const text = $el.find('.message-text, .sms-body').text().trim();
                    const time = $el.find('.message-time, .timestamp').text().trim();

                    if (text && text.length > 5) {
                        messages.push({ from: from || 'Unknown', text, time: this._parseTime(time) });
                    }
                });
                break;

            case 'sellaite':
                $('.msg, .message').each((_, el) => {
                    const $el = $(el);
                    const text = $el.text().trim();
                    const from = $el.find('.from, .sender').text().trim() || 'Unknown';

                    if (text && text.length > 5) {
                        messages.push({ from, text, time: new Date().toISOString() });
                    }
                });
                break;

            case 'receive_sms_online':
            case 'receivesmsonline':
                $('.smsListItem, .message-item').each((_, el) => {
                    const $el = $(el);
                    const from = $el.find('.sender, .from').text().trim();
                    const text = $el.find('.text, .body').text().trim();
                    const time = $el.find('.time, .date').text().trim();

                    if (text && text.length > 5) {
                        messages.push({ from: from || 'Unknown', text, time: this._parseTime(time) });
                    }
                });
                break;

            case 'smslisten':
                $('.message-card, .sms-item').each((_, el) => {
                    const $el = $(el);
                    const from = $el.find('.sender, .from').text().trim();
                    const text = $el.find('.text, .content').text().trim();
                    const time = $el.find('.time, .timestamp').text().trim();

                    if (text && text.length > 5) {
                        messages.push({ from: from || 'Unknown', text, time: this._parseTime(time) });
                    }
                });
                break;

            default:
                // Generic: look for table rows or divs with message-like content
                $('tr, .message, .sms').each((_, el) => {
                    const $el = $(el);
                    const text = $el.text().trim();

                    if (text.length > 10 && text.length < 500 && /\d{4,8}/.test(text)) {
                        messages.push({
                            from: 'Unknown',
                            text,
                            time: new Date().toISOString()
                        });
                    }
                });
        }

        // Sort by time (newest first), limit to 10
        return messages
            .sort((a, b) => new Date(b.time) - new Date(a.time))
            .slice(0, 10);
    }

    /**
     * Find messages received AFTER session started
     */
    _findNewMessage(session, messages) {
        const sessionStart = session.assignedAt;
        const seenTexts = new Set(session.messages.map(m => m.text));

        for (const msg of messages) {
            const msgTime = new Date(msg.time).getTime();
            // Message arrived after session started and not seen before
            if (msgTime >= sessionStart - 5000 && !seenTexts.has(msg.text)) {
                return msg;
            }
        }

        return null;
    }

    /**
     * Process a found message — extract OTP and update session
     */
    _processMessage(session, message) {
        const otp = this.extractOTP(message.text);

        session.messages.push(message);
        session.lastSender = message.from;

        if (otp) {
            session.otpCode = otp;
            session.fullText = message.text;

            // Update success stats
            const stats = this.numberStats.get(session.number) || { success: 0, failure: 0, lastUsed: 0 };
            stats.success++;
            this.numberStats.set(session.number, stats);

            logger.info('OTP found in free session', {
                sessionId: session.sessionId || 'unknown',
                number: this.maskPhone(session.number),
                otpLength: otp.length
            });

            return {
                success: true,
                status: 'RECEIVED',
                otp,
                fullText: message.text,
                sender: message.from,
                number: session.number,
                deliveryTime: Date.now() - session.assignedAt
            };
        }

        // Message found but no OTP — still return it for transparency
        return {
            success: false,
            status: 'MESSAGE_NO_OTP',
            message: 'SMS received but no OTP detected',
            rawText: message.text,
            number: session.number
        };
    }

    _parseTime(timeStr) {
        if (!timeStr) return new Date().toISOString();

        try {
            const date = new Date(timeStr);
            if (!isNaN(date.getTime())) {
                return date.toISOString();
            }
        } catch (e) {
            // Fallback to relative parsing
        }

        const now = new Date();

        if (timeStr.includes('just now') || timeStr.includes('now')) {
            return now.toISOString();
        }
        if (timeStr.includes('min')) {
            const mins = parseInt(timeStr.match(/\d+/)?.[0] || '0');
            now.setMinutes(now.getMinutes() - mins);
            return now.toISOString();
        }
        if (timeStr.includes('hour')) {
            const hours = parseInt(timeStr.match(/\d+/)?.[0] || '0');
            now.setHours(now.getHours() - hours);
            return now.toISOString();
        }

        return now.toISOString();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  POLLING ENGINE — Live poll with real-time status updates
    //  OPTIMIZED: 3s interval, better status reporting
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
                    session.status = 'TIMEOUT';

                    // Update failure stats
                    const stats = this.numberStats.get(session.number) || { success: 0, failure: 0, lastUsed: 0 };
                    stats.failure++;
                    this.numberStats.set(session.number, stats);

                    // Blacklist if too many failures
                    if (stats.failure >= 3 && stats.success === 0) {
                        this.blacklist.add(session.number);
                        logger.info('Number blacklisted', { number: this.maskPhone(session.number), failures: stats.failure });
                    }

                    const result = {
                        success: false,
                        status: 'TIMEOUT',
                        error: 'No SMS received within 90 seconds',
                        sessionId,
                        number: session.number,
                        polls,
                        duration: now - startTime
                    };

                    if (onStatusUpdate) await onStatusUpdate(result);
                    resolve(result);
                    return;
                }

                // Status update
                if (onStatusUpdate) {
                    await onStatusUpdate({
                        status: 'POLLING',
                        message: `Checking inbox... (poll ${polls}, ${Math.round((now - startTime) / 1000)}s)`,
                        polls,
                        elapsed: Math.round((now - startTime) / 1000)
                    });
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
                        polls
                    };

                    if (onStatusUpdate) await onStatusUpdate(successResult);
                    resolve(successResult);
                    return;
                }

                // Schedule next check (3s interval)
                setTimeout(check, this.POLL_CONFIG.interval);
            };

            check();
        });
    }

    async getSMS(sessionId) {
        return this.checkSMS(sessionId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  RETRY SYSTEM — One retry with new number on timeout
    // ═══════════════════════════════════════════════════════════════════════

    async retryWithNewNumber(sessionId, country = null, service = 'Any', userId = null) {
        const session = this.activeSessions.get(sessionId);
        if (!session) throw new Error('SESSION_NOT_FOUND');

        if (session.retryCount >= this.POLL_CONFIG.maxRetries) {
            return {
                success: false,
                status: 'MAX_RETRIES',
                error: 'Maximum retries reached'
            };
        }

        // Blacklist the failed number
        this.blacklist.add(session.number);

        // Release old session
        await this.releaseSession(sessionId);
        await this.delay(3000);

        // Try to get new number (will check credits again if userId provided)
        session.retryCount++;
        try {
            const newNum = await this.getNumber(country || session.country, service, userId);
            return {
                success: true,
                newSessionId: newNum.sessionId,
                newNumber: newNum.phoneNumber,
                retryCount: session.retryCount
            };
        } catch (error) {
            return {
                success: false,
                status: 'RETRY_FAILED',
                error: error.message,
                code: error.code || 'UNKNOWN'
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CANCEL / RELEASE
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

        logger.debug('Free session released', {
            sessionId,
            number: this.maskPhone(session.number)
        });

        return { success: true, status: 'RELEASED' };
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
                    }
                        // ═══════════════════════════════════════════════════════════════════════════════
// FreeProvider.js — Part 3/3: OTP Extraction, Ad System Proxy, Stats & Health
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  OTP EXTRACTION — Extract verification codes from real messages
    // ═══════════════════════════════════════════════════════════════════════

    extractOTP(text) {
        if (!text) return null;

        // Context-aware patterns (most specific first)
        const patterns = [
            /(?:code|otp|verification|confirm|auth)[\s:]*(\d{4,8})/i,
            /(?:is|：)[\s]*(\d{4,8})[\s]*(?:is your|是你的)/i,
            /(?:your|the)[\s]+(?:code|otp|pin)[\s]+(?:is|:)[\s]*(\d{4,8})/i,
            /验证码[为是：\s]*(\d{4,8})/,
            /код[:\s]+(\d{4,8})/i,
            /(\d{4,8})[\s]*(?:code|otp|pin|verification)/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const otp = match[1];
                if (/^\d{4,8}$/.test(otp)) {
                    return otp;
                }
            }
        }

        // Fallback: standalone 4-8 digit sequences, prefer longer
        const digits = text.match(/\b\d{4,8}\b/g);
        if (digits && digits.length > 0) {
            return digits.reduce((a, b) => a.length >= b.length ? a : b);
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AD SYSTEM PROXY METHODS (NEW)
    //  These expose AdCreditSystem to the bot layer without direct imports
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check if user can request a free number (credit check)
     * Bot layer calls this before showing "Get Free Number" button
     */
    async canRequestNumber(userId) {
        return this.adSystem.canRequestNumber(userId);
    }

    /**
     * Get user's current ad credits
     */
    async getCredits(userId) {
        return this.adSystem.getCredits(userId);
    }

    /**
     * Generate ad view for user
     */
    async generateAdView(userId, network = 'shorte_st') {
        return this.adSystem.generateAdView(userId, network);
    }

    /**
     * Handle ad completion webhook
     */
    async handleAdWebhook(verificationId, payload) {
        return this.adSystem.handleAdWebhook(verificationId, payload);
    }

    /**
     * Get available ad networks
     */
    getAvailableNetworks() {
        return this.adSystem.getAvailableNetworks();
    }

    /**
     * Deduct credits (used by bot layer after ad watch)
     */
    async deductCredits(userId) {
        return this.adSystem.deductCredits(userId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  STATS & HEALTH
    // ═══════════════════════════════════════════════════════════════════════

    getProviderHealth() {
        return SITE_CONFIGS.map(s => ({
            id: s.id,
            name: s.name,
            enabled: s.enabled,
            priority: s.priority
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
            elapsed: Math.floor((Date.now() - s.assignedAt) / 1000)
        }));
    }

    getStats() {
        const stats = {
            name: this.name,
            isActive: this.isActive,
            activeSessions: this.activeSessions.size,
            blacklistedNumbers: this.blacklist.size,
            cachedEntries: this.cache.size,
            sites: SITE_CONFIGS.length
        };

        stats.siteHealth = this.getProviderHealth();

        stats.numberStats = Array.from(this.numberStats.entries())
            .map(([num, data]) => ({
                number: this.maskPhone(num),
                success: data.success,
                failure: data.failure,
                rate: data.success + data.failure > 0
                    ? (data.success / (data.success + data.failure) * 100).toFixed(1) + '%'
                    : 'N/A'
            }))
            .sort((a, b) => parseFloat(b.rate) - parseFloat(a.rate));

        return stats;
    }

    getNumbersByCountry(countryCode) {
        const allNumbers = [];
        for (const [num, data] of this.numberStats) {
            if (this._detectCountry(num) === countryCode) {
                allNumbers.push({
                    number: num,
                    ...data,
                    blacklisted: this.blacklist.has(num)
                });
            }
        }
        return allNumbers;
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

export default FreeProvider;
    
