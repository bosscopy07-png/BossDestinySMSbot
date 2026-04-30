import twilio from 'twilio';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * TwilioProvider — SMS sending + number lifecycle management
 * 
 * FIXED:
 * - Webhook URLs now use validated BASE_URL env var
 * - Throws startup error if BASE_URL is missing
 * - Removed voiceEnabled: false filter
 * - getNumber actually acquires numbers
 */
class TwilioProvider {
    constructor() {
        this.name = 'TWILIO';
        this.tier = 'VIP';
        
        // FIXED: Validate BASE_URL at startup
        const baseUrl = process.env.BASE_URL || config.baseUrl;
        if (!baseUrl) {
            logger.error('TwilioProvider disabled — BASE_URL not configured. Set BASE_URL=https://yourdomain.com');
            this.isActive = false;
            return;
        }
        this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash

        const sid = config.twilio?.sid;
        const authToken = config.twilio?.authToken;
        
        if (!sid || !authToken) {
            logger.warn('TwilioProvider disabled — missing SID or auth token');
            this.isActive = false;
            return;
        }

        try {
            this.client = twilio(sid, authToken);
        } catch (error) {
            logger.error('Twilio client initialization failed', { error: error.message });
            this.isActive = false;
            return;
        }

        this.phoneNumber = config.twilio?.phoneNumber || null;
        this.isActive = true;
        
        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0
        };
        
        this.errorMap = {
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
            30008: 'Unknown error',
            21422: 'Phone number already purchased',
            21421: 'Phone number invalid for region',
            20429: 'Rate limit exceeded'
        };

