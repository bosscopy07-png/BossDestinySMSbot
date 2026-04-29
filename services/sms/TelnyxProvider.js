import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * TelnyxProvider — SMS sending + number lifecycle management
 * 
 * Required env/config:
 *   TELNYX_API_KEY
 *   TELNYX_MESSAGING_PROFILE_ID (optional, for SMS)
 * 
 * Number management requires:
 *   TELNYX_API_KEY with scope: phone_numbers, messaging
 */
class TelnyxProvider {
    constructor() {
        this.name = 'TELNYX';
        this.tier = 'VIP';
        this.isActive = false;
        this.baseUrl = 'https://api.telnyx.com/v2';

        const apiKey = config.telnyx?.apiKey;

        if (!apiKey) {
            logger.warn('TelnyxProvider disabled — no API key');
            return;
        }

        this.apiKey = apiKey;
        this.messagingProfileId = config.telnyx?.messagingProfileId || null;
        this.isActive = true;

        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            totalResponseTime: 0,
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

    // ─── SMS ─────────────────────────────────────────────────────────────

    async sendSMS(to, message, options = {}) {
        if (!this.isActive) {
            return { success: false, error: 'TELNYX_NOT_CONFIGURED' };
        }

        const startTime = Date.now();

        try {
            const payload = {
                from: options.from || this.phoneNumber,
                to,
                text: message,
                ...options
            };

            if (this.messagingProfileId) {
                payload.messaging_profile_id = this.messagingProfileId;
            }

            const response = await axios.post(
                `${this.baseUrl}/messages`,
                payload,
                { headers: this.getHeaders(), timeout: 30000 }
            );

            const duration = Date.now() - startTime;
            this.updateStats(true, duration);

            return {
                success: true,
                messageId: response.data?.data?.id,
                status: response.data?.data?.state || 'sent',
                provider: this.name
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration);

            const errorMessage = error.response?.data?.errors?.[0]?.detail || error.message;
            logger.error('Telnyx SMS failed', { to, error: errorMessage });

            return {
                success: false,
                error: errorMessage,
                provider: this.name
            };
        }
    }

    // ─── Number Lifecycle (Pool Manager Interface) ───────────────────────

    /**
     * Search for available numbers in a country and purchase one.
     * @param {string} country — ISO country code (e.g. 'US', 'GB')
     * @returns {Promise<{phoneNumber: string, sid: string, monthlyCost: number}>}
     */
    async buyNumber(country = 'US') {
        if (!this.isActive) {
            throw new Error('TELNYX_NOT_CONFIGURED');
        }

        // Step 1: Search available numbers
        let searchResponse;
        try {
            searchResponse = await axios.get(
                `${this.baseUrl}/available_phone_numbers`,
                {
                    headers: this.getHeaders(),
                    params: {
                        'filter[country_code]': country,
                        'filter[limit]': 1,
                        'filter[phone_number_type]': 'local'
                    },
                    timeout: 15000
                }
            );
        } catch (error) {
            const msg = error.response?.data?.errors?.[0]?.detail || error.message;
            throw new Error(`TELNYX_SEARCH_FAILED: ${msg}`);
        }

        const available = searchResponse.data?.data;
        if (!available || available.length === 0) {
            throw new Error(`TELNYX_NO_NUMBERS: No available numbers in ${country}`);
        }

        const numberData = available[0];
        const phoneNumber = numberData.phone_number;
        const numberId = numberData.id;

        // Step 2: Purchase the number
        let purchaseResponse;
        try {
            purchaseResponse = await axios.post(
                `${this.baseUrl}/phone_numbers`,
                {
                    data: {
                        phone_number: phoneNumber,
                        messaging_profile_id: this.messagingProfileId || undefined,
                        connection_id: config.telnyx?.connectionId || undefined
                    }
                },
                { headers: this.getHeaders(), timeout: 30000 }
            );
        } catch (error) {
            const msg = error.response?.data?.errors?.[0]?.detail || error.message;
            throw new Error(`TELNYX_PURCHASE_FAILED: ${msg}`);
        }

        const purchased = purchaseResponse.data?.data;
        if (!purchased) {
            throw new Error('TELNYX_PURCHASE_EMPTY: No data returned after purchase');
        }

        logger.info('Telnyx number purchased', {
            phone: this.maskPhone(phoneNumber),
            country,
            id: purchased.id
        });

        return {
            phoneNumber,
            sid: purchased.id,
            monthlyCost: this.estimateMonthlyCost(country)
        };
    }

    /**
     * Release a purchased number back to Telnyx.
     * @param {string} sid — Telnyx phone number ID
     */
    async releaseNumber(sid) {
        if (!this.isActive) {
            throw new Error('TELNYX_NOT_CONFIGURED');
        }

        try {
            await axios.delete(
                `${this.baseUrl}/phone_numbers/${sid}`,
                { headers: this.getHeaders(), timeout: 15000 }
            );

            logger.info('Telnyx number released', { sid });
            return { success: true };

        } catch (error) {
            const msg = error.response?.data?.errors?.[0]?.detail || error.message;
            logger.error('Telnyx release failed', { sid, error: msg });
            throw new Error(`TELNYX_RELEASE_FAILED: ${msg}`);
        }
    }

    /**
     * Get details for a specific number.
     * @param {string} sid — Telnyx phone number ID
     */
    async getNumberDetails(sid) {
        if (!this.isActive) {
            throw new Error('TELNYX_NOT_CONFIGURED');
        }

        const response = await axios.get(
            `${this.baseUrl}/phone_numbers/${sid}`,
            { headers: this.getHeaders(), timeout: 15000 }
        );

        const data = response.data?.data;
        return {
            phoneNumber: data?.phone_number,
            sid: data?.id,
            status: data?.status,
            country: data?.country_code
        };
    }

    // ─── Stats ───────────────────────────────────────────────────────────

    updateStats(success, duration) {
        this.stats.totalSent++;
        this.stats.totalResponseTime += duration;

        if (success) {
            this.stats.totalSuccess++;
        } else {
            this.stats.totalFailed++;
        }

        this.stats.avgResponseTime = Math.round(
            this.stats.totalResponseTime / this.stats.totalSent
        );
    }

    getStats() {
        const { totalSent, totalSuccess } = this.stats;
        return {
            name: this.name,
            tier: this.tier,
            isActive: this.isActive,
            ...this.stats,
            successRate: totalSent > 0
                ? (totalSuccess / totalSent * 100).toFixed(2)
                : '100.00'
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    estimateMonthlyCost(country) {
        const rates = { US: 1.00, CA: 1.00, GB: 1.50, AU: 2.00 };
        return rates[country] || 1.50;
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

export default TelnyxProvider;
                
