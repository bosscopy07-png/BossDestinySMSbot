import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class CheapPanelProvider {
    constructor() {
        this.name = 'CHEAP_PANEL';
        this.tier = 'CHEAP';
        
        this.baseUrl = config.cheapPanel?.baseUrl || 'https://5sim.net/v1';
        this.apiKey = config.cheapPanel?.apiKey;
        this.isActive = !!this.apiKey;
        
        this.endpoints = {
            getNumber: '/user/buy/activation',
            checkStatus: '/user/check',
            finish: '/user/finish',
            cancel: '/user/cancel',
            getPrices: '/guest/prices',
            getBalance: '/user/profile'
        };

        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0,
            totalCost: 0
        };

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

        this.fakeNumbers = new Set([
            '0201', '1234567890', '1111111111', '0000000000',
            '9999999999', '123456789', '0123456789', '0000000',
            '12345', '11111', '99999', '00000', '1', '12', '123'
        ]);

        this.errorMap = {
            'NO_NUMBERS': { recoverable: true, retryAfter: 5000, message: 'No numbers available' },
            'NO_BALANCE': { recoverable: false, message: 'Insufficient panel balance' },
            'BAD_SERVICE': { recoverable: false, message: 'Invalid service selected' },
            'BAD_COUNTRY': { recoverable: false, message: 'Invalid country selected' },
            'BAD_KEY': { recoverable: false, message: 'Invalid API key' },
            'PROVIDER_NOT_CONFIGURED': { recoverable: false, message: 'Provider not configured' },
            'INVALID_RESPONSE': { recoverable: true, retryAfter: 3000, message: 'Invalid provider response' },
            'FAKE_NUMBER_REJECTED': { recoverable: true, retryAfter: 2000, message: 'Provider returned test number, retrying' },
            'INVALID_PHONE_LENGTH': { recoverable: true, retryAfter: 2000, message: 'Invalid phone number from provider' },
            'INVALID_ACTIVATION_ID': { recoverable: false, message: 'Invalid activation ID from provider' },
            'TIMEOUT': { recoverable: true, retryAfter: 10000, message: 'Provider timeout' },
            'CONNECTION_ERROR': { recoverable: true, retryAfter: 5000, message: 'Connection error' }
        };

        if (this.isActive) {
            this.checkBalance().catch(err => 
                logger.warn('Initial balance check failed', { error: err.message })
            );
            logger.info('CheapPanelProvider initialized', {
                provider: this.name,
                baseUrl: this.baseUrl,
                hasKey: !!this.apiKey
            });
        } else {
            logger.warn('CheapPanelProvider disabled - no API key configured');
        }
    }

    async checkBalance() {
        try {
            const response = await this.request('get', this.endpoints.getBalance);
            const data = response.data;
            
            logger.info('5SIM account balance', {
                balance: data?.balance,
                rating: data?.rating,
                email: data?.email,
                currency: data?.currency || 'RUB'
            });
            
            return {
                success: true,
                balance: parseFloat(data?.balance) || 0,
                currency: data?.currency || 'RUB',
                rating: data?.rating
            };
        } catch (error) {
            logger.error('Failed to check 5SIM balance', { error: error.message });
            return { success: false, error: error.message };
        }
    }

    async getNumber(country = 'US', service = 'Any') {
        const startTime = Date.now();

        try {
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

            const endpoint = `${this.endpoints.getNumber}/${providerCountry}/${providerService}`;
            const response = await this.request('get', endpoint, null, 30000);
            const data = response.data;
            const statusCode = response.status;

            logger.debug('5SIM raw response', {
                statusCode,
                hasId: !!data?.id,
                hasPhone: !!data?.phone,
                phone: data?.phone,
                error: data?.error,
                message: data?.message
            });

            if (statusCode >= 400) {
                const errorMsg = data?.error || data?.message || `HTTP ${statusCode}`;
                throw new Error(`PROVIDER_ERROR: ${errorMsg}`);
            }

            if (!data || typeof data !== 'object') {
                throw new Error('INVALID_RESPONSE: Empty or non-object response');
            }

            if (!data.id) {
                throw new Error(`INVALID_RESPONSE: Missing id. Response: ${JSON.stringify(data)}`);
            }

            if (!data.phone) {
                throw new Error(`INVALID_RESPONSE: Missing phone. Response: ${JSON.stringify(data)}`);
            }

            const phoneStr = data.phone.toString().trim();
            const activationId = data.id.toString().trim();

            if (this.isFakeNumber(phoneStr)) {
                logger.error('5SIM returned fake number', { phone: phoneStr, activationId });
                await this.cancelNumber(activationId).catch(() => {});
                throw new Error(`FAKE_NUMBER_REJECTED: ${phoneStr}`);
            }

            if (phoneStr.length < 7 || phoneStr.length > 15) {
                logger.error('5SIM returned invalid phone length', { phone: phoneStr, length: phoneStr.length });
                await this.cancelNumber(activationId).catch(() => {});
                throw new Error(`INVALID_PHONE_LENGTH: ${phoneStr} (${phoneStr.length} digits)`);
            }

            if (!/^\d+$/.test(activationId)) {
                throw new Error(`INVALID_ACTIVATION_ID: ${activationId}`);
            }

            const duration = Date.now() - startTime;
            this.updateStats(true, duration, parseFloat(data.price) || 0);

            logger.info('Number acquired from 5SIM', {
                activationId,
                phone: this.maskPhone(phoneStr),
                country: providerCountry,
                service: providerService,
                price: data.price,
                operator: data.operator,
                duration
            });

            return {
                phoneNumber: phoneStr,
                provider: this.name,
                providerNumberId: activationId,
                country,
                service,
                cost: parseFloat(data.price) || 0.02,
                operator: data.operator || 'any',
                expiresAt: new Date(Date.now() + 20 * 60 * 1000),
                isVirtual: true
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration, 0);

            logger.error('5SIM number acquisition failed', {
                country,
                service,
                error: error.message
            });

            throw this.handleError(error);
        }
    }

    async checkSMS(activationId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            if (!activationId || !/^\d+$/.test(activationId.toString())) {
                return { success: false, error: 'INVALID_ACTIVATION_ID' };
            }

            const endpoint = `${this.endpoints.checkStatus}/${activationId}`;
            const response = await this.request('get', endpoint, null, 15000);
            const data = response.data;

            if (response.status >= 400) {
                return {
                    success: false,
                    error: data?.error || `HTTP ${response.status}`,
                    status: 'ERROR'
                };
            }

            logger.debug('SMS status check', {
                activationId,
                status: data?.status,
                hasCode: !!data?.code,
                hasText: !!data?.text
            });

            const status = (data?.status || '').toUpperCase();

            if (status === 'RECEIVED' || status === 'FINISHED') {
                const otp = this.extractOTP(data.code, data.text);
                
                if (otp) {
                    return {
                        success: true,
                        otp,
                        status: 'RECEIVED',
                        fullText: data.text || null,
                        receivedAt: new Date()
                    };
                }

                return {
                    success: false,
                    status: 'CHECKING',
                    rawText: data.text,
                    message: 'SMS received but OTP extraction failed'
                };
            }

            if (status === 'CANCELED' || status === 'CANCELLED') {
                return { success: false, status: 'CANCELLED', message: 'Number was cancelled' };
            }

            if (status === 'EXPIRED') {
                return { success: false, status: 'TIMEOUT', message: 'Activation expired' };
            }

            return { success: false, status: 'WAITING', message: `Status: ${data.status}` };

        } catch (error) {
            logger.error('5SMS check failed', { activationId, error: error.message });
            return { success: false, error: error.message, status: 'ERROR' };
        }
    }

    async cancelNumber(activationId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            if (!activationId) {
                return { success: false, error: 'MISSING_ACTIVATION_ID' };
            }

            const endpoint = `${this.endpoints.cancel}/${activationId}`;
            await this.request('get', endpoint);

            logger.info('Number cancelled successfully', { activationId, provider: this.name });

            return { success: true, status: 'CANCELLED' };

        } catch (error) {
            if (error.response?.status === 404 || error.message?.includes('not found')) {
                logger.info('Number already released or not found', { activationId });
                return { success: true, status: 'ALREADY_RELEASED' };
            }
            logger.warn('Cancel request failed', { activationId, error: error.message });
            return { success: false, error: error.message, status: 'ERROR' };
        }
    }

    async finishNumber(activationId) {
        try {
            if (!activationId) {
                return { success: false, error: 'MISSING_ACTIVATION_ID' };
            }
            
            const endpoint = `${this.endpoints.finish}/${activationId}`;
            await this.request('get', endpoint);

            logger.info('Activation marked as finished', { activationId });
            return { success: true, status: 'FINISHED' };

        } catch (error) {
            logger.warn('Finish request failed', { activationId, error: error.message });
            return { success: false, error: error.message };
        }
    }

    async getPrices(country = 'US', service = 'Any') {
        try {
            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);
            const endpoint = `${this.endpoints.getPrices}/${providerCountry}/${providerService}`;
            
            const response = await this.request('get', endpoint);

            return {
                success: true,
                prices: response.data
            };
        } catch (error) {
            logger.error('Failed to get prices', { country, service, error: error.message });
            return { success: false, error: error.message };
        }
    }

    async request(method, endpoint, data = null, timeout = 10000) {
        const url = `${this.baseUrl}${endpoint}`;
        const config = {
            method,
            url,
            headers: this.getHeaders(),
            timeout,
            validateStatus: () => true
        };
        
        if (data) config.data = data;
        
        return axios(config);
    }

    isFakeNumber(phone) {
        if (!phone) return true;
        const clean = phone.toString().replace(/\D/g, '');
        return this.fakeNumbers.has(clean) || this.fakeNumbers.has(phone);
    }

    mapService(service) {
        if (!service || service === 'Any') return 'other';
        return this.serviceMap[service] || 'other';
    }

    mapCountry(country) {
        if (!country) throw new Error('BAD_COUNTRY: Country required');
        const mapped = this.countryMap[country.toUpperCase()];
        if (!mapped) throw new Error(`BAD_COUNTRY: ${country} not supported`);
        return mapped;
    }

    extractOTP(code, text) {
        if (code && /^\d{4,8}$/.test(code.toString().trim())) {
            return code.toString().trim();
        }

        if (!text) return null;

        const patterns = [
            /\b\d{4,8}\b/,
            /code[:\s]+(\d{4,8})/i,
            /otp[:\s]+(\d{4,8})/i,
            /verification[:\s]+(\d{4,8})/i,
            /(\d{4,8})[:\s]*is your/i,
            /(\d{4,8})[:\s]*is the/i,
            /验证码[:\s]*(\d{4,8})/i,
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const otp = match[1] || match[0];
                if (/^\d{4,8}$/.test(otp)) return otp;
            }
        }

        const digits = text.match(/\b\d{4,8}\b/g);
        if (digits?.length > 0) return digits[digits.length - 1];

        return null;
    }

    getHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }

    handleError(error) {
        const message = error.message || '';

        for (const [key, value] of Object.entries(this.errorMap)) {
            if (message.includes(key)) {
                return new Error(`${value.message} (${key})`);
            }
        }

        return new Error(`PROVIDER_ERROR: ${message}`);
    }

    updateStats(success, duration, cost = 0) {
        this.stats.totalSent++;
        this.stats.totalCost += cost;
        if (success) this.stats.totalSuccess++;
        else this.stats.totalFailed++;
        this.stats.avgResponseTime = (
            (this.stats.avgResponseTime * (this.stats.totalSent - 1) + duration)
            / this.stats.totalSent
        );
    }

    getStats() {
        const { totalSent, totalSuccess, totalFailed, avgResponseTime, totalCost } = this.stats;
        
        return {
            name: this.name,
            tier: this.tier,
            isActive: this.isActive,
            baseUrl: this.baseUrl,
            totalSent,
            totalSuccess,
            totalFailed,
            successRate: totalSent > 0
                ? Number((totalSuccess / totalSent * 100).toFixed(2))
                : 100,
            failureRate: totalSent > 0
                ? Number((totalFailed / totalSent * 100).toFixed(2))
                : 0,
            avgResponseTime: Math.round(avgResponseTime),
            totalCost: Number(totalCost.toFixed(4)),
            avgCost: totalSent > 0
                ? Number((totalCost / totalSent).toFixed(4))
                : 0
        };
    }

    resetStats() {
        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0,
            totalCost: 0
        };
        return this.getStats();
    }
}

export default CheapPanelProvider;
              
