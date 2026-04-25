import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class TelnyxProvider {
    constructor() {
        this.name = 'TELNYX';
        this.tier = 'VIP';
        this.isActive = false;

        const hasCredentials = config.telnyx?.apiKey && config.telnyx?.phoneNumber;

        if (!hasCredentials) {
            logger.warn('TelnyxProvider disabled — no credentials');
            return;
        }

        this.apiKey = config.telnyx.apiKey;
        this.phoneNumber = config.telnyx.phoneNumber;
        this.messagingProfileId = config.telnyx.messagingProfileId || null;
        this.baseUrl = 'https://api.telnyx.com/v2';
        this.isActive = true;

        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0
        };

        logger.info('TelnyxProvider initialized');
    }

    getHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    async sendSMS(to, message, options = {}) {
        if (!this.isActive) {
            return { success: false, error: 'TELNYX_NOT_CONFIGURED' };
        }

        const startTime = Date.now();

        try {
            const url = `${this.baseUrl}/messages`;

            const payload = {
                from: this.phoneNumber,
                to: to,
                text: message,
                ...options
            };

            if (this.messagingProfileId) {
                payload.messaging_profile_id = this.messagingProfileId;
            }

            const response = await axios.post(url, payload, {
                headers: this.getHeaders(),
                timeout: 30000
            });

            const duration = Date.now() - startTime;
            this.updateStats(true, duration);

            return {
                success: true,
                messageId: response.data?.data?.id,
                status: response.data?.data?.state || 'sent',
                provider: this.name
            };

        } catch (error) {
            this.updateStats(false, Date.now() - startTime);

            const errorMessage = error.response?.data?.errors?.[0]?.detail || error.message;
            logger.error('Telnyx SMS failed', { error: errorMessage });

            return {
                success: false,
                error: errorMessage,
                provider: this.name
            };
        }
    }

    async getNumber(country = 'US') {
        if (!this.isActive) {
            throw new Error('TELNYX_NOT_CONFIGURED');
        }

        try {
            return {
                phoneNumber: this.phoneNumber,
                provider: this.name,
                country,
                monthlyCost: 1.00
            };

        } catch (error) {
            throw new Error(`Failed to get Telnyx number: ${error.message}`);
        }
    }

    updateStats(success, duration) {
        this.stats.totalSent++;
        if (success) this.stats.totalSuccess++;
        else this.stats.totalFailed++;
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

export default TelnyxProvider;
