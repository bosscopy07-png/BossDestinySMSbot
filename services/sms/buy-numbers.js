import NumberPoolManager from './NumberPoolManager.js';
import TwilioProvider from './TwilioProvider.js';
import TelnyxProvider from './TelnyxProvider.js';
import connectDatabase from '../../config/database.js';
import logger from '../../utils/logger.js';

/**
 * NumberBuyer — Single or bulk number purchases across multiple providers & countries
 * 
 * Usage:
 *   const buyer = new NumberBuyer();
 *   await buyer.init();
 *   
 *   // Single purchase
 *   const one = await buyer.buy('US', { preferredProvider: 'TELNYX' });
 *   
 *   // Multiple countries
 *   const many = await buyer.buyMultiple([
 *     { country: 'US', count: 5, preferredProvider: 'TWILIO' },
 *     { country: 'GB', count: 3, preferredProvider: 'TELNYX' }
 *   ]);
 *   
 *   await buyer.shutdown();
 */
class NumberBuyer {
    constructor(options = {}) {
        this.pool = null;
        this.isInitialized = false;
        this.abortController = null;
        this.defaultDelayMs = options.delayMs || 1000;
        this.defaultPauseMs = options.pauseMs || 2000;
        this.maxBackoffMs = options.maxBackoffMs || 60000;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    /**
     * Initialize with provider configuration.
     * @param {Object} providers — { twilio: TwilioProvider, telnyx: TelnyxProvider }
     */
    async init(providers = {}) {
        if (this.isInitialized) return;

        const twilio = providers.twilio || new TwilioProvider();
        const telnyx = providers.telnyx || new TelnyxProvider();

        this.pool = new NumberPoolManager(twilio, telnyx);

        await connectDatabase();
        await this.pool.initialize();

        this.isInitialized = true;
        logger.info('NumberBuyer initialized', {
            providers: Array.from(this.pool.providers.keys())
        });
    }

    /**
     * Graceful shutdown.
     */
    async shutdown() {
        if (!this.isInitialized) return;

        this.abort();
        await this.pool.uninitialize();
        this.isInitialized = false;
        this.pool = null;

        logger.info('NumberBuyer shut down');
    }

    // ─── Single Purchase ─────────────────────────────────────────────────

    /**
     * Buy a single number.
     * @param {string} country — ISO country code
     * @param {Object} options — { preferredProvider, retries }
     * @returns {Promise<{success: boolean, number?: Object, error?: string}>}
     */
    async buy(country, options = {}) {
        this._ensureReady();
        this._validateCountry(country);

        const preferredProvider = options.preferredProvider || null;
        const maxRetries = options.retries ?? 2;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const result = await this.pool.buyNewNumber(country, 1, preferredProvider);

                if (result.purchased.length === 0) {
                    const err = result.errors[0]?.error || 'Unknown purchase failure';
                    throw new Error(err);
                }

                const doc = result.purchased[0];
                const provider = doc.provider;

                logger.info('Number purchased', {
                    country,
                    provider,
                    phone: this.maskPhone(doc.phoneNumber),
                    cost: doc.monthlyCost,
                    attempt: attempt + 1
                });

                return {
                    success: true,
                    number: {
                        id: doc._id.toString(),
                        phoneNumber: doc.phoneNumber,
                        provider,
                        providerSid: doc.twilioSid || doc.telnyxSid,
                        country: doc.country,
                        monthlyCost: doc.monthlyCost,
                        purchasedAt: doc.purchasedAt
                    }
                };

            } catch (error) {
                const isRateLimit = this._isRateLimitError(error);
                const isInventory = this._isInventoryError(error);
                const isLastAttempt = attempt === maxRetries;

                logger.error('Purchase attempt failed', {
                    country,
                    attempt: attempt + 1,
                    maxRetries: maxRetries + 1,
                    isRateLimit,
                    isInventory,
                    error: error.message
                });

                // INVENTORY ERROR: Don't retry — stock won't appear instantly
                if (isInventory) {
                    return {
                        success: false,
                        error: error.message,
                        country,
                        attempts: attempt + 1,
                        isInventoryError: true
                    };
                }

                if (isLastAttempt) {
                    return {
                        success: false,
                        error: error.message,
                        country,
                        attempts: attempt + 1
                    };
                }

                if (isRateLimit) {
                    const backoff = this._calculateBackoff(attempt);
                    logger.warn(`Rate limited, backing off ${backoff}ms...`);
                    await this._delay(backoff);
                }
            }
        }

