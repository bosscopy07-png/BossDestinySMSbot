// services/HeroSMSProvider.js
import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

const BASE_PROFIT = 0.10;

class HeroSMSProvider {
    constructor() {
        this.name = 'HERO_SMS';
        this.tier = 'CHEAP';
        this.providerKey = 'hero_sms';
        
        this.baseUrl = config.heroSMS?.baseUrl || 'https://hero-sms.com/api';
        this.apiKey = config.heroSMS?.apiKey;
        this.isActive = !!this.apiKey;
        
        this.endpoints = {
            getNumber: '/get-number',
            checkSMS: '/check-sms',
            cancel: '/cancel',
            finish: '/finish',
            getPrices: '/prices',
            getBalance: '/balance',
            getCountries: '/countries',
            getServices: '/services'
        };

        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0,
            totalCost: 0
        };

        // Service mapping (HeroSMS uses similar names to 5sim)
        this.serviceMap = {
            'WhatsApp': 'whatsapp',
            'Telegram': 'telegram',
            'Facebook': 'facebook',
            'Instagram': 'instagram',
            'Twitter': 'twitter',
            'TikTok': 'tiktok',
            'Binance': 'binance',
            'Coinbase': 'coinbase',
            'Gmail': 'gmail',
            'Outlook': 'outlook',
            'Netflix': 'netflix',
            'Amazon': 'amazon',
            'PayPal': 'paypal',
            'Snapchat': 'snapchat',
            'Discord': 'discord',
            'Spotify': 'spotify',
            'Uber': 'uber',
            'Airbnb': 'airbnb',
            'Google': 'google',
            'Microsoft': 'microsoft',
            'Yahoo': 'yahoo',
            'Rebtel': 'other',
            'Any': 'other',
            'Other': 'other'
        };

        this.countryMap = {
            'US': 'usa', 'UK': 'uk', 'GB': 'uk', 'CA': 'canada',
            'RU': 'russia', 'CN': 'china', 'IN': 'india', 'NG': 'nigeria',
            'DE': 'germany', 'FR': 'france', 'BR': 'brazil', 'MX': 'mexico',
            'ID': 'indonesia', 'PH': 'philippines', 'VN': 'vietnam', 'TH': 'thailand',
            'TR': 'turkey', 'PL': 'poland', 'UA': 'ukraine', 'KZ': 'kazakhstan',
            'RO': 'romania', 'ES': 'spain', 'IT': 'italy', 'NL': 'netherlands',
            'SE': 'sweden', 'NO': 'norway', 'FI': 'finland', 'DK': 'denmark',
            'AU': 'australia', 'JP': 'japan', 'KR': 'south_korea'
        };

        this.reverseCountryMap = Object.fromEntries(
            Object.entries(this.countryMap).map(([iso, hero]) => [hero, iso])
        );

        // Rate limiting
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.minRequestInterval = 500; // 500ms between requests
        this.lastRequestTime = 0;

