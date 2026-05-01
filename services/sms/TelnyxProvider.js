import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * TelnyxProvider — SMS sending + number lifecycle management
 * 
 * FIXED:
 * - Country validated before ANY API call
 * - Payload logged before every request
 * - BASE_URL validated for webhook configuration
 * - FLAT payload for number_orders (no data wrapper)
 * - Proper error handling with response logging
 */
class TelnyxProvider {
    constructor() {
        this.name = 'TELNYX';
        this.tier = 'VIP';
        this.isActive = false;
        this.baseUrl = 'https://api.telnyx.com/v2';

        // Validate BASE_URL for webhook configuration
        const baseUrl = process.env.BASE_URL || config.baseUrl;
        if (!baseUrl) {
            logger.warn('TelnyxProvider — BASE_URL not set. Webhooks will not be configured.');
            this.webhookUrl = null;
        } else {
            this.webhookUrl = `${baseUrl.replace(/\/$/, '')}/webhooks/telnyx`;
        }

        const rawKey = config.telnyx?.apiKey;
        const apiKey = rawKey ? rawKey.trim() : null;

        if (!apiKey) {
            logger.warn('TelnyxProvider disabled — no API key configured');
            return;
        }

        if (!apiKey.startsWith('KEY') || apiKey.length < 20) {
            logger.error('TelnyxProvider disabled — API key malformed', {
                startsWith: apiKey.slice(0, 3),
                length: apiKey.length
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
            hasConnectionId: !!this.connectionId,
            hasWebhookUrl: !!this.webhookUrl
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

            logger.debug('Telnyx SMS payload', { 
                payload: { ...payload, text: payload.text?.slice(0, 20) + '...' } 
            });

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
            logger.warn('Telnyx availability check failed', { 
                country, 
                error: error.response?.data?.errors?.[0]?.detail || error.message,
                status: error.response?.status
            });
            return false;
        }
    }

    // ─── Number Lifecycle ────────────────────────────────────────────────

    /**
     * Buy a number from Telnyx.
     * FIXED: Uses FLAT payload (no data wrapper) for number_orders endpoint.
     */
    async buyNumber(country = 'US') {
        if (!this.isActive) {
            throw new Error('TELNYX_NOT_CONFIGURED');
        }

        // Validate country
        if (!country || typeof country !== 'string' || country.length !== 2) {
            throw new Error(`TELNYX_INVALID_COUNTRY: Country must be 2-letter ISO code. Got: ${country}`);
        }

        // Check stock
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

        if (!phoneNumber || typeof phoneNumber !== 'string') {
            throw new Error(`TELNYX_INVALID_NUMBER: Search returned invalid phone number: ${phoneNumber}`);
        }

        // Step 2: Build FLAT purchase payload (NOT wrapped in data)
        const purchasePayload = {
            phone_numbers: [{ phone_number: phoneNumber }],
            customer_reference: `otp-pool-${Date.now()}`
        };

        if (this.messagingProfileId) {
            purchasePayload.messaging_profile_id = this.messagingProfileId;
        }
        if (this.connectionId) {
            purchasePayload.connection_id = this.connectionId;
        }
        if (config.telnyx?.billingGroupId) {
            purchasePayload.billing_group_id = config.telnyx.billingGroupId;
        }

        // Validate payload
        if (!purchasePayload.phone_numbers || purchasePayload.phone_numbers.length === 0) {
            throw new Error('TELNYX_EMPTY_PAYLOAD: phone_numbers array is empty');
        }

        logger.info('Telnyx number purchase payload', {
            country,
            phoneNumber: this.maskPhone(phoneNumber),
            payload: JSON.stringify(purchasePayload),
            hasMessagingProfile: !!purchasePayload.messaging_profile_id,
            hasConnectionId: !!purchasePayload.connection_id
        });

        // Step 3: Purchase with FLAT payload
        let purchaseResponse;
        try {
            purchaseResponse = await axios.post(
                `${this.baseUrl}/number_orders`,
                purchasePayload,
                { headers: this.getHeaders(), timeout: 30000 }
            );
        } catch (error) {
            const msg = error.response?.data?.errors?.[0]?.detail || error.message;
            const code = error.response?.status;
            const responseData = error.response?.data;
            
            logger.error('Telnyx purchase failed', {
                status: code,
                message: msg,
                payload: purchasePayload,
                response: responseData
            });
            
            throw new Error(`TELNYX_PURCHASE_FAILED: ${msg}`);
        }

        const purchased = purchaseResponse.data?.data;
        if (!purchased) {
            throw new Error('TELNYX_PURCHASE_EMPTY: No data returned after purchase');
        }

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
     * Get a number — alias for buyNumber (pool manager interface)
     */
    async getNumber(country = 'US') {
        return this.buyNumber(country);
    }

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

    async cancelNumber(sid) {
        return this.releaseNumber(sid);
    }

    async finishNumber(sid) {
        return this.releaseNumber(sid);
    }

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
        
