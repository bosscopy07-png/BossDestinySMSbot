import axios from 'axios';
import logger from '../../utils/logger.js';

/**
 * FreeProvider — FREE Tier SMS Inbox Orchestration Engine
 * 
 * CORE RULES (NON-NEGOTIABLE):
 * - NEVER generate, fake, or simulate OTP codes or messages
 * - ONLY display real SMS messages received from providers
 * - If no message received → return FAILURE state
 * - Do NOT assume delivery success without inbox confirmation
 * 
 * ARCHITECTURE:
 * - Dynamic provider pool with health scoring
 * - Real-time inbox polling (3-5 second intervals)
 * - Auto-rotation on failure
 * - Transparent status updates to users
 */
class FreeProvider {
    constructor() {
        this.name = 'FREE_PUBLIC';
        this.tier = 'FREE';
        this.isActive = true;

        // ═══════════════════════════════════════════════════════════
        //  PROVIDER POOL CONFIGURATION
        // ═══════════════════════════════════════════════════════════

        this.providers = [
            {
                id: 'receive_smss',
                name: 'receive-smss.com',
                enabled: true,
                baseUrl: 'https://receive-smss.com',
                healthScore: 100,
                successCount: 0,
                failureCount: 0,
                totalAttempts: 0,
                avgDeliveryTime: 0,
                lastFailure: null,
                consecutiveFailures: 0,
                blacklistUntil: 0,
                numberEndpoint: (country) => `/api/numbers/${country.toLowerCase()}`,
                inboxEndpoint: (number) => `/api/inbox/${number.replace('+', '')}`,
                // Fallback: scrape HTML if API fails
                scrapeFallback: true
            },
            {
                id: 'temp_number',
                name: 'temp-number.org',
                enabled: true,
                baseUrl: 'https://temp-number.org',
                healthScore: 100,
                successCount: 0,
                failureCount: 0,
                totalAttempts: 0,
                avgDeliveryTime: 0,
                lastFailure: null,
                consecutiveFailures: 0,
                blacklistUntil: 0,
                numberEndpoint: (country) => `/api/numbers/${country.toLowerCase()}`,
                inboxEndpoint: (number) => `/api/inbox/${number.replace('+', '')}`,
                scrapeFallback: true
            },
            {
                id: 'smstome',
                name: 'smstome.com',
                enabled: true,
                baseUrl: 'https://smstome.com',
                healthScore: 100,
                successCount: 0,
                failureCount: 0,
                totalAttempts: 0,
                avgDeliveryTime: 0,
                lastFailure: null,
                consecutiveFailures: 0,
                blacklistUntil: 0,
                numberEndpoint: (country) => `/api/country/${country.toUpperCase()}`,
                inboxEndpoint: (number) => `/api/phone/${number.replace('+', '')}`,
                scrapeFallback: true
            },
            {
                id: 'online_sms',
                name: 'online-sms.org',
                enabled: true,
                baseUrl: 'https://online-sms.org',
                healthScore: 100,
                successCount: 0,
                failureCount: 0,
                totalAttempts: 0,
                avgDeliveryTime: 0,
                lastFailure: null,
                consecutiveFailures: 0,
                blacklistUntil: 0,
                numberEndpoint: (country) => `/api/numbers/${country.toLowerCase()}`,
                inboxEndpoint: (number) => `/api/inbox/${number.replace('+', '')}`,
                scrapeFallback: true
            }
        ];

        // ═══════════════════════════════════════════════════════════
        //  ACTIVE SESSIONS TRACKING
        // ═══════════════════════════════════════════════════════════

        // sessionId -> { number, providerId, assignedAt, service, country, status, messages: [] }
        this.activeSessions = new Map();

        // number -> { providerId, assignedAt, sessionId, lastUsed }
        this.assignedNumbers = new Map();

        // ═══════════════════════════════════════════════════════════
        //  HEALTH SCORING CONSTANTS
        // ═══════════════════════════════════════════════════════════

        this.SCORE_CONFIG = {
            successBonus: 15,
            fastDeliveryBonus: 10,      // Under 30 seconds
            failurePenalty: 25,
            timeoutPenalty: 15,
            consecutiveFailureDecay: 0.6,  // Exponential decay
            blacklistThreshold: 3,     // Consecutive failures before blacklist
            blacklistDuration: 300000, // 5 minutes in ms
            recoveryRate: 5,           // Points recovered per successful check
            minScore: 10,
            maxScore: 100
        };

        // ═══════════════════════════════════════════════════════════
        //  POLLING CONFIGURATION
        // ═══════════════════════════════════════════════════════════

        this.POLL_CONFIG = {
            interval: 4000,           // 4 seconds between polls
            timeout: 90000,           // 90 seconds total timeout
            maxRetries: 2,            // Max retry attempts per session
            retryDelay: 3000          // 3 seconds before retry
        };

        // ═══════════════════════════════════════════════════════════
        //  CLEANUP
        // ═══════════════════════════════════════════════════════════

        this.cleanupInterval = null;
        this.startCleanupJob();

        logger.info('FreeProvider initialized — FREE Tier SMS Inbox Orchestration Engine', {
            providerCount: this.providers.length,
            pollInterval: this.POLL_CONFIG.interval,
            timeout: this.POLL_CONFIG.timeout,
            maxRetries: this.POLL_CONFIG.maxRetries
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  CLEANUP & LIFECYCLE
    // ═══════════════════════════════════════════════════════════

    startCleanupJob() {
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        
        // Clean stale sessions every 5 minutes
        this.cleanupInterval = setInterval(() => this.cleanupStaleSessions(), 300000);

        const cleanup = () => this.stopCleanupJob();
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
        process.once('exit', cleanup);
    }

    stopCleanupJob() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
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

        if (cleaned > 0) {
            logger.info('Cleaned stale free sessions', { cleaned });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  PROVIDER HEALTH SCORING
    // ═══════════════════════════════════════════════════════════

    /**
     * Calculate provider health score based on performance metrics
     */
    calculateScore(provider) {
        let score = provider.healthScore;

        // Apply consecutive failure decay
        if (provider.consecutiveFailures > 0) {
            score *= Math.pow(this.SCORE_CONFIG.consecutiveFailureDecay, provider.consecutiveFailures);
        }

        // Apply recency bias — recent failures hurt more
        if (provider.lastFailure) {
            const minutesSinceFailure = (Date.now() - provider.lastFailure) / 60000;
            if (minutesSinceFailure < 5) {
                score *= 0.5; // Heavy penalty for very recent failures
            } else if (minutesSinceFailure < 30) {
                score *= 0.8;
            }
        }

        // Success rate bonus/penalty
        if (provider.totalAttempts > 5) {
            const successRate = provider.successCount / provider.totalAttempts;
            if (successRate > 0.8) score += 10;
            if (successRate < 0.3) score -= 20;
        }

        return Math.max(this.SCORE_CONFIG.minScore, Math.min(this.SCORE_CONFIG.maxScore, Math.round(score)));
    }

    /**
     * Update provider score after attempt
     */
    updateProviderScore(providerId, success, deliveryTime = null) {
        const provider = this.providers.find(p => p.id === providerId);
        if (!provider) return;

        provider.totalAttempts++;
        
        if (success) {
            provider.successCount++;
            provider.consecutiveFailures = 0;
            provider.healthScore = Math.min(
                this.SCORE_CONFIG.maxScore,
                provider.healthScore + this.SCORE_CONFIG.successBonus
            );
            
            if (deliveryTime && deliveryTime < 30000) {
                provider.healthScore = Math.min(
                    this.SCORE_CONFIG.maxScore,
                    provider.healthScore + this.SCORE_CONFIG.fastDeliveryBonus
                );
            }
            
            // Update average delivery time
            if (deliveryTime) {
                provider.avgDeliveryTime = (
                    (provider.avgDeliveryTime * (provider.successCount - 1) + deliveryTime)
                    / provider.successCount
                );
            }
            
            logger.info(`Provider ${provider.name} succeeded`, {
                score: this.calculateScore(provider),
                deliveryTime,
                successRate: (provider.successCount / provider.totalAttempts).toFixed(2)
            });

        } else {
            provider.failureCount++;
            provider.consecutiveFailures++;
            provider.lastFailure = Date.now();
            provider.healthScore = Math.max(
                this.SCORE_CONFIG.minScore,
                provider.healthScore - this.SCORE_CONFIG.failurePenalty
            );

            // Blacklist if too many consecutive failures
            if (provider.consecutiveFailures >= this.SCORE_CONFIG.blacklistThreshold) {
                provider.blacklistUntil = Date.now() + this.SCORE_CONFIG.blacklistDuration;
                logger.warn(`Provider ${provider.name} BLACKLISTED`, {
                    until: new Date(provider.blacklistUntil).toISOString(),
                    consecutiveFailures: provider.consecutiveFailures
                });
            }

            logger.warn(`Provider ${provider.name} failed`, {
                score: this.calculateScore(provider),
                consecutiveFailures: provider.consecutiveFailures,
                blacklisted: provider.blacklistUntil > Date.now()
            });
        }
    }

    /**
     * Get ranked list of available providers
     */
    getRankedProviders() {
        const now = Date.now();
        
        return this.providers
            .filter(p => {
                if (!p.enabled) return false;
                if (p.blacklistUntil > now) return false;
                return true;
            })
            .map(p => ({
                ...p,
                effectiveScore: this.calculateScore(p)
            }))
            .sort((a, b) => b.effectiveScore - a.effectiveScore);
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION
    // ═══════════════════════════════════════════════════════════

    /**
     * Get best available free number from highest-scoring provider
     */
    async getNumber(country = 'US', service = 'Any') {
        const startTime = Date.now();
        const sessionId = `free_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        try {
            const rankedProviders = this.getRankedProviders();
            
            if (rankedProviders.length === 0) {
                throw new Error(
                    'NO_PROVIDERS_AVAILABLE: All free providers are blacklisted or disabled. ' +
                    'Wait 5 minutes for recovery or use a paid provider.'
                );
            }

            logger.info('Requesting free number', {
                country,
                service,
                availableProviders: rankedProviders.length,
                topProvider: rankedProviders[0]?.name,
                topScore: rankedProviders[0]?.effectiveScore
            });

            // Try providers in score order
            for (const provider of rankedProviders) {
                try {
                    const number = await this.fetchNumberFromProvider(provider, country);
                    
                    if (number) {
                        // Check if number is already assigned
                        if (this.assignedNumbers.has(number)) {
                            logger.debug('Number already assigned, skipping', { number: this.maskPhone(number) });
                            continue;
                        }

                        // Create session
                        this.activeSessions.set(sessionId, {
                            number,
                            providerId: provider.id,
                            assignedAt: Date.now(),
                            service,
                            country,
                            status: 'ACTIVE',
                            messages: [],
                            retryCount: 0
                        });

                        this.assignedNumbers.set(number, {
                            providerId: provider.id,
                            assignedAt: Date.now(),
                            sessionId,
                            lastUsed: Date.now()
                        });

                        const duration = Date.now() - startTime;
                        
                        logger.info('Free number assigned', {
                            sessionId,
                            provider: provider.name,
                            number: this.maskPhone(number),
                            score: provider.effectiveScore,
                            duration
                        });

                        return {
                            phoneNumber: number,
                            provider: this.name,
                            providerNumberId: sessionId,
                            country: country.toUpperCase(),
                            service,
                            cost: 0,
                            isPublic: true,
                            source: provider.name,
                            sessionId,
                            warning: 'FREE TIER: Number is public/shared. SMS visibility not guaranteed.'
                        };
                    }
                } catch (error) {
                    logger.warn(`Provider ${provider.name} number fetch failed`, {
                        error: error.message,
                        score: provider.effectiveScore
                    });
                    this.updateProviderScore(provider.id, false);
                    continue;
                }
            }

            throw new Error(
                `NO_NUMBERS_AVAILABLE: No free numbers found in ${country} after trying ${rankedProviders.length} providers. ` +
                `All providers may be rate-limited or out of numbers.`
            );

        } catch (error) {
            logger.error('Free number acquisition failed', { country, service, error: error.message });
            throw error;
        }
    }

    /**
     * Fetch a number from a specific provider
     */
    async fetchNumberFromProvider(provider, country) {
        const url = `${provider.baseUrl}${provider.numberEndpoint(country)}`;
        
        try {
            // Try API endpoint first
            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                },
                validateStatus: () => true
            });

            if (response.status === 200 && response.data) {
                // Try JSON API response
                if (Array.isArray(response.data)) {
                    const available = response.data.filter(n => 
                        n.number && !this.assignedNumbers.has(n.number)
                    );
                    if (available.length > 0) {
                        return available[0].number;
                    }
                }
                
                if (response.data.numbers && Array.isArray(response.data.numbers)) {
                    const available = response.data.numbers.filter(n => 
                        n && !this.assignedNumbers.has(n)
                    );
                    if (available.length > 0) {
                        return available[0];
                    }
                }
            }

            // API failed or returned no numbers — try scraping if enabled
            if (provider.scrapeFallback) {
                return await this.scrapeNumberFromProvider(provider, country);
            }

            return null;

        } catch (error) {
            logger.debug(`Provider ${provider.name} API fetch failed`, { error: error.message });
            
            if (provider.scrapeFallback) {
                return await this.scrapeNumberFromProvider(provider, country);
            }
            
            return null;
        }
    }

    /**
     * Scrape number from provider HTML page
     */
    async scrapeNumberFromProvider(provider, country) {
        const url = `${provider.baseUrl}/${country.toLowerCase()}`;
        
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                validateStatus: () => true
            });

            if (response.status !== 200) return null;

            const html = response.data;
            
            // Extract phone numbers from HTML using regex
            // Matches international formats: +1234567890, +1 234 567 890, etc.
            const phoneRegex = /\+?\d[\d\s()-]{7,20}\d/g;
            const matches = html.match(phoneRegex) || [];
            
            const numbers = matches
                .map(m => m.replace(/[\s()-]/g, ''))
                .filter((n, i, arr) => arr.indexOf(n) === i) // dedupe
                .filter(n => n.length >= 10 && n.length <= 15)
                .filter(n => !this.assignedNumbers.has(n));

            if (numbers.length > 0) {
                logger.info(`Scraped number from ${provider.name}`, {
                    number: this.maskPhone(numbers[0]),
                    country
                });
                return numbers[0];
            }

            return null;

        } catch (error) {
            logger.debug(`Provider ${provider.name} scrape failed`, { error: error.message });
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SMS POLLING & INBOX CHECKING
    // ═══════════════════════════════════════════════════════════

    /**
     * Start polling loop for SMS on a session
     * Returns Promise that resolves when SMS found or timeout
     */
    async pollForSMS(sessionId, onStatusUpdate = null) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            throw new Error('SESSION_NOT_FOUND: Invalid or expired session');
        }

        const provider = this.providers.find(p => p.id === session.providerId);
        if (!provider) {
            throw ne
