import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class CheapPanelProvider {
    constructor() {
        this.name = 'CHEAP_PANEL';
        this.tier = 'CHEAP';
        
        // 5SIM Configuration (default)
        // Easily switchable to SMSHub, Grizzly, etc.
        this.baseUrl = config.cheapPanel.baseUrl || 'https://5sim.net/v1';
        this.apiKey = config.cheapPanel.apiKey;
        this.isActive = !!this.apiKey;
        
        // Provider-specific endpoints
        this.endpoints = {
            // 5SIM format
            getNumber: '/user/buy/activation',
            checkStatus: '/user/check',
            finish: '/user/finish',
            cancel: '/user/cancel',
            getPrices: '/guest/prices'
        };

        // Stats tracking
        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0,
            totalCost: 0
        };

        // Service mapping (5SIM codes)
        this.serviceMap = {
            'WhatsApp': 'whatsapp',
            'Telegram': 'telegram',
            'Facebook': 'facebook',
            'Instagram': 'instagram',
            'Twitter': 'twitter',
            'TikTok': 'tiktok',
            'Binance': 'binance',
            'Coinbase': 'coinbase',
            'Gmail': 'google',
            'Outlook': 'microsoft',
            'Netflix': 'netflix',
            'Amazon': 'amazon',
            'PayPal': 'paypal',
            'Snapchat': 'snapchat',
            'Discord': 'discord',
            'Spotify': 'spotify',
            'Uber': 'uber',
            'Airbnb': 'airbnb'
        };

        // Country mapping (ISO to provider code)
        this.countryMap = {
            'US': 'usa',
            'UK': 'united kingdom',
            'CA': 'canada',
            'RU': 'russia',
            'CN': 'china',
            'IN': 'india',
            'NG': 'nigeria',
            'DE': 'germany',
            'FR': 'france',
            'BR': 'brazil',
            'MX': 'mexico',
            'ID': 'indonesia',
            'PH': 'philippines',
            'VN': 'vietnam',
            'TH': 'thailand',
            'TR': 'turkey',
            'PL': 'poland',
            'UA': 'ukraine',
            'KZ': 'kazakhstan',
            'RO': 'romania'
        };

        // Operator preference (cheapest first)
        this.operators = ['any', 'virtual', 'mobile'];

        if (this.isActive) {
            logger.info('CheapPanelProvider initialized', {
                provider: this.name,
                baseUrl: this.baseUrl,
                hasKey: !!this.apiKey
            });
        } else {
            logger.warn('CheapPanelProvider disabled - no API key configured');
        }
    }

    // ============================================
    // CORE METHODS (Required by Provider Interface)
    // ============================================

    /**
     * Get a virtual number for receiving SMS
     * @param {string} country - ISO country code (e.g., 'US', 'RU')
     * @param {string} service - Service name (e.g., 'WhatsApp', 'Telegram')
     * @returns {Promise<Object>} Number details
     */
    async getNumber(country = 'US', service = 'Any') {
        const startTime = Date.now();

        try {
            // Validate inputs
            if (!this.isActive) {
                throw new Error('PROVIDER_NOT_CONFIGURED');
            }

            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            logger.info('Requesting number from 5SIM', {
                country: providerCountry,
                service: providerService,
                originalCountry: country,
                originalService: service
            });

            // Build request
            const url = `${this.baseUrl}${this.endpoints.getNumber}/${providerCountry}/${providerService}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 30000,
                validateStatus: (status) => status < 500
            });

            const data = response.data;

            // Handle 5SIM response
            if (data.id && data.phone) {
                const duration = Date.now() - startTime;
                this.updateStats(true, duration, data.price || 0);

                logger.info('Number acquired successfully', {
                    provider: this.name,
                    activationId: data.id,
                    phone: this.maskPhone(data.phone),
                    country: providerCountry,
                    service: providerService,
                    price: data.price,
                    duration
                });

                return {
                    phoneNumber: data.phone,
                    provider: this.name,
                    providerNumberId: data.id.toString(),
                    country: country,
                    service: service,
                    cost: parseFloat(data.price) || 0.02,
                    operator: data.operator || 'any',
                    expiresAt: new Date(Date.now() + 20 * 60 * 1000), // 20 min default
                    isVirtual: true
                };
            }

            // Handle errors from 5SIM
            if (data.error || data.message) {
                throw new Error(`PROVIDER_ERROR: ${data.error || data.message}`);
            }

            throw new Error('INVALID_RESPONSE: No ID or phone in response');

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration, 0);

            logger.error('Failed to acquire number from cheap panel', {
                country,
                service,
                error: error.message,
                response: error.response?.data
            });

            throw this.handleError(error);
        }
    }

    /**
     * Check SMS status for a given activation
     * @param {string} activationId - Provider's activation ID
     * @returns {Promise<Object>} SMS status and OTP if received
     */
    async checkSMS(activationId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            const url = `${this.baseUrl}${this.endpoints.checkStatus}/${activationId}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 15000
            });

            const data = response.data;

            logger.debug('SMS status check', {
                activationId,
                status: data.status,
                hasCode: !!data.code,
                hasText: !!data.text
            });

            // 5SIM status codes:
            // PENDING - waiting for SMS
            // RECEIVED - SMS received
            // CANCELED - cancelled
            // EXPIRED - timed out
            // FINISHED - completed

            if (data.status === 'RECEIVED' || data.status === 'FINISHED') {
                const otp = this.extractOTP(data.code, data.text);
                
                if (otp) {
                    return {
                        success: true,
                        otp: otp,
                        status: 'RECEIVED',
                        fullText: data.text || null,
                        receivedAt: new Date()
                    };
                }

                // SMS received but no clear OTP
                return {
                    success: false,
                    status: 'CHECKING',
                    rawText: data.text,
                    message: 'SMS received but OTP extraction failed'
                };
            }

            if (data.status === 'CANCELED' || data.status === 'CANCELLED') {
                return {
                    success: false,
                    status: 'CANCELLED',
                    message: 'Number was cancelled'
                };
            }

            if (data.status === 'EXPIRED') {
                return {
                    success: false,
                    status: 'TIMEOUT',
                    message: 'Activation expired'
                };
            }

            // Still waiting
            return {
                success: false,
                status: 'WAITING',
                message: `Status: ${data.status}`
            };

        } catch (error) {
            logger.error('SMS check failed', {
                activationId,
                error: error.message,
                response: error.response?.data
            });

            return {
                success: false,
                error: error.message,
                status: 'ERROR'
            };
        }
    }

    /**
     * Cancel/release a number back to provider
     * @param {string} activationId - Provider's activation ID
     * @returns {Promise<Object>} Cancellation result
     */
    async cancelNumber(activationId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            const url = `${this.baseUrl}${this.endpoints.cancel}/${activationId}`;
            
            await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 10000
            });

            logger.info('Number cancelled successfully', {
                activationId,
                provider: this.name
            });

            return { success: true, status: 'CANCELLED' };

        } catch (error) {
            // 5SIM might return error if already finished/expired
            // That's fine — number is released either way
            logger.warn('Cancel request (may be already released)', {
                activationId,
                error: error.message
            });

            return { 
                success: true, 
                status: 'ALREADY_RELEASED',
                note: error.message 
            };
        }
    }

    /**
     * Finish/completed a successful activation (optional, for some providers)
     * @param {string} activationId 
     */
    async finishNumber(activationId) {
        try {
            const url = `${this.baseUrl}${this.endpoints.finish}/${activationId}`;
            
            await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 10000
            });

            logger.info('Activation marked as finished', { activationId });

        } catch (error) {
            logger.warn('Finish request failed', {
                activationId,
                error: error.message
            });
        }
    }

    // ============================================
    // PRICING & AVAILABILITY
    // ============================================

    /**
     * Get current prices for a country/service
     * @param {string} country 
     * @param {string} service 
     * @returns {Promise<Object>} Price info
     */
    async getPrice(country = 'US', service = 'Any') {
        try {
            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            const url = `${this.baseUrl}${this.endpoints.getPrices}/${providerCountry}/${providerService}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 15000
            });

            return {
                success: true,
                country,
                service,
                prices: response.data,
                cheapest: this.findCheapestOperator(response.data)
            };

        } catch (error) {
            logger.error('Failed to get prices', {
                country,
                service,
                error: error.message
            });

            return {
                success: false,
                error: error.message
            };
        }
    }

    findCheapestOperator(prices) {
        if (!prices || typeof prices !== 'object') return null;
        
        let cheapest = null;
        let minPrice = Infinity;

        for (const [operator, data] of Object.entries(prices)) {
            const price = parseFloat(data.cost) || parseFloat(data.price) || Infinity;
            if (price < minPrice) {
                minPrice = price;
                cheapest = { operator, price, ...data };
            }
        }

        return cheapest;
    }

    // ============================================
    // UTILITY METHODS
    // ============================================

    getHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
    }

    mapService(service) {
        const mapped = this.serviceMap[service];
        if (!mapped) {
            logger.warn(`Unknown service "${service}", using "other"`, {
                available: Object.keys(this.serviceMap)
            });
            return 'other';
        }
        return mapped;
    }

    mapCountry(country) {
        const mapped = this.countryMap[country];
        if (!mapped) {
            logger.warn(`Unknown country "${country}", using "russia"`, {
                available: Object.keys(this.countryMap)
            });
            return 'russia'; // Default fallback (usually cheapest)
        }
        return mapped;
    }

    extractOTP(code, text) {
        // Priority 1: Explicit code from provider
        if (code && /^\d{4,8}$/.test(code.trim())) {
            return code.trim();
        }

        // Priority 2: Extract from SMS text
        if (!text) return null;

        // Common OTP patterns
        const patterns = [
            /\b\d{4,8}\b/,                          // Generic 4-8 digits
            /code[:\s]+(\d{4,8})/i,                 // "code: 123456"
            /otp[:\s]+(\d{4,8})/i,                  // "OTP: 123456"
            /verification[:\s]+(\d{4,8})/i,         // "verification: 123456"
            /(\d{4,8})[:\s]*is your/i,              // "123456 is your..."
            /(\d{4,8})[:\s]*is the/i,              // "123456 is the..."
            /(\d{4,8})[:\s]*验证码/i,               // Chinese verification
            /验证码[:\s]*(\d{4,8})/i,               // Chinese verification code
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const otp = match[1] || match[0];
                if (/^\d{4,8}$/.test(otp)) {
                    return otp;
                }
            }
        }

        // Last resort: find any 4-8 digit sequence
        const digits = text.match(/\b\d{4,8}\b/g);
        if (digits && digits.length > 0) {
            // Return the last one (usually the OTP, not the phone number)
            return digits[digits.length - 1];
        }

        return null;
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }

    handleError(error) {
        const message = error.message || '';

        // Categorized errors
        const errorMap = {
            'NO_NUMBERS': { recoverable: true, retryAfter: 5000, message: 'No numbers available' },
            'NO_BALANCE': { recoverable: false, message: 'Insufficient panel balance' },
            'BAD_SERVICE': { recoverable: false, message: 'Invalid service selected' },
            'BAD_COUNTRY': { recoverable: false, message: 'Invalid country selected' },
            'BAD_KEY': { recoverable: false, message: 'Invalid API key' },
            'PROVIDER_NOT_CONFIGURED': { recoverable: false, message: 'Provider not configured' },
            'INVALID_RESPONSE': { recoverable: true, retryAfter: 3000, message: 'Invalid provider response' },
            'TIMEOUT': { recoverable: true, retryAfter: 10000, message: 'Provider timeout' }
        };

        for (const [key, value] of Object.entries(errorMap)) {
            if (message.includes(key)) {
                return new Error(`${value.message} (${key})`);
            }
        }

        // Default: assume recoverable
        return new Error(`PROVIDER_ERROR: ${message}`);
    }

    // ============================================
    // STATS & MONITORING
    // ============================================

    updateStats(success, duration, cost = 0) {
        this.stats.totalSent++;
        this.stats.totalCost += cost;

        if (success) {
            this.stats.totalSuccess++;
        } else {
            this.stats.totalFailed++;
        }

        // Rolling average response time
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
            baseUrl: this.baseUrl,
            totalSent: this.stats.totalSent,
            totalSuccess: this.stats.totalSuccess,
            totalFailed: this.stats.totalFailed,
            successRate: this.stats.totalSent > 0
                ? ((this.stats.totalSuccess / this.stats.totalSent) * 100).toFixed(2)
                : 100,
            avgResponseTime: Math.round(this.stats.avgResponseTime),
            totalCost: this.stats.totalCost.toFixed(4),
            avgCost: this.stats.totalSent > 0
                ? (this.stats.totalCost / this.stats.totalSent).toFixed(4)
                : 0
        };
    }

    // ============================================
    // PROVIDER SWITCHING (For future flexibility)
    // ============================================

    /**
     * Switch to a different cheap panel provider
     * @param {string} providerName - '5sim', 'smshub', 'grizzly'
     */
    switchProvider(providerName) {
        const configs = {
            '5sim': {
                baseUrl: 'https://5sim.net/v1',
                endpoints: {
                    getNumber: '/user/buy/activation',
                    checkStatus: '/user/check',
                    finish: '/user/finish',
                    cancel: '/user/cancel',
                    getPrices: '/guest/prices'
                }
            },
            'smshub': {
                baseUrl: 'https://smshub.org/api',
                endpoints: {
                    getNumber: '/getNumber',
                    checkStatus: '/getStatus',
                    finish: '/setStatus',
                    cancel: '/setStatus',
                    getPrices: '/getPrices'
                }
            },
            'grizzly': {
                baseUrl: 'https://grizzlysms.com/stubs/handler_api.php',
                endpoints: {
                    getNumber: '/getNumber',
                    checkStatus: '/getStatus',
                    finish: '/setStatus',
                    cancel: '/setStatus',
                    getPrices: '/getPrices'
                }
            }
        };

        const config = configs[providerName.toLowerCase()];
        if (!config) {
            throw new Error(`Unknown provider: ${providerName}`);
        }

        this.baseUrl = config.baseUrl;
        this.endpoints = config.endpoints;

        logger.info(`Switched to provider: ${providerName}`, {
            baseUrl: this.baseUrl
        });
    }
}

export default CheapPanelProvider;
                
