import logger from '../../utils/logger.js';

class RetryEngine {
    constructor(providerManager) {
        this.providerManager = providerManager;
        this.retryConfig = {
            FREE: { maxRetries: 0, fallbackTier: null },
            CHEAP: { maxRetries: 2, fallbackTier: 'FREE' },
            VIP: { maxRetries: 1, fallbackTier: 'CHEAP' }
        };
    }

    async executeWithRetry(session, operation) {
        const config = this.retryConfig[session.mode];
        let lastError = null;

        for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
            try {
                const result = await operation();
                if (result.success) {
                    return { success: true, result, attempts: attempt + 1 };
                }
                lastError = result.error;
            } catch (error) {
                lastError = error.message;
                logger.error(`Retry attempt ${attempt + 1} failed`, {
                    sessionId: session.sessionId,
                    error: error.message
                });
            }

            if (attempt < config.maxRetries) {
                const delay = this.calculateDelay(attempt, session.mode);
                logger.info(`Retrying in ${delay}ms`, {
                    sessionId: session.sessionId,
                    attempt: attempt + 2
                });
                await this.sleep(delay);
            }
        }

        // All retries exhausted
        return {
            success: false,
            error: lastError,
            attempts: config.maxRetries + 1,
            exhausted: true
        };
    }

    async fallback(session) {
        const config = this.retryConfig[session.mode];

        if (!config.fallbackTier) {
            return { success: false, reason: 'NO_FALLBACK_AVAILABLE' };
        }

        try {
            logger.info(`Attempting fallback to ${config.fallbackTier}`, {
                sessionId: session.sessionId
            });

            const fallbackNumber = await this.providerManager.getNumber(
                config.fallbackTier,
                session.country,
                session.service
            );

            return {
                success: true,
                fallbackTier: config.fallbackTier,
                number: fallbackNumber
            };

        } catch (error) {
            logger.error('Fallback failed', {
                sessionId: session.sessionId,
                error: error.message
            });
            return { success: false, error: error.message };
        }
    }

    calculateDelay(attempt, mode) {
        // Exponential backoff with jitter
        const baseDelays = {
            FREE: 5000,
            CHEAP: 3000,
            VIP: 1000
        };

        const base = baseDelays[mode] || 3000;
        const exponential = base * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;

        return Math.min(exponential + jitter, 30000); // Max 30s
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default RetryEngine;

 
