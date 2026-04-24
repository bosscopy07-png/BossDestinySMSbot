
import twilio from 'twilio';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class TwilioProvider {
    constructor() {
        this.name = 'TWILIO';
        this.tier = 'VIP'; // Can also serve CHEAP as fallback
        this.client = twilio(config.twilio.sid, config.twilio.authToken);
        this.phoneNumber = config.twilio.phoneNumber;
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
            const result = await this.client.messages.create({
                body: message,
                from: this.phoneNumber,
                to: to,
                ...options
            });

            const duration = Date.now() - startTime;
            this.updateStats(true, duration);

            logger.info('Twilio SMS sent', {
                provider: this.name,
                to: to.slice(-4),
                sid: result.sid,
                status: result.status,
                duration
            });

            return {
                success: true,
                messageId: result.sid,
                status: result.status,
                provider: this.name
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration);

            logger.error('Twilio SMS failed', {
                provider: this.name,
                to: to.slice(-4),
                error: error.message,
                code: error.code
            });

            return {
                success: false,
                error: error.message,
                code: error.code,
                provider: this.name
            };
        }
    }

    async checkStatus(messageId) {
        try {
            const message = await this.client.messages(messageId).fetch();
            return {
                success: true,
                status: message.status,
                errorCode: message.errorCode,
                errorMessage: message.errorMessage
            };
        } catch (error) {
            logger.error('Twilio status check failed', {
                messageId,
                error: error.message
            });
            return { success: false, error: error.message };
        }
    }

    async getNumber(country = 'US') {
        try {
            // For VIP mode, we need to buy a number
            // In production, you'd manage a pool of purchased numbers
            const availableNumbers = await this.client.availablePhoneNumbers(country)
                .local.list({ limit: 1 });

            if (availableNumbers.length === 0) {
                throw new Error(`No numbers available in ${country}`);
            }

            // In real implementation, you'd purchase and store the number
            // For now, return the configured number (assuming it's already purchased)
            return {
                phoneNumber: this.phoneNumber,
                provider: this.name,
                country: country,
                monthlyCost: 15.00
            };

        } catch (error) {
            logger.error('Twilio number acquisition failed', {
                country,
                error: error.message
            });
            throw error;
        }
    }

    handleErrors(error) {
        const errorMap = {
            21211: 'Invalid phone number',
            21214: 'Phone number not available',
            21608: 'Message body required',
            21610: 'Message cannot be sent to this number',
            21612: 'From phone number not valid',
            21614: 'To phone number not valid',
            30002: 'Account suspended',
            30003: 'Message delivery failed',
            30004: 'Message blocked',
            30005: 'Unknown destination',
            30006: 'Landline or unreachable',
            30007: 'Carrier violation',
            30008: 'Unknown error'
        };

        return {
            code: error.code,
            message: errorMap[error.code] || error.message,
            recoverable: ![30002, 21610, 30004].includes(error.code)
        };
    }

    updateStats(success, duration) {
        this.stats.totalSent++;
        if (success) {
            this.stats.totalSuccess++;
        } else {
            this.stats.totalFailed++;
        }
        // Rolling average
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

export default TwilioProvider;
