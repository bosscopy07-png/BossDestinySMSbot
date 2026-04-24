import { Vonage } from '@vonage/server-sdk';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class VonageProvider {
    constructor() {
        this.name = 'VONAGE';
        this.tier = 'CHEAP'; // Can serve CHEAP and VIP
        this.client = new Vonage({
            apiKey: config.vonage.apiKey,
            apiSecret: config.vonage.apiSecret
        });
        this.phoneNumber = config.vonage.phoneNumber;
        this.isActive = true;
        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0
        };
    }

    async sendSMS(to, message, options = {}) {
        const startTime = Date.now();

        try {
            const result = await this.client.sms.send({
                from: this.phoneNumber,
                to: to,
                text: message,
                ...options
            });

            const duration = Date.now() - startTime;
            const messageResponse = result.messages[0];

            if (messageResponse.status === '0') {
                this.updateStats(true, duration);

                logger.info('Vonage SMS sent', {
                    provider: this.name,
                    to: to.slice(-4),
                    messageId: messageResponse['message-id'],
                    duration
                });

                return {
                    success: true,
                    messageId: messageResponse['message-id'],
                    status: 'sent',
                    provider: this.name
                };
            } else {
                throw new Error(messageResponse['error-text']);
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration);

            logger.error('Vonage SMS failed', {
                provider: this.name,
                to: to.slice(-4),
                error: error.message
            });

            return {
                success: false,
                error: error.message,
                provider: this.name
            };
        }
    }

    async checkStatus(messageId) {
        // Vonage doesn't provide direct status check via SDK
        // You'd implement webhook-based status tracking
        logger.warn('Vonage status check not implemented - use webhooks');
        return { success: true, status: 'unknown' };
    }

    async getNumber(country = 'US') {
        try {
            // Vonage number management
            // In production, you'd use their Numbers API
            return {
                phoneNumber: this.phoneNumber,
                provider: this.name,
                country: country,
                monthlyCost: 1.00 // Vonage numbers are cheaper
            };
        } catch (error) {
            logger.error('Vonage number acquisition failed', {
                country,
                error: error.message
            });
            throw error;
        }
    }

    handleErrors(error) {
        const errorMap = {
            '1': 'Throttled',
            '2': 'Missing params',
            '3': 'Invalid params',
            '4': 'Invalid credentials',
            '5': 'Internal error',
            '6': 'Invalid message',
            '7': 'Number barred',
            '8': 'Partner account barred',
            '9': 'Partner quota exceeded',
            '10': 'Too many existing binds',
            '11': 'Account not enabled',
            '12': 'Message too long',
            '14': 'Invalid signature',
            '15': 'Invalid sender address',
            '22': 'Invalid network code',
            '23': 'Invalid callback URL',
            '29': 'Non-whitelisted destination',
            '32': 'Signature and API secret disallowed',
            '33': 'Number de-activated'
        };

        const code = error.message?.match(/\d+/)?.[0];
        return {
            code: code || 'UNKNOWN',
            message: errorMap[code] || error.message,
            recoverable: !['4', '5', '8', '9', '11'].includes(code)
        };
    }

    updateStats(success, duration) {
        this.stats.totalSent++;
        if (success) {
            this.stats.totalSuccess++;
        } else {
            this.stats.totalFailed++;
        }
        this.stats.avgResponseTime = (
            (this.stats.avgResponseTime * (this.stats.totalSent - 1) + duration)
            / this.stats.totalSent
        );
    }

    getStats() {
        return {
            name: this.name,
            tier: this.tier,
            isActive: this.isActive,
            ...this.stats,
            successRate: this.stats.totalSent > 0
                ? (this.stats.totalSuccess / this.stats.totalSent * 100).toFixed(2)
                : 100
        };
    }
}

export default VonageProvider;
 
