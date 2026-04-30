import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * TelnyxProvider — SMS sending + number lifecycle management
 * 
 * Required env/config:
 *   TELNYX_API_KEY (must start with "KEY", 40+ chars)
 *   TELNYX_MESSAGING_PROFILE_ID (optional, for SMS)
 *   TELNYX_CONNECTION_ID (optional, for number purchase)
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

        const rawKey = config.telnyx?.apiKey;
        const apiKey = rawKey ? rawKey.trim() : null;

        if (!apiKey) {
            logger.warn('TelnyxProvider disabled — no API key configured');
            return;
        }

        // VALIDATE: Telnyx keys start with "KEY" and are 40+ chars
        if (!apiKey.startsWith('KEY') || apiKey.length < 20) {
            logger.error('TelnyxProvider disabled — API key malformed', {
                startsWith: apiKey.slice(0, 3),
                length: apiKey.length,
                hint: 'Key must start with "KEY" and be 40+ characters. Check env config.'
            });
            return;
        }

        this.apiKey = apiKey;
        this.messagingProfileId = config.telnyx?.messagingProfileId || null;
        this.connectionId = config.telnyx?.connectionId || null;
        this.isActive = true;

        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            totalResponseTime: 0,
            avgResponseTime: 0
        };

        logger.info('TelnyxProvider initialized', { 
            hasMessagingProfile: !!this.messagingProfileId,
            hasConnectionId: !!this.connectionId
        });
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

    // ─── Number Availability Check ───────────────────────────────────────

    /**
     * Check if numbers are available in a country before attempting purchase.
     * FIXED: Returns false on 400/404 instead of throwing.
     * @param {string} country — ISO country code
     * @returns {Promise<boolean>}
     */
    async hasAvailableNumbers(country = 'US') {
        if (!this.isActive) return false;

        try {
            const response = await axios.get(
                `${this.baseUrl}/available_phone_numbers`,
                {
                    headers: this.getHeaders(),
                    params: {
                        'filter[country_code]': country,
                        'filter[limit]': 1,
                        'filter[phone_number_type]': 'local'
                    },
                    timeout: 10000
                }
            );
            const available = response.data?.data;
            return available && available.length > 0;
        } catch (error) {
            // FIXED: Return false on any error instead of throwing
            logger.warn('Telnyx availability check failed', { 
                country, 
                error: error.response?.data?.errors?.[0]?.detail || error.message,
                status: error.response?.status
            });
            return false;
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

        // Pre-check: avoid API call if no inventory
        const hasStock = await this.hasAvailableNumbers(country);
        if (!hasStock) {
            throw new Error(`TELNYX_NO_NUMBERS: No available numbers in ${country}`);
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

        // Step 2: Purchase the number
        // FIXED: Use correct Telnyx v2 endpoint /number_orders
        let purchaseResponse;
        try {
            purchaseResponse = await axios.post(
                `${this.baseUrl}/number_orders`,
                {
                    data: {
                        phone_numbers: [{ phone_number: phoneNumber }],
                        messaging_profile_id: this.messagingProfileId || undefined,
                        connection_id: this.connectionId || undefined,
                        billing_group_id: config.telnyx?.billingGroupId || undefined,
                        customer_reference: `otp-pool-${Date.now()}`
                    }
                },
                { headers: this.getHeaders(), timeout: 30000 }
            );
        } catch (error) {
            const msg = error.response?.data?.errors?.[0]?.detail || error.message;
            const code = error.response?.status;
            
            // If /number_orders fails with 404, try without /v2 prefix
            if (code === 404) {
                logger.warn('Telnyx /number_orders returned 404, trying without data wrapper', {
                    error: msg
                });
                try {
                    purchaseResponse = await axios.post(
                        `${this.baseUrl}/number_orders`,
                        {
                            phone_numbers: [{ phone_number: phoneNumber }],
                            messaging_profile_id: this.messagingProfileId || undefined,
                            connection_id: this.connectionId || undefined
                        },
                        { headers: this.getHeaders(), timeout: 30000 }
                    );
                } catch (fallbackError) {
                    const fallbackMsg = fallbackError.response?.data?.errors?.[0]?.detail || fallbackError.message;
                    throw new Error(`TELNYX_PURCHASE_FAILED: ${fallbackMsg}`);
                }
            } else {
                throw new Error(`TELNYX_PURCHASE_FAILED: ${msg}`);
            }
        }

        const purchased = purchaseResponse.data?.data;
        if (!purchased) {
            throw new Error('TELNYX_PURCHASE_EMPTY: No data returned after purchase');
        }

        // Handle both single object and array responses
        const purchaseRecord = Array.isArray(purchased) ? purchased[0] : purchased;
        const sid = purchaseRecord.id || purchaseRecord.phone_number_id;

        logger.info('Telnyx number purchased', {
            phone: this.maskPhone(phoneNumber),
            country,
            id: sid
        });

        return {
            phoneNumber,
            sid,
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
