import TwilioProvider from './TwilioProvider.js';
import TelnyxProvider from './TelnyxProvider.js';
import CheapPanelProvider from './CheapPanelProvider.js';
import FreeProvider from './FreeProvider.js';
import NumberPoolManager from './NumberPoolManager.js';
import NumberBuyer from './buy-numbers.js';
import logger from '../../utils/logger.js';

/**
 * SMSProviderManager — Unified gateway for SMS number acquisition across all providers
 * 
 * ARCHITECTURE:
 *   VIP/BUNDLE  → NumberPool (Twilio + Telnyx) with preferred provider + failover
 *   CHEAP       → CheapPanelProvider (5SIM rented numbers) with balance check
 *   FREE        → FreeProvider (public/shared numbers) with health scoring + polling
 * 
 * FIXED:
 * - BASE_URL validation at startup
 * - Smart provider failover: Telnyx → Twilio → 5SIM → Free
 * - 5SIM balance check before API calls
 * - FreeProvider integration with pollForSMS + retry logic
 * - No undefined webhook URLs
 * - Graceful degradation when providers fail
 * - Inventory handling with country fallback list
 */
class SMSProviderManager {
    constructor() {
        this.providers = new Map();
        this.numberPool = null;
        this.numberBuyer = null;
        this.isInitialized = false;

        // FIXED: Validate BASE_URL before anything else
        this.validateBaseUrl();

        this.initializeProviders();
    }

    // ═══════════════════════════════════════════════════════════
    //  STARTUP VALIDATION
    // ═══════════════════════════════════════════════════════════

    /**
     * FIXED: Validate BASE_URL at startup. Throw if missing.
     */
    validateBaseUrl() {
        const baseUrl = process.env.BASE_URL;
        
        if (!baseUrl) {
            logger.error('FATAL: BASE_URL environment variable is not configured');
            logger.error('Set BASE_URL=https://yourdomain.com before starting the bot');
            throw new Error('BASE_URL is not configured');
        }

        // Validate URL format
        try {
            new URL(baseUrl);
        } catch (e) {
            throw new Error(`BASE_URL is invalid: ${baseUrl}. Must be a valid URL like https://example.com`);
        }

        this.baseUrl = baseUrl.replace(/\/$/, '');
        logger.info('BASE_URL validated', { baseUrl: this.baseUrl });
    }

    // ═══════════════════════════════════════════════════════════
    //  PROVIDER SETUP
    // ═══════════════════════════════════════════════════════════