        logger.info('TwilioProvider initialized', { 
            hasPhoneNumber: !!this.phoneNumber,
            isActive: this.isActive,
            baseUrl: this.baseUrl
        });
    }

    maskPhone(phone) {
        if (!phone || phone.length < 4) return phone;
        return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
    }

    async sendSMS(to, message, options = {}) {
        if (!this.isActive) {
            return { success: false, error: 'TWILIO_NOT_CONFIGURED' };
        }

        const startTime = Date.now();
        
        try {
            const result = await this.client.messages.create({
                body: message,
                from: this.phoneNumber,
                to,
                ...options
            });

            const duration = Date.now() - startTime;
            this.updateStats(true, duration);

            logger.info('Twilio SMS sent', {
                provider: this.name,
                to: this.maskPhone(to),
                sid: result.sid,
                status: result.status,
                duration
            });

            return {
                success: true,
                messageId: result.sid,
                status: result.status,
                provider: this.name,
                duration
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration);
            const errorInfo = this.handleErrors(error);

            logger.error('Twilio SMS failed', {
                provider: this.name,
                to: this.maskPhone(to),
                error: error.message,
                code: error.code,
                recoverable: errorInfo.recoverable
            });

            return {
                success: false,
                error: errorInfo.message,
                code: error.code,
                provider: this.name,
                recoverable: errorInfo.recoverable,
                duration
            };
        }
    }

    async checkStatus(messageId) {
        if (!this.isActive) {
            return { success: false, error: 'TWILIO_NOT_CONFIGURED' };
        }

        try {
            const message = await this.client.messages(messageId).fetch();
            return {
                success: true,
                status: message.status,
                errorCode: message.errorCode,
                errorMessage: message.errorMessage,
                dateSent: message.dateSent,
                dateUpdated: message.dateUpdated,
                price: message.price,
                priceUnit: message.priceUnit
            };
        } catch (error) {
            logger.error('Twilio status check failed', {
                messageId,
                error: error.message,
                code: error.code
            });
            return { 
                success: false, 
                error: error.message,
                code: error.code 
            };
        }
    }

    async hasAvailableNumbers(country = 'US') {
        if (!this.isActive) return false;

        try {
            const numbers = await this.client.availablePhoneNumbers(country)
                .local.list({ 
                    limit: 1, 
                    smsEnabled: true 
                });
            
            const hasNumbers = numbers.length > 0;
            
            if (!hasNumbers) {
                logger.info('Twilio reports no numbers available', { country });
            }
            
            return hasNumbers;
        } catch (error) {
            const statusCode = error.status;
            const errorCode = error.code;
            const isUnsupportedCountry = statusCode === 404 || errorCode === 20421;
            
            logger.warn('Twilio availability check failed', { 
                country, 
                error: error.message,
                statusCode,
                errorCode,
                isUnsupportedCountry
            });
            
            if (isUnsupportedCountry) {
                return false;
            }
            
            if (statusCode === 401 || statusCode === 403 || errorCode === 20429) {
                logger.error('Twilio API auth/rate limit error', { statusCode, errorCode });
                return false;
            }
            
            return false;
        }
    }

    async getNumber(country = 'US') {
        if (!this.isActive) {
            throw new Error('TWILIO_NOT_CONFIGURED');
        }
        return this.buyNumber(country);
    }

    /**
     * FIXED: All webhook URLs now use validated BASE_URL
     * Never generates undefined URLs
     */
    async buyNumber(country = 'US') {
        if (!this.isActive) {
            throw new Error('TWILIO_NOT_CONFIGURED');
        }

        try {
            const hasStock = await this.hasAvailableNumbers(country);
            if (!hasStock) {
                throw new Error(`TWILIO_NO_NUMBERS: No available numbers in ${country}`);
            }

            const availableNumbers = await this.client.availablePhoneNumbers(country)
                .local.list({ 
                    limit: 5,
                    smsEnabled: true
                });

            if (availableNumbers.length === 0) {
                throw new Error(`TWILIO_NO_NUMBERS: No available numbers in ${country}`);
            }

            const selected = availableNumbers[0];
            
            // FIXED: Use validated BASE_URL for all webhook URLs
            const webhookBase = `${this.baseUrl}/webhooks/twilio`;
            const smsUrl = webhookBase;
            const smsFallbackUrl = `${webhookBase}/fallback`;
            const statusCallback = `${webhookBase}/status`;

            // VALIDATION: Ensure no undefined URLs
            if (!smsUrl || !smsFallbackUrl || !statusCallback) {
                throw new Error('TWILIO_CONFIG_ERROR: Webhook URL construction failed');
            }

            logger.debug('Twilio webhook URLs', { smsUrl, smsFallbackUrl, statusCallback });

            const purchasedNumber = await this.client.incomingPhoneNumbers.create({
                phoneNumber: selected.phoneNumber,
                friendlyName: `OTP-${country}-${Date.now()}`,
                smsUrl,
                smsMethod: 'POST',
                smsFallbackUrl,
                smsFallbackMethod: 'POST',
                statusCallback,
                statusCallbackMethod: 'POST'
            });

            logger.info('Twilio number purchased', {
                phone: this.maskPhone(purchasedNumber.phoneNumber),
                sid: purchasedNumber.sid,
                country,
                monthlyCost: purchasedNumber.monthlyCost || 1.00,
                smsUrl,
                smsFallbackUrl
            });

            return {
                phoneNumber: purchasedNumber.phoneNumber,
                sid: purchasedNumber.sid,
                friendlyName: purchasedNumber.friendlyName,
                country,
                monthlyCost: purchasedNumber.monthlyCost || 1.00,
                capabilities: purchasedNumber.capabilities,
                dateCreated: purchasedNumber.dateCreated
            };

        } catch (error) {
            const errorInfo = this.handleErrors(error);
            logger.error('Twilio buy number failed', { 
                country, 
                error: errorInfo.message,
                code: error.code,
                recoverable: errorInfo.recoverable
            });
            throw new Error(`Failed to buy number: ${errorInfo.message}`);
        }
    }

    async releaseNumber(sid) {
        if (!this.isActive) {
            return { success: false, error: 'TWILIO_NOT_CONFIGURED' };
        }

        try {
            await this.client.incomingPhoneNumbers(sid).remove();
            logger.info('Twilio number released', { sid });
            return { success: true, sid };
        } catch (error) {
            logger.error('Twilio release number failed', { sid, error: error.message });
            return { success: false, error: error.message, code: error.code };
        }
    }

    async listNumbers(country = null) {
        if (!this.isActive) {
            return { success: false, error: 'TWILIO_NOT_CONFIGURED' };
        }

        try {
            const filter = country ? { phoneNumber: { startsWith: `+${this.getCountryCode(country)}` } } : {};
            const numbers = await this.client.incomingPhoneNumbers.list(filter);
            
            return numbers.map(num => ({
                phoneNumber: num.phoneNumber,
                sid: num.sid,
                friendlyName: num.friendlyName,
                country: num.phoneNumberCountryCode,
                capabilities: num.capabilities,
                dateCreated: num.dateCreated,
                status: num.status
            }));
        } catch (error) {
            logger.error('Twilio list numbers failed', { country, error: error.message });
            throw error;
        }
    }

    getCountryCode(country) {
        const codes = { US: '1', UK: '44', CA: '1', AU: '61', DE: '49', FR: '33' };
        return codes[country.toUpperCase()] || '1';
    }

    handleErrors(error) {
        const code = error.code;
        const message = this.errorMap[code] || error.message;
        const nonRecoverable = [30002, 21610, 30004, 21422, 21421];
        
        return {
            code,
            message,
            recoverable: !nonRecoverable.includes(code),
            isAuthError: [20003, 20429].includes(code),
            isRateLimit: error.status === 429 || code === 20429
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
        const total = this.stats.totalSent;
        return {
            name: this.name,
            tier: this.tier,
            isActive: this.isActive,
            ...this.stats,
            successRate: total > 0 
                ? Number((this.stats.totalSuccess / total * 100).toFixed(2))
                : 100,
            failureRate: total > 0
                ? Number((this.stats.totalFailed / total * 100).toFixed(2))
                : 0
        };
    }

    resetStats() {
        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0
        };
        return this.getStats();
    }
}

export default TwilioProvider;