        // Unreachable, but satisfies lint
        return { success: false, error: 'Exhausted all retries' };
    }

    // ─── Multiple Purchases ──────────────────────────────────────────────

    /**
     * Buy numbers across multiple countries/configurations.
     * @param {Array} configs — [{ country, count, preferredProvider, delayMs }]
     * @param {Object} globalOptions — { abortOnError, pauseBetweenMs }
     * @returns {Promise<{success: boolean, totalSuccess, totalFailed, totalCost, results: Array}>}
     */
    async buyMultiple(configs, globalOptions = {}) {
        this._ensureReady();

        if (!Array.isArray(configs) || configs.length === 0) {
            throw new Error('INVALID_CONFIG: configs must be a non-empty array');
        }

        const abortOnError = globalOptions.abortOnError ?? false;
        const pauseBetweenMs = globalOptions.pauseBetweenMs || this.defaultPauseMs;

        this.abortController = new AbortController();
        const startTime = Date.now();

        const allResults = [];
        let totalSuccess = 0;
        let totalFailed = 0;
        let totalCost = 0;

        for (let idx = 0; idx < configs.length; idx++) {
            const cfg = configs[idx];
            this._validateConfig(cfg);

            // Check abort before each country batch
            if (this._isAborted()) {
                logger.warn('Purchase aborted by user', {
                    processedCountries: idx,
                    remaining: configs.length - idx
                });
                break;
            }

            const batchResult = await this._buyCountryBatch(
                cfg.country,
                cfg.count,
                cfg.preferredProvider || null,
                cfg.delayMs ?? this.defaultDelayMs
            );

            totalSuccess += batchResult.successCount;
            totalFailed += batchResult.failedCount;
            totalCost += batchResult.totalCost;

            allResults.push({
                country: cfg.country,
                requested: cfg.count,
                ...batchResult
            });

            // Pause between countries (except after last)
            if (idx < configs.length - 1 && pauseBetweenMs > 0) {
                logger.info(`Pausing ${pauseBetweenMs}ms before next country...`);
                await this._delay(pauseBetweenMs);
            }

            // Abort on first country failure if configured
            if (abortOnError && batchResult.failedCount > 0 && batchResult.successCount === 0) {
                logger.error('Aborting due to complete country failure', {
                    country: cfg.country,
                    failed: batchResult.failedCount
                });
                break;
            }
        }

        const durationSec = Math.round((Date.now() - startTime) / 1000);
        const allAttempted = totalSuccess + totalFailed;
        const successRate = allAttempted > 0
            ? ((totalSuccess / allAttempted) * 100).toFixed(1)
            : '0.0';

        const summary = {
            success: totalFailed === 0,
            totalSuccess,
            totalFailed,
            totalCost: parseFloat(totalCost.toFixed(2)),
            successRate: `${successRate}%`,
            durationSec,
            results: allResults
        };

        logger.info('Purchase run complete', summary);

        return summary;
    }

    // ─── Internal: Country Batch ─────────────────────────────────────────

    async _buyCountryBatch(country, count, preferredProvider, delayMs) {
        const numbers = [];
        const errors = [];
        let totalCost = 0;

        for (let i = 0; i < count; i++) {
            if (this._isAborted()) {
                logger.warn('Batch aborted mid-country', { country, processed: i, requested: count });
                break;
            }

            const result = await this.buy(country, {
                preferredProvider,
                retries: 1
            });

            if (result.success) {
                numbers.push(result.number);
                totalCost += result.number.monthlyCost || 0;

                logger.info(`Progress ${country}: ${i + 1}/${count}`, {
                    phone: result.number.phoneNumber?.slice(-4),
                    provider: result.number.provider
                });
            } else {
                errors.push({
                    index: i,
                    error: result.error,
                    country
                });
            }

            // Delay between individual purchases (except last)
            if (i < count - 1 && delayMs > 0) {
                await this._delay(delayMs);
            }
        }

        return {
            successCount: numbers.length,
            failedCount: errors.length,
            totalCost,
            numbers,
            errors
        };
    }

    // ─── Abort Control ───────────────────────────────────────────────────

    abort() {
        if (this.abortController) {
            this.abortController.abort();
            logger.info('NumberBuyer abort signal sent');
        }
    }

    _isAborted() {
        return this.abortController?.signal.aborted ?? false;
    }

    // ─── Validation ────────────────────────────────────────────────────────

    _ensureReady() {
        if (!this.isInitialized || !this.pool) {
            throw new Error('NOT_INITIALIZED: Call init() before purchasing');
        }
    }

    _validateCountry(country) {
        if (!country || typeof country !== 'string' || country.length !== 2) {
            throw new Error(`INVALID_COUNTRY: Expected 2-letter ISO code, got "${country}"`);
        }
    }

    _validateConfig(cfg) {
        if (!cfg || typeof cfg !== 'object') {
            throw new Error('INVALID_CONFIG: Each config must be an object');
        }
        this._validateCountry(cfg.country);

        const count = cfg.count;
        if (!Number.isInteger(count) || count < 1 || count > 1000) {
            throw new Error(`INVALID_COUNT: Expected integer 1-1000, got ${count}`);
        }
    }

    // ─── Error Detection ─────────────────────────────────────────────────

    _isRateLimitError(error) {
        if (!error) return false;
        const msg = error.message?.toLowerCase() || '';
        const code = error.code;

        return (
            code === 20429 ||
            code === 429 ||
            code === 'ECONNRESET' ||
            msg.includes('rate limit') ||
            msg.includes('too many requests') ||
            msg.includes('throttled')
        );
    }

    _isInventoryError(error) {
        if (!error?.message) return false;
        const msg = error.message.toLowerCase();
        return (
            msg.includes('no numbers available') ||
            msg.includes('no available numbers') ||
            msg.includes('telnyx_no_numbers') ||
            msg.includes('not available in') ||
            msg.includes('out of stock') ||
            msg.includes('exhausted') ||
            msg.includes('no numbers') ||
            msg.includes('not available')
        );
    }

    _calculateBackoff(attemptIndex) {
        const base = 1000 * (2 ** attemptIndex);
        const jitter = Math.floor(Math.random() * 500);
        return Math.min(base + jitter, this.maxBackoffMs);
    }

    // ─── Utilities ───────────────────────────────────────────────────────

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

// ─── Factory & Convenience Exports ─────────────────────────────────────

/**
 * Quick single purchase.
 */
export async function buyNumber(country, options = {}) {
    const buyer = new NumberBuyer();
    await buyer.init(options.providers);
    try {
        return await buyer.buy(country, options);
    } finally {
        await buyer.shutdown();
    }
}

/**
 * Quick multi-country purchase.
 */
export async function buyNumbers(configs, globalOptions = {}) {
    const buyer = new NumberBuyer(globalOptions);
    await buyer.init(globalOptions?.providers);
    try {
        return await buyer.buyMultiple(configs, globalOptions);
    } finally {
        await buyer.shutdown();
    }
}

export { NumberBuyer };
export default NumberBuyer;
            