    initializeProviders() {
        const twilio = new TwilioProvider();
        const telnyx = new TelnyxProvider();
        const cheapPanel = new CheapPanelProvider();
        const freePublic = new FreeProvider();

        this.providers.set('TWILIO', twilio);
        this.providers.set('TELNYX', telnyx);
        this.providers.set('CHEAP_PANEL', cheapPanel);
        this.providers.set('FREE_PUBLIC', freePublic);

        // NumberPool gets ALL active infrastructure providers
        const poolProviders = [];
        if (twilio.isActive) poolProviders.push(twilio);
        if (telnyx.isActive) poolProviders.push(telnyx);

        if (poolProviders.length > 0) {
            this.numberPool = new NumberPoolManager(...poolProviders);
            this.numberBuyer = new NumberBuyer();
        }

        logger.info('SMS Provider Manager initialized', {
            providers: Array.from(this.providers.keys()),
            poolProviders: poolProviders.map(p => p.name),
            hasPool: !!this.numberPool,
            baseUrl: this.baseUrl
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═══════════════════════════════════════════════════════════

    async initialize() {
        if (this.isInitialized) return;

        // Initialize number pool first (connects DB, loads available numbers)
        if (this.numberPool) {
            await this.numberPool.initialize();
        }

        // Initialize number buyer (shares the pool)
        if (this.numberBuyer) {
            await this.numberBuyer.init({
                twilio: this.providers.get('TWILIO'),
                telnyx: this.providers.get('TELNYX')
            });
        }

        // Initialize optional providers
        for (const [name, provider] of this.providers) {
            if (provider.initialize && typeof provider.initialize === 'function') {
                try {
                    await provider.initialize();
                } catch (e) {
                    logger.warn(`Provider ${name} initialize failed`, { error: e.message });
                    provider.isActive = false;
                }
            }
        }

        this.isInitialized = true;
        logger.info('SMS Provider Manager fully initialized');
    }

    // ═══════════════════════════════════════════════════════════
    //  SMART FAILOVER — NUMBER ACQUISITION
    // ═══════════════════════════════════════════════════════════

    /**
     * Get a number with intelligent provider failover.
     * 
     * FAILOVER ORDER:
     *   1. VIP/BUNDLE → NumberPool (Twilio/Telnyx owned numbers)
     *   2. CHEAP → 5SIM (with balance check)
     *   3. FREE → FreeProvider (public numbers with health scoring)
     * 
     * @param {string} tier — 'VIP' | 'BUNDLE' | 'CHEAP' | 'FREE'
     * @param {string} country — ISO country code
     * @param {string} service — Service name (e.g., 'WhatsApp', 'Telegram')
     * @param {string} preferredProvider — 'TWILIO' | 'TELNYX' | null
     * @param {string} userId — Optional user identifier
     */
    async getNumber(tier, country, service, preferredProvider = null, userId = null) {
        if (!this.isInitialized) await this.initialize();

        // Validate inputs
        if (!country || typeof country !== 'string' || country.length !== 2) {
            throw new Error(`INVALID_COUNTRY: Country must be 2-letter ISO code. Got: ${country}`);
        }

        // FIXED: VIP/BUNDLE tier — use number pool with failover
        if ((tier === 'VIP' || tier === 'BUNDLE') && this.numberPool) {
            try {
                const result = await this.numberPool.acquireNumber(
                    country,
                    service,
                    userId,
                    preferredProvider
                );
                
                if (result) {
                    return {
                        ...result,
                        tier,
                        acquisitionMethod: 'POOL'
                    };
                }
            } catch (poolError) {
                logger.warn('Pool acquisition failed, trying fallback providers', {
                    error: poolError.message,
                    country,
                    tier
                });
                // Fall through to provider failover
            }
        }

        // FIXED: FREE tier — use FreeProvider with polling support
        if (tier === 'FREE') {
            const provider = this.providers.get('FREE_PUBLIC');
            if (!provider?.isActive) {
                throw new Error('FREE_PROVIDER_UNAVAILABLE: Free provider not active');
            }
            
            const result = await provider.getNumber(country, service);
            return {
                ...result,
                tier,
                acquisitionMethod: 'FREE'
            };
        }

        // FIXED: CHEAP tier or pool fallback — use smart provider failover
        // Order: preferred → Telnyx → Twilio → 5SIM → Free
        return this.acquireWithFailover(tier, country, service, preferredProvider);
    }

    /**
     * FIXED: Smart provider failover with retry limits.
     * Never retries same failing provider more than 2 times.
     */
    async acquireWithFailover(tier, country, service, preferredProvider = null) {
        const attemptLog = [];
        const maxRetriesPerProvider = 2;
        const providerAttempts = new Map();

        // Build provider order: preferred first, then Telnyx, Twilio, 5SIM, Free
        const providerOrder = this.buildProviderOrder(preferredProvider);
        
        // Country fallback list
        const countryFallbacks = this.getCountryFallbacks(country);

        logger.info('Starting provider failover acquisition', {
            tier,
            country,
            service,
            preferredProvider,
            providerOrder: providerOrder.map(p => p.name),
            countryFallbacks
        });

        // Try each provider
        for (const provider of providerOrder) {
            const providerName = provider.name;
            const attempts = providerAttempts.get(providerName) || 0;

            if (attempts >= maxRetriesPerProvider) {
                logger.debug(`Skipping ${providerName} — max retries reached`);
                continue;
            }

            if (!provider.isActive) {
                logger.debug(`Skipping ${providerName} — inactive`);
                continue;
            }

            // Try primary country first, then fallbacks
            for (const tryCountry of countryFallbacks) {
                try {
                    providerAttempts.set(providerName, attempts + 1);

                    logger.info(`Attempting ${providerName} in ${tryCountry}`, {
                        attempt: attempts + 1,
                        maxRetries: maxRetriesPerProvider
                    });

                    let result;

                    // Handle different provider interfaces
                    if (providerName === 'FREE_PUBLIC') {
                        result = await provider.getNumber(tryCountry, service);
                    } else if (providerName === 'CHEAP_PANEL') {
                        // 5SIM requires balance check — handled internally
                        result = await provider.getNumber(tryCountry, service);
                    } else {
                        // Twilio/Telnyx
                        result = await provider.getNumber(tryCountry);
                    }

                    if (result) {
                        logger.info(`Success with ${providerName}`, {
                            country: tryCountry,
                            phone: this.maskPhone(result.phoneNumber)
                        });

                        return {
                            ...result,
                            tier,
                            acquisitionMethod: providerName,
                            countryUsed: tryCountry,
                            failoverAttempts: attemptLog.length
                        };
                    }

                } catch (error) {
                    const errorMsg = error.message || '';
                    
                    attemptLog.push({
                        provider: providerName,
                        country: tryCountry,
                        error: errorMsg,
                        timestamp: new Date().toISOString()
                    });

                    // FIXED: Parse error type for smart skipping
                    const isNoNumbers = errorMsg.includes('NO_NUMBERS') || 
                                       errorMsg.includes('NOT_AVAILABLE') ||
                                       errorMsg.includes('No available numbers');
                    
                    const isNoBalance = errorMsg.includes('NO_BALANCE') || 
                                       errorMsg.includes('not enough user balance');
                    
                    const isRateLimit = errorMsg.includes('RATE_LIMIT') || 
                                       errorMsg.includes('429') ||
                                       errorMsg.includes('Too Many Requests');
                    
                    const isConfigError = errorMsg.includes('NOT_CONFIGURED') || 
                                         errorMsg.includes('INVALID_COUNTRY');

                    logger.warn(`${providerName} failed`, {
                        country: tryCountry,
                        error: errorMsg,
                        errorType: isNoNumbers ? 'NO_NUMBERS' : 
                                  isNoBalance ? 'NO_BALANCE' : 
                                  isRateLimit ? 'RATE_LIMIT' : 
                                  isConfigError ? 'CONFIG' : 'UNKNOWN'
                    });

                    // FIXED: Skip logic based on error type
                    if (isNoBalance) {
                        logger.error(`Skipping ${providerName} — insufficient balance`);
                        provider.isActive = false; // Disable until funded
                        break; // Don't try other countries for this provider
                    }

                    if (isConfigError) {
                        logger.error(`Skipping ${providerName} — configuration error`);
                        provider.isActive = false;
                        break;
                    }

                    if (isRateLimit) {
                        logger.warn(`${providerName} rate limited — will retry later`);
                        // Continue to next country/provider
                    }

                    // If NO_NUMBERS, try next country in fallback list
                    if (!isNoNumbers) {
                        // For other errors, don't retry same provider
                        break;
                    }
                }
            }
        }

        // All providers exhausted
        const errorDetails = attemptLog.map(a => `${a.provider}(${a.country}): ${a.error}`).join(' | ');
        
        throw new Error(
            `ALL_PROVIDERS_FAILED: No number available after trying ${attemptLog.length} attempts. ` +
            `Details: ${errorDetails}`
        );
    }

    /**
     * Build provider priority order based on preference and health
     */
    buildProviderOrder(preferredProvider) {
        const order = [];
        const added = new Set();

        // Preferred provider first
        if (preferredProvider && this.providers.has(preferredProvider)) {
            order.push(this.providers.get(preferredProvider));
            added.add(preferredProvider);
        }

        // Default order: Telnyx → Twilio → 5SIM → Free
        const defaultOrder = ['TELNYX', 'TWILIO', 'CHEAP_PANEL', 'FREE_PUBLIC'];
        
        for (const name of defaultOrder) {
            if (!added.has(name) && this.providers.has(name)) {
                order.push(this.providers.get(name));
                added.add(name);
            }
        }

        return order.filter(p => p && p.isActive);
    }

    /**
     * Get country fallback list for inventory handling
     */
    getCountryFallbacks(primaryCountry) {
        const primary = primaryCountry.toUpperCase();
        
        // If primary is available, try it first
        const fallbacks = [primary];

        // Regional fallbacks
        const regionMap = {
            'US': ['CA', 'GB', 'AU'],
            'GB': ['US', 'CA', 'AU'],
            'CA': ['US', 'GB', 'AU'],
            'AU': ['US', 'GB', 'CA'],
            'DE': ['FR', 'NL', 'AT'],
            'FR': ['DE', 'ES', 'IT'],
            'NG': ['ZA', 'KE', 'GH'],
            'IN': ['PK', 'BD', 'LK'],
            'BR': ['MX', 'AR', 'CL'],
            'MX': ['US', 'BR', 'CO']
        };

        const regionFallbacks = regionMap[primary] || ['US', 'GB', 'CA'];
        
        for (const fb of regionFallbacks) {
            if (!fallbacks.includes(fb)) {
                fallbacks.push(fb);
            }
        }

        // Global fallback
        if (!fallbacks.includes('US')) {
            fallbacks.push('US');
        }

        return fallbacks;
    }

    // ═══════════════════════════════════════════════════════════
    //  SMS CHECKING (FIXED — supports FreeProvider polling)
    // ═══════════════════════════════════════════════════════════

    /**
     * Check SMS for a number.
     * 
     * For FREE tier: Uses pollForSMS with live status updates
     * For PAID tier: Returns webhook status
     */
    async checkSMS(providerName, identifier, options = {}) {
        if (!this.isInitialized) await this.initialize();

        // FREE tier: Use polling engine
        if (providerName === 'FREE_PUBLIC') {
            const provider = this.providers.get('FREE_PUBLIC');
            if (!provider) {
                throw new Error('FREE_PROVIDER_NOT_FOUND');
            }

            // If identifier is a sessionId, use pollForSMS
            if (identifier.startsWith('free_')) {
                return provider.pollForSMS(identifier, options.onStatusUpdate);
            }

            // Otherwise use standard checkSMS
            return provider.checkSMS(identifier);
        }

        // Pool/VIP numbers use webhooks
        if (providerName === 'TWILIO' || providerName === 'TELNYX' || providerName === 'NUMBER_POOL') {
            return {
                success: false,
                status: 'WAITING',
                message: 'Check via webhook or provider API',
                provider: providerName
            };
        }

        // 5SIM/CheapPanel
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`PROVIDER_NOT_FOUND: ${providerName}`);
        }

        if (!provider.checkSMS) {
            return {
                success: false,
                status: 'UNSUPPORTED',
                message: `Provider ${providerName} does not support SMS checking`
            };
        }

        return provider.checkSMS(identifier);
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER RELEASE / CANCELLATION
    // ═══════════════════════════════════════════════════════════

    async cancelNumber(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        // Pool numbers
        if (providerName === 'NUMBER_POOL' || providerName === 'TWILIO' || providerName === 'TELNYX') {
            if (!this.numberPool) {
                return { success: false, error: 'POOL_NOT_INITIALIZED' };
            }
            return this.numberPool.releaseNumber(identifier, 'USER_CANCELLED');
        }

        // FreeProvider sessions
        if (providerName === 'FREE_PUBLIC') {
            const provider = this.providers.get('FREE_PUBLIC');
            if (provider?.cancelNumber) {
                return provider.cancelNumber(identifier);
            }
            return { success: true, status: 'RELEASED' };
        }

        const provider = this.providers.get(providerName);
        if (!provider) {
            return { success: false, error: `PROVIDER_NOT_FOUND: ${providerName}` };
        }

        if (provider.cancelNumber && typeof provider.cancelNumber === 'function') {
            return provider.cancelNumber(identifier);
        }

        return { success: true, note: 'Nothing to cancel for this provider' };
    }

    async finishNumber(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        // Pool numbers
        if (providerName === 'NUMBER_POOL' || providerName === 'TWILIO' || providerName === 'TELNYX') {
            if (!this.numberPool) {
                return { success: false, error: 'POOL_NOT_INITIALIZED' };
            }
            return this.numberPool.releaseNumber(identifier, 'SESSION_END');
        }

        // FreeProvider
        if (providerName === 'FREE_PUBLIC') {
            const provider = this.providers.get('FREE_PUBLIC');
            if (provider?.finishNumber) {
                return provider.finishNumber(identifier);
            }
            return { success: true, status: 'FINISHED' };
        }

        const provider = this.providers.get(providerName);
        if (provider?.finishNumber && typeof provider.finishNumber === 'function') {
            return provider.finishNumber(identifier);
        }

        return { success: true, note: 'No finish action required' };
    }

    // ══════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    //  FREE TIER HELPERS
    // ═══════════════════════════════════════════════════════════

    /**
     * Start SMS polling for a free tier session.
     * Returns Promise that resolves when SMS received or timeout.
     */
    async pollFreeSMS(sessionId, onStatusUpdate = null) {
        const provider = this.providers.get('FREE_PUBLIC');
        if (!provider) {
            throw new Error('FREE_PROVIDER_NOT_AVAILABLE');
        }

        return provider.pollForSMS(sessionId, onStatusUpdate);
    }

    /**
     * Retry free tier with new number.
     */
    async retryFreeNumber(sessionId, country = 'US', service = 'Any') {
        const provider = this.providers.get('FREE_PUBLIC');
        if (!provider) {
            throw new Error('FREE_PROVIDER_NOT_AVAILABLE');
        }

        return provider.retryWithNewNumber(sessionId, country, service);
    }

    /**
     * Get free provider health status.
     */
    getFreeProviderHealth() {
        const provider = this.providers.get('FREE_PUBLIC');
        if (!provider) {
            return { available: false };
        }

        return {
            available: true,
            providers: provider.getProviderHealth(),
            activeSessions: provider.getActiveSessions()
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  POOL MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    async buyPoolNumbers(country = 'US', quantity = 1, preferredProvider = null) {
        if (!this.numberPool || !this.numberBuyer) {
            throw new Error('POOL_NOT_AVAILABLE: Number pool not configured');
        }

        if (!this.isInitialized) await this.initialize();

        const result = await this.numberBuyer.buyMultiple(
            [{ country, count: quantity, preferredProvider }],
            { abortOnError: false }
        );

        if (result.totalSuccess > 0) {
            await this.numberPool.initialize();
        }

        return {
            success: result.totalFailed === 0,
            purchased: result.results[0]?.numbers || [],
            failed: result.totalFailed,
            totalCost: result.totalCost,
            errors: result.results[0]?.errors || []
        };
    }

    async buyPoolNumbersBulk(configs) {
        if (!this.numberPool || !this.numberBuyer) {
            throw new Error('POOL_NOT_AVAILABLE: Number pool not configured');
        }

        if (!this.isInitialized) await this.initialize();

        const result = await this.numberBuyer.buyMultiple(configs, { abortOnError: false });

        if (result.totalSuccess > 0) {
            await this.numberPool.initialize();
        }

        return result;
    }

    // ═══════════════════════════════════════════════════════════
    //  STATS & MONITORING
    // ═══════════════════════════════════════════════════════════

    async getPoolStats() {
        if (!this.numberPool) {
            return { available: false, reason: 'POOL_NOT_CONFIGURED' };
        }

        return {
            available: true,
            pools: this.numberPool.getPoolStats(),
            detailed: this.numberPool.getDetailedStats?.() || null
        };
    }

    getAllStats() {
        const stats = {};
        for (const [name, provider] of this.providers) {
            stats[name] = provider.getStats ? provider.getStats() : { isActive: provider.isActive };
        }
        if (this.numberPool) {
            stats['POOL'] = this.numberPool.getPoolStats();
            stats['POOL_DETAILED'] = this.numberPool.getDetailedStats?.();
        }
        return stats;
    }

    getActiveProviders() {
        return Array.from(this.providers.entries())
            .filter(([_, provider]) => provider.isActive)
            .map(([name, _]) => name);
    }

    getProvider(name) {
        return this.providers.get(name);
    }

    // ═══════════════════════════════════════════════════════════
    //  TELEGRAM MESSAGE SAFETY (FIXED — escape user input)
    // ═══════════════════════════════════════════════════════════

    /**
     * FIXED: Escape Telegram message entities to prevent "Can't find end of the entity" errors.
     * Use this before sending any user-generated content to Telegram.
     */
    escapeTelegramMessage(text) {
        if (!text) return '';
        
        // Escape special characters that break Telegram HTML/Markdown parsing
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\*/g, '\\*')
            .replace(/_/g, '\\_')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/`/g, '\\`');
    }

    /**
     * Format status message for Telegram with proper escaping.
     */
    formatTelegramStatus(status) {
        const escaped = this.escapeTelegramMessage(status.message || status.error || 'Unknown status');
        
        if (status.success) {
            return `✅ *SMS Received*\n\n📱 Number: \`${this.maskPhone(status.number || 'unknown')}\`\n💬 Message: ${escaped}\n🔢 OTP: \`${status.otp || 'N/A'}\`\n⏱️ Delivery: ${status.deliveryTime}ms`;
        }
        
        if (status.status === 'TIMEOUT') {
            return `❌ *No SMS Received*\n\n📱 Number: \`${this.maskPhone(status.number || 'unknown')}\`\n⏱️ Waited: 90 seconds\n📝 Reason: ${escaped}\n\n💡 Try retrying with a new number.`;
        }
        
        if (status.status === 'POLLING') {
            return `⏳ *Waiting for SMS...*\n\n🔍 ${escaped}`;
        }
        
        return `⚠️ *Status Update*\n\n${escaped}`;
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }

    // ═══════════════════════════════════════════════════════════
    //  SHUTDOWN
    // ═══════════════════════════════════════════════════════════

    async shutdown() {
        if (this.numberBuyer) {
            try {
                await this.numberBuyer.shutdown();
            } catch (e) {
                logger.warn('NumberBuyer shutdown failed', { error: e.message });
            }
        }

        if (this.numberPool) {
            try {
                await this.numberPool.uninitialize();
            } catch (e) {
                logger.warn('Pool uninitialize failed', { error: e.message });
            }
        }

        for (const [name, provider] of this.providers) {
            if (provider.stopCleanupJob && typeof provider.stopCleanupJob === 'function') {
                try {
                    provider.stopCleanupJob();
                } catch (e) {
                    logger.warn(`Provider ${name} cleanup failed`, { error: e.message });
                }
            }
        }

        this.isInitialized = false;
        logger.info('SMS Provider Manager shut down');
    }
}

export default SMSProviderManager;
