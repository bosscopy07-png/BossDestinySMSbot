
import NumberPoolManager from './NumberPoolManager.js';
import TwilioProvider from './TwilioProvider.js';
import { connectDB, disconnectDB } from '../../../config/database.js';
import logger from '../../../utils/logger.js';

class BatchNumberBuyer {
    constructor(poolManager) {
        this.pool = poolManager;
        this.isConnected = false;
    }

    async ensureConnection() {
        if (!this.isConnected) {
            await connectDB();
            await this.pool.initialize();
            this.isConnected = true;
        }
    }

    async buyBatch(country, count, delayMs = 1000) {
        const results = { success: 0, failed: 0, errors: [], numbers: [] };

        logger.info('Starting batch purchase', { country, count, delayMs });

        for (let i = 0; i < count; i++) {
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

                if (i < count - 1) {
                    await new Promise(r => setTimeout(r, delayMs));
                }

            } catch (error) {
                results.failed++;
                results.errors.push({ index: i, error: error.message });

                logger.error(`Failed to buy ${i + 1}/${count}`, {
                    country,
                    error: error.message
                });

                if (error.message?.includes('rate limit') || error.code === 20429) {
                    logger.warn('Rate limited, backing off 5s...');
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }

        return results;
    }

    async run(config = {}) {
        const startTime = Date.now();

        const batches = config.batches || [
            { country: 'US', count: 20 },
            { country: 'UK', count: 10 },
            { country: 'CA', count: 10 }
        ];

        const allResults = [];

        await this.ensureConnection();

        for (let idx = 0; idx < batches.length; idx++) {
            const batch = batches[idx];
            const result = await this.buyBatch(batch.country, batch.count, batch.delayMs);

            allResults.push({
                country: batch.country,
                count: batch.count,
                ...result
            });

            if (idx < batches.length - 1) {
                logger.info('Pausing between batches...');
                await new Promise(r => setTimeout(r, config.pauseBetweenBatches || 2000));
            }
        }

        const totalSuccess = allResults.reduce((s, r) => s + r.success, 0);
        const totalFailed = allResults.reduce((s, r) => s + r.failed, 0);
        const totalCost = allResults.reduce(
            (s, r) => s + r.numbers.reduce((ns, n) => ns + (n.cost || 0), 0),
            0
        );

        logger.info('Batch purchase complete', {
            totalSuccess,
            totalFailed,
            totalCost: totalCost.toFixed(2),
            durationSec: Math.round((Date.now() - startTime) / 1000)
        });

        return {
            success: true,
            totalSuccess,
            totalFailed,
            totalCost,
            details: allResults
        };
    }

    async disconnect() {
        if (this.isConnected) {
            this.pool.stopCleanupJob();
            await disconnectDB();
            this.isConnected = false;
        }
    }
}

// Singleton instance for reuse
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
        logger.error('Fatal error in purchaseNumbersBatch', { error: error.message });
        return { success: false, error: error.message };
    }
}

export async function disconnectBuyer() {
    if (buyerInstance) {
        await buyerInstance.disconnect();
        buyerInstance = null;
    }
}

export { BatchNumberBuyer, getBuyer };
export default BatchNumberBuyer;