        if (this.isActive) {
            logger.info('HeroSMSProvider initialized', {
                provider: this.name,
                baseUrl: this.baseUrl
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  REQUEST HELPERS
    // ═══════════════════════════════════════════════════════════

    getHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
    }

    async request(method, endpoint, data = null, timeout = 10000) {
        const url = `${this.baseUrl}${endpoint}`;
        const axiosConfig = {
            method,
            url,
            headers: this.getHeaders(),
            timeout,
            validateStatus: () => true
        };
        
        if (data) axiosConfig.data = data;
        
        const response = await axios(axiosConfig);
        
        if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.data)}`);
        }
        
        return response;
    }

    async queuedRequest(method, endpoint, data = null, timeout = 10000) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ method, endpoint, data, timeout, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessingQueue || this.requestQueue.length === 0) return;
        
        this.isProcessingQueue = true;
        
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.minRequestInterval) {
            await new Promise(r => setTimeout(r, this.minRequestInterval - timeSinceLastRequest));
        }
        
        const { method, endpoint, data, timeout, resolve, reject } = this.requestQueue.shift();
        
        try {
            const result = await this.request(method, endpoint, data, timeout);
            this.lastRequestTime = Date.now();
            resolve(result);
        } catch (error) {
            this.lastRequestTime = Date.now();
            reject(error);
        } finally {
            this.isProcessingQueue = false;
            setTimeout(() => this.processQueue(), this.minRequestInterval);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  PRICING
    // ═══════════════════════════════════════════════════════════

    getDisplayPrice(rawPrice) {
        const price = parseFloat(rawPrice) || 0;
        if (price <= 0) return null;
        return parseFloat((price + BASE_PROFIT).toFixed(4));
    }

    async getPrice(country = 'US', service = 'Any') {
        try {
            const heroCountry = this.mapCountry(country);
            const heroService = this.mapService(service);

            const response = await this.queuedRequest(
                'get', 
                `${this.endpoints.getPrices}?country=${heroCountry}&service=${heroService}`,
                null,
                10000
            );

            const data = response.data;
            
            if (!data || !data.price) {
                return { success: false, error: 'No price data', available: false };
            }

            const rawPrice = parseFloat(data.price);
            const displayPrice = this.getDisplayPrice(rawPrice);
            const stock = data.stock || 0;

            return {
                success: true,
                simPrice: rawPrice,
                displayPrice: displayPrice,
                profit: BASE_PROFIT,
                operator: data.operator || 'any',
                stock: stock,
                available: stock > 0
            };

        } catch (error) {
            logger.error('HeroSMS price check failed', { country, service, error: error.message });
            return { success: false, error: error.message, available: false };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION
    // ═══════════════════════════════════════════════════════════

    async getNumber(country = 'US', service = 'Any', preferredOperator = 'any') {
        const startTime = Date.now();

        try {
            if (!this.isActive) {
                throw new Error('PROVIDER_NOT_CONFIGURED');
            }

            const heroCountry = this.mapCountry(country);
            const heroService = this.mapService(service);

            const response = await this.queuedRequest(
                'get',
                `${this.endpoints.getNumber}?country=${heroCountry}&service=${heroService}&operator=${preferredOperator}`,
                null,
                30000
            );

            const data = response.data;

            if (!data || !data.id || !data.phone) {
                throw new Error('INVALID_RESPONSE: Missing id or phone');
            }

            const simPrice = parseFloat(data.price) || 0;
            const displayPrice = this.getDisplayPrice(simPrice);

            this.updateStats(true, Date.now() - startTime, simPrice);

            return {
                phoneNumber: data.phone.toString(),
                provider: this.name,
                providerNumberId: data.id.toString(),
                country,
                service,
                cost: simPrice,
                displayCost: displayPrice,
                operator: data.operator || preferredOperator,
                expiresAt: new Date(Date.now() + 20 * 60 * 1000),
                isVirtual: true
            };

        } catch (error) {
            this.updateStats(false, Date.now() - startTime, 0);
            logger.error('HeroSMS number acquisition failed', { country, service, error: error.message });
            throw new Error(`HERO_SMS_ERROR: ${error.message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SMS CHECKING
    // ═══════════════════════════════════════════════════════════

    async checkSMS(activationId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            const response = await this.queuedRequest(
                'get',
                `${this.endpoints.checkSMS}?id=${activationId}`,
                null,
                15000
            );

            const data = response.data;

            if (data.status === 'RECEIVED' && data.code) {
                return {
                    success: true,
                    otp: data.code.toString(),
                    status: 'RECEIVED',
                    fullText: data.text || null,
                    receivedAt: new Date()
                };
            }

            if (data.status === 'PENDING') {
                return { success: false, status: 'WAITING', message: 'SMS not yet received' };
            }

            if (data.status === 'EXPIRED' || data.status === 'CANCELLED') {
                return { success: false, status: data.status, message: `Number ${data.status.toLowerCase()}` };
            }

            return { success: false, status: data.status || 'UNKNOWN', message: 'Unknown status' };

        } catch (error) {
            logger.error('HeroSMS SMS check failed', { activationId, error: error.message });
            return { success: false, error: error.message, status: 'ERROR' };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    async cancelNumber(activationId) {
        try {
            const response = await this.queuedRequest(
                'get',
                `${this.endpoints.cancel}?id=${activationId}`,
                null,
                10000
            );
            return { success: true, status: 'CANCELLED', data: response.data };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async finishNumber(activationId) {
        try {
            const response = await this.queuedRequest(
                'get',
                `${this.endpoints.finish}?id=${activationId}`,
                null,
                10000
            );
            return { success: true, status: 'FINISHED', data: response.data };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  AVAILABILITY
    // ═══════════════════════════════════════════════════════════

    async checkAvailability(country, service) {
        const priceResult = await this.getPrice(country, service);
        return {
            available: priceResult.available && priceResult.stock > 0,
            stock: priceResult.stock || 0,
            price: priceResult.simPrice || 0
        };
    }

    async getAvailableCountries(service = 'Any') {
        try {
            const response = await this.queuedRequest(
                'get',
                `${this.endpoints.getCountries}?service=${this.mapService(service)}`,
                null,
                10000
            );

            const countries = (response.data?.countries || []).map(c => ({
                code: this.reverseCountryMap[c.code] || c.code.toUpperCase(),
                heroCode: c.code,
                name: c.name
            }));

            return { success: true, countries, count: countries.length };
        } catch (error) {
            return { success: false, error: error.message, countries: [] };
        }
    }

    async checkBalance() {
        try {
            const response = await this.queuedRequest('get', this.endpoints.getBalance, null, 10000);
            return {
                success: true,
                balance: parseFloat(response.data?.balance) || 0,
                currency: response.data?.currency || 'USD'
            };
        } catch (error) {
            return { success: false, error: error.message, balance: 0 };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  MAPPING HELPERS
    // ═══════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════
    //  STATS
    // ═══════════════════════════════════════════════════════════

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
            totalSent,
            totalSuccess,
            totalFailed,
            successRate: totalSent > 0 ? Number((totalSuccess / totalSent * 100).toFixed(2)) : 100,
            avgResponseTime: Math.round(avgResponseTime),
            totalCost: Number(totalCost.toFixed(4)),
            avgCost: totalSent > 0 ? Number((totalCost / totalSent).toFixed(4)) : 0
        };
    }
}

export default HeroSMSProvider;
