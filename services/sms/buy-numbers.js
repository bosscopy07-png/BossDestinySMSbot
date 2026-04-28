import NumberPoolManager from './NumberPoolManager.js';
import TwilioProvider from './TwilioProvider.js';
import connectDatabase from '../../config/database.js';
import logger from '../../utils/logger.js';

class BatchNumberBuyer {
    constructor(poolManager) {
        this.pool = poolManager;
        this.isConnected = false;
        this.abortController = new AbortController();
    }

    async ensureConnection() {
        if (this.isConnected) return;
        await connectDatabase();
        await this.pool.initialize();
        this.isConnected = true;
    }

    async buyBatch(country, count, delayMs = 1000) {
        const results = { success: 0, failed: 0, errors: [], numbers: [] };

        logger.info('Starting batch purchase', { country, count, delayMs });

        for (let i = 0; i < count; i++) {
            // Check for cancellation
            if (this.abortController.signal.aborted) {
                logger.warn('Batch purchase aborted', { country, processed: i });
                break;
            }

            try {
                const result = await this.pool.buyNewNumber(country);
                results.success++;
                results.numbers.push({
                    phone: result.phoneNumber,
                    sid: result.twilioSid,
                    cost: result.monthlyCost
                });

                logger.info(`Bought ${i + 1}/${count}`, {
                    country,
                    phone: result.phoneNumber?.slice(-4),
                    cost: result.monthlyCost
                });

                if (i < count - 1 && delayMs > 0) {
                    await this.delay(delayMs);
                }

            } catch (error) {
                results.failed++;
                results.errors.push({ index: i, error: error.message, code: error.code });

                logger.error(`Failed to buy ${i + 1}/${count}`, {
                    country,
                    error: error.message,
                    code: error.code
                });

                // Handle rate limiting with exponential backoff
                if (error.code === 20429 || error.message?.toLowerCase().includes('rate limit')) {
                    const backoffMs = Math.min(5000 * (2 ** results.failed), 60000);
                    logger.warn(`Rate limited, backing off ${backoffMs}ms...`);
                    await this.delay(backoffMs);
                }
            }
        }

        return results;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async run(config = {}) {
        const startTime = Date.now();
        this.abortController = new AbortController();

        const batches = config.batches || [
            { country: 'US', count: 20 },
            { country: 'UK', count: 10 },
            { country: 'CA', count: 10 }
        ];

        const allResults = [];
        let totalAttempts = 0;

        await this.ensureConnection();

        for (let idx = 0; idx < batches.length; idx++) {
            const batch = batches[idx];
            totalAttempts += batch.count;

            const result = await this.buyBatch(
                batch.country,
                batch.count,
                batch.delayMs
            );

            allResults.push({
                country: batch.country,
                count: batch.count,
                ...result
            });

            // Pause between batches (except after last)
            if (idx < batches.length - 1) {
                const pauseMs = config.pauseBetweenBatches || 2000;
                logger.info(`Pausing ${pauseMs}ms between batches...`);
                await this.delay(pauseMs);
            }
        }

        const stats = this.calculateStats(allResults, startTime);

        logger.info('Batch purchase complete', {
            totalSuccess: stats.totalSuccess,
            totalFailed: stats.totalFailed,
            totalCost: stats.totalCost.toFixed(2),
            successRate: `${stats.successRate}%`,
            durationSec: stats.durationSec
        });

        return {
            success: stats.totalFailed === 0,
            ...stats,
            details: allResults
        };
    }

    calculateStats(allResults, startTime) {
        const totalSuccess = allResults.reduce((s, r) => s + r.success, 0);
        const totalFailed = allResults.reduce((s, r) => s + r.failed, 0);
        const totalAttempts = totalSuccess + totalFailed;
        const totalCost = allResults.reduce(
            (s, r) => s + r.numbers.reduce((ns, n) => ns + (n.cost || 0), 0),
            0
        );

        return {
            totalSuccess,
            totalFailed,
            totalCost,
            successRate: totalAttempts > 0 ? ((totalSuccess / totalAttempts) * 100).toFixed(1) : '0.0',
            durationSec: Math.round((Date.now() - startTime) / 1000)
        };
    }

    abort() {
        this.abortController.abort();
        logger.info('BatchNumberBuyer abort signal sent');
    }

    async disconnect() {
        if (!this.isConnected) return;
        
        try {
            this.pool.stopCleanupJob?.();
            // Mongoose connection is typically managed at app level
            // Only disconnect if this class owns the connection
            if (this.pool.connection) {
                await mongoose.connection.close();
            }
        } catch (error) {
            logger.error('Error during disconnect', { error: error.message });
        } finally {
            this.isConnected = false;
        }
    }
}

// ─── Singleton with proper cleanup ───
let buyerInstance = null;

function getBuyer() {
    if (!buyerInstance) {
        const twilio = new TwilioProvider();
        const pool = new NumberPoolManager(twilio);
        buyerInstance = new BatchNumberBuyer(pool);
    }
    return buyerInstance;
}

export async function purchaseNumbersBatch(config = {}) {
    const buyer = getBuyer();
    try {
        const result = await buyer.run(config);
        return result;
    } catch (error) {
        logger.error('Fatal error in purchaseNumbersBatch', { error: error.message, stack: error.stack });
        return { success: false, error: error.message, fatal: true };
    }
}

export async function disconnectBuyer() {
    if (!buyerInstance) return;
    
    await buyerInstance.disconnect();
    buyerInstance = null;
    logger.info('BatchNumberBuyer disconnected and instance cleared');
}

export { BatchNumberBuyer, getBuyer };
export default BatchNumberBuyer;
    
