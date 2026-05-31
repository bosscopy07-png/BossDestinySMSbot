// ═══════════════════════════════════════════════════════════════════════════════
//  services/SMSPoolProvider.js — SMSPool API Integration (Primary Cheap Provider)
//  Base URL: https://api.smspool.net
//  Docs: https://documenter.getpostman.com/view/30155063/2s9YXmZ1JY
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

const BASE_PROFIT = 0.10;

/**
 * SMSPoolProvider — Primary cheap tier provider
 * 
 * API Endpoints:
 *   GET  /country/retrieve_all          — List all countries
 *   GET  /service/retrieve_all          — List all services
 *   GET  /request/price                 — Get price for country+service
 *   POST /purchase/sms                  — Buy a number
 *   GET  /sms/check                     — Check SMS (legacy, use /request/active)
 *   GET  /request/active                — Check active orders (recommended)
 *   POST /sms/cancel                    — Cancel order
 *   GET  /balance                       — Check balance
 * 
 * Rate Limits:
 *   Standard: 32 req/sec
 *   Failed requests >300/sec: 1 min ban
 */
class SMSPoolProvider {
    constructor() {
        this.name = 'SMSPool';
        this.tier = 'CHEAP';
        this.providerKey = 'smspool';
        
        this.baseUrl = 'https://api.smspool.net';
        this.apiKey = config.smspool?.apiKey;
        this.isActive = !!this.apiKey;
        
        this.endpoints = {
            getCountries: '/country/retrieve_all',
            getServices: '/service/retrieve_all',
            getPrice: '/request/price',
            purchaseSMS: '/purchase/sms',
            checkSMS: '/sms/check',
            checkActive: '/request/active',
            cancelSMS: '/sms/cancel',
            getBalance: '/balance'
        };

        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0,
            totalCost: 0
        };

        // Service name mapping: Display Name -> SMSPool Service Name
        this.serviceMap = {
            'WhatsApp': 'whatsapp',
            'Telegram': 'telegram',
            'Facebook': 'facebook',
            'Instagram': 'instagram',
            'Twitter': 'twitter',
            'X': 'twitter',
            'TikTok': 'tiktok',
            'Binance': 'binance',
            'Coinbase': 'coinbase',
            'Gmail': 'google',
            'Google': 'google',
            'Outlook': 'microsoft',
            'Microsoft': 'microsoft',
            'Yahoo': 'yahoo',
            'Netflix': 'netflix',
            'Amazon': 'amazon',
            'PayPal': 'paypal',
            'Snapchat': 'snapchat',
            'Discord': 'discord',
            'Spotify': 'spotify',
            'Uber': 'uber',
            'Airbnb': 'airbnb',
            'Steam': 'steam',
            'Tinder': 'tinder',
            'Signal': 'signal',
            'Rebtel': 'not_listed',     // SMSPool uses "not_listed" for unknown services
            'Any': 'not_listed',
            'Other': 'not_listed',
            'Not Listed': 'not_listed'
        };

        // Country mapping: ISO Code -> SMSPool Country ID/Name
        // SMSPool accepts both numeric IDs and country names
        this.countryMap = {
            'US': 'US', 'USA': 'US', 'UNITED STATES': 'US',
            'UK': 'UK', 'GB': 'UK', 'UNITED KINGDOM': 'UK', 'ENGLAND': 'UK', 'GREAT BRITAIN': 'UK',
            'CA': 'CA', 'CANADA': 'CA',
            'RU': 'RU', 'RUSSIA': 'RU',
            'CN': 'CN', 'CHINA': 'CN',
            'IN': 'IN', 'INDIA': 'IN',
            'NG': 'NG', 'NIGERIA': 'NG',
            'DE': 'DE', 'GERMANY': 'DE',
            'FR': 'FR', 'FRANCE': 'FR',
            'BR': 'BR', 'BRAZIL': 'BR',
            'MX': 'MX', 'MEXICO': 'MX',
            'ID': 'ID', 'INDONESIA': 'ID',
            'PH': 'PH', 'PHILIPPINES': 'PH',
            'VN': 'VN', 'VIETNAM': 'VN',
            'TH': 'TH', 'THAILAND': 'TH',
            'TR': 'TR', 'TURKEY': 'TR',
            'PL': 'PL', 'POLAND': 'PL',
            'UA': 'UA', 'UKRAINE': 'UA',
            'KZ': 'KZ', 'KAZAKHSTAN': 'KZ',
            'RO': 'RO', 'ROMANIA': 'RO',
            'ES': 'ES', 'SPAIN': 'ES',
            'IT': 'IT', 'ITALY': 'IT',
            'NL': 'NL', 'NETHERLANDS': 'NL',
            'SE': 'SE', 'SWEDEN': 'SE',
            'NO': 'NO', 'NORWAY': 'NO',
            'FI': 'FI', 'FINLAND': 'FI',
            'DK': 'DK', 'DENMARK': 'DK',
            'AU': 'AU', 'AUSTRALIA': 'AU',
            'JP': 'JP', 'JAPAN': 'JP',
            'KR': 'KR', 'SOUTH KOREA': 'KR', 'KOREA': 'KR',
            'SG': 'SG', 'SINGAPORE': 'SG',
            'MY': 'MY', 'MALAYSIA': 'MY',
            'ZA': 'ZA', 'SOUTH AFRICA': 'ZA',
            'EG': 'EG', 'EGYPT': 'EG',
            'SA': 'SA', 'SAUDI ARABIA': 'SA',
            'AE': 'AE', 'UAE': 'AE',
            'IL': 'IL', 'ISRAEL': 'IL',
            'BE': 'BE', 'BELGIUM': 'BE',
            'AT': 'AT', 'AUSTRIA': 'AT',
            'CH': 'CH', 'SWITZERLAND': 'CH',
            'PT': 'PT', 'PORTUGAL': 'PT',
            'GR': 'GR', 'GREECE': 'GR',
            'CZ': 'CZ', 'CZECH': 'CZ', 'CZECH REPUBLIC': 'CZ',
            'HU': 'HU', 'HUNGARY': 'HU',
            'SK': 'SK', 'SLOVAKIA': 'SK',
            'BG': 'BG', 'BULGARIA': 'BG',
            'HR': 'HR', 'CROATIA': 'HR',
            'SI': 'SI', 'SLOVENIA': 'SI',
            'LT': 'LT', 'LITHUANIA': 'LT',
            'LV': 'LV', 'LATVIA': 'LV',
            'EE': 'EE', 'ESTONIA': 'EE',
            'MD': 'MD', 'MOLDOVA': 'MD',
            'GE': 'GE', 'GEORGIA': 'GE',
            'AM': 'AM', 'ARMENIA': 'AM',
            'AZ': 'AZ', 'AZERBAIJAN': 'AZ',
            'BY': 'BY', 'BELARUS': 'BY',
            'KG': 'KG', 'KYRGYZSTAN': 'KG',
            'TJ': 'TJ', 'TAJIKISTAN': 'TJ',
            'TM': 'TM', 'TURKMENISTAN': 'TM',
            'UZ': 'UZ', 'UZBEKISTAN': 'UZ',
            'AL': 'AL', 'ALBANIA': 'AL',
            'BA': 'BA', 'BOSNIA': 'BA',
            'MK': 'MK', 'MACEDONIA': 'MK',
            'ME': 'ME', 'MONTENEGRO': 'ME',
            'RS': 'RS', 'SERBIA': 'RS',
            'XK': 'XK', 'KOSOVO': 'XK'
        };

        // Cache for countries and services (static data)
        this._countriesCache = null;
        this._servicesCache = null;
        this._countriesCacheTime = 0;
        this._servicesCacheTime = 0;
        this._staticCacheTtl = 5 * 60 * 1000; // 5 minutes

        // Cache for prices (volatile data)
        this._priceCache = new Map();
        this._priceCacheTtl = 30 * 1000; // 30 seconds

        // Rate limiting: Token bucket
        this._maxRequestsPerSecond = 25; // Stay under 32/sec limit
        this._tokens = this._maxRequestsPerSecond;
        this._lastTokenRefill = Date.now();
        this._tokenInterval = 1000 / this._maxRequestsPerSecond;

        // Request queue for when tokens are exhausted
        this._requestQueue = [];
        this._isProcessingQueue = false;

        // Order status mapping
        this.orderStatuses = {
            1: 'PENDING',      // Order is pending
            2: 'EXPIRED',      // Order expired (no SMS received)
            3: 'COMPLETED',    // SMS received successfully
            4: 'RESEND',       // Resend requested
            5: 'CANCELLED',    // Order cancelled
            6: 'REFUNDED',     // Order refunded
            7: 'PROCESSING',   // Order is being processed
            8: 'ACTIVATING'    // Number is being activated
        };

        if (this.isActive) {
            this._preloadStaticData();
            logger.info('SMSPoolProvider initialized', {
                provider: this.name,
                baseUrl: this.baseUrl,
                hasKey: !!this.apiKey
            });
        } else {
            logger.warn('SMSPoolProvider disabled - no API key configured');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  TOKEN BUCKET RATE LIMITER
    // ═══════════════════════════════════════════════════════════

    _refillTokens() {
        const now = Date.now();
        const timePassed = now - this._lastTokenRefill;
        const tokensToAdd = Math.floor(timePassed / this._tokenInterval);
        
        if (tokensToAdd > 0) {
            this._tokens = Math.min(this._maxRequestsPerSecond, this._tokens + tokensToAdd);
            this._lastTokenRefill = now;
        }
    }

    async _acquireToken() {
        this._refillTokens();
        
        if (this._tokens > 0) {
            this._tokens--;
            return true;
        }
        
        // Wait for next token
        const waitTime = this._tokenInterval - (Date.now() - this._lastTokenRefill) % this._tokenInterval;
        await new Promise(r => setTimeout(r, waitTime + 10));
        return this._acquireToken();
    }

    // ═══════════════════════════════════════════════════════════
    //  REQUEST HELPER
    // ═══════════════════════════════════════════════════════════

    async request(method, endpoint, params = null, data = null, timeout = 15000) {
        await this._acquireToken();

        const url = `${this.baseUrl}${endpoint}`;
        const axiosConfig = {
            method,
            url,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            timeout,
            validateStatus: () => true
        };

        if (params) axiosConfig.params = params;
        if (data) axiosConfig.data = data;

        const startTime = Date.now();
        const response = await axios(axiosConfig);
        const duration = Date.now() - startTime;

        // Log slow requests
        if (duration > 5000) {
            logger.warn('SMSPool slow request', { endpoint, duration });
        }

        // Handle rate limit (429)
        if (response.status === 429) {
            logger.error('SMSPool rate limited (429)', { endpoint });
            // Back off for 60 seconds
            this._tokens = 0;
            this._lastTokenRefill = Date.now() + 60000;
            throw new Error('RATE_LIMITED: SMSPool rate limit exceeded, backing off 60s');
        }

        // Handle auth errors
        if (response.status === 401 || response.status === 403) {
            throw new Error('UNAUTHORIZED: Invalid SMSPool API key');
        }

        // Handle server errors
        if (response.status >= 500) {
            throw new Error(`SERVER_ERROR: SMSPool returned ${response.status}`);
        }

        // Handle client errors
        if (response.status >= 400) {
            const errorMsg = response.data?.message || response.data?.error || `HTTP ${response.status}`;
            throw new Error(`API_ERROR: ${errorMsg}`);
        }

        return response;
    }

    // ═══════════════════════════════════════════════════════════
    //  STATIC DATA PRELOADING
    // ═══════════════════════════════════════════════════════════

    async _preloadStaticData() {
        try {
            await Promise.all([
                this._loadCountries(),
                this._loadServices()
            ]);
            logger.info('SMSPool static data preloaded', {
                countries: this._countriesCache?.length || 0,
                services: this._servicesCache?.length || 0
            });
        } catch (error) {
            logger.warn('SMSPool static data preload failed', { error: error.message });
        }
    }

    async _loadCountries() {
        const now = Date.now();
        if (this._countriesCache && (now - this._countriesCacheTime) < this._staticCacheTtl) {
            return this._countriesCache;
        }

        const response = await this.request('get', this.endpoints.getCountries);
        this._countriesCache = response.data || [];
        this._countriesCacheTime = now;
        return this._countriesCache;
    }

    async _loadServices() {
        const now = Date.now();
        if (this._servicesCache && (now - this._servicesCacheTime) < this._staticCacheTtl) {
            return this._servicesCache;
        }

        const response = await this.request('get', this.endpoints.getServices);
        this._servicesCache = response.data || [];
        this._servicesCacheTime = now;
        return this._servicesCache;
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
            const poolCountry = this.mapCountry(country);
            const poolService = this.mapService(service);

            // Check price cache
            const cacheKey = `${poolCountry}:${poolService}`;
            const cached = this._priceCache.get(cacheKey);
            if (cached && (Date.now() - cached.time) < this._priceCacheTtl) {
                return cached.data;
            }

            const response = await this.request(
                'get',
                this.endpoints.getPrice,
                { country: poolCountry, service: poolService },
                null,
                10000
            );

            const data = response.data;

            // SMSPool price endpoint returns price info
            if (!data || data.success === 0) {
                const errorMsg = data?.message || 'Service not available';
                return { success: false, error: errorMsg, available: false };
            }

            const rawPrice = parseFloat(data.price) || parseFloat(data.cost) || 0;
            const displayPrice = this.getDisplayPrice(rawPrice);
            const stock = parseInt(data.stock) || 0;

            const result = {
                success: true,
                simPrice: rawPrice,
                displayPrice: displayPrice,
                profit: BASE_PROFIT,
                operator: data.pool || 'default',
                stock: stock,
                available: stock > 0 && rawPrice > 0,
                pool: data.pool,
                country: poolCountry,
                service: poolService
            };

            // Cache the result
            this._priceCache.set(cacheKey, { data: result, time: Date.now() });

            return result;

        } catch (error) {
            logger.error('SMSPool price check failed', { country, service, error: error.message });
            return { success: false, error: error.message, available: false };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION
    // ═══════════════════════════════════════════════════════════

    async getNumber(country = 'US', service = 'Any', preferredPool = null) {
        const startTime = Date.now();

        try {
            if (!this.isActive) {
                throw new Error('PROVIDER_NOT_CONFIGURED');
            }

            const poolCountry = this.mapCountry(country);
            const poolService = this.mapService(service);

            // Check balance first
            const balance = await this.checkBalance();
            if (!balance.success || parseFloat(balance.balance) <= 0) {
                throw new Error('NO_BALANCE: Insufficient SMSPool balance');
            }

            const params = {
                country: poolCountry,
                service: poolService
            };

            // Optional: specify pool (quality tier)
            if (preferredPool) {
                params.pool = preferredPool;
            }

            // Optional: max price limit
            params.max_price = 2.00;

            const response = await this.request(
                'post',
                this.endpoints.purchaseSMS,
                null,
                params,
                30000
            );

            const data = response.data;

            // SMSPool returns success: 1 on success
            if (!data || data.success !== 1) {
                const errorMsg = data?.message || 'Purchase failed';
                
                if (errorMsg.toLowerCase().includes('no numbers') || 
                    errorMsg.toLowerCase().includes('out of stock')) {
                    throw new Error('NO_NUMBERS: SMSPool has no stock for this service/country');
                }
                if (errorMsg.toLowerCase().includes('not enough') ||
                    errorMsg.toLowerCase().includes('balance')) {
                    throw new Error('NO_BALANCE: ' + errorMsg);
                }
                if (errorMsg.toLowerCase().includes('not available')) {
                    throw new Error('NOT_AVAILABLE: ' + errorMsg);
                }
                
                throw new Error('PURCHASE_FAILED: ' + errorMsg);
            }

            if (!data.number || !data.order_id) {
                throw new Error('INVALID_RESPONSE: Missing number or order_id');
            }

            const simPrice = parseFloat(data.price) || 0;
            const displayPrice = this.getDisplayPrice(simPrice);

            this.updateStats(true, Date.now() - startTime, simPrice);

            logger.info('SMSPool number acquired', {
                orderId: data.order_id,
                number: this.maskPhone(data.number),
                country: poolCountry,
                service: poolService,
                pool: data.pool,
                simPrice,
                displayPrice
            });

            return {
                phoneNumber: data.number.toString(),
                provider: this.name,
                providerNumberId: data.order_id.toString(),
                country,
                service,
                cost: simPrice,
                displayCost: displayPrice,
                operator: data.pool || 'default',
                pool: data.pool,
                expiresIn: data.expires_in || 600, // seconds
                expiresAt: new Date(Date.now() + (data.expires_in || 600) * 1000),
                isVirtual: true
            };

        } catch (error) {
            this.updateStats(false, Date.now() - startTime, 0);
            logger.error('SMSPool number acquisition failed', { country, service, error: error.message });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SMS CHECKING
    // ═══════════════════════════════════════════════════════════

    async checkSMS(orderId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            if (!orderId) {
                return { success: false, error: 'MISSING_ORDER_ID' };
            }

            // Use /request/active instead of /sms/check (recommended by SMSPool)
            const response = await this.request(
                'get',
                this.endpoints.checkActive,
                null,
                null,
                15000
            );

            const orders = response.data || [];
            const order = orders.find(o => o.order_id === orderId || o.id === orderId);

            if (!order) {
                // Fallback to legacy check
                return this._legacyCheckSMS(orderId);
            }

            const statusCode = parseInt(order.status);
            const statusText = this.orderStatuses[statusCode] || 'UNKNOWN';

            // Status 3 = COMPLETED
            if (statusCode === 3 && order.code) {
                return {
                    success: true,
                    otp: order.code.toString(),
                    status: 'RECEIVED',
                    fullText: order.full_sms || order.sms || null,
                    receivedAt: new Date()
                };
            }

            // Status 2 = EXPIRED, 5 = CANCELLED, 6 = REFUNDED
            if ([2, 5, 6].includes(statusCode)) {
                return {
                    success: false,
                    status: statusText,
                    message: `Order ${statusText.toLowerCase()}`
                };
            }

            // Status 1 = PENDING, 7 = PROCESSING, 8 = ACTIVATING
            return {
                success: false,
                status: 'WAITING',
                message: `Status: ${statusText}`,
                orderStatus: statusCode
            };

        } catch (error) {
            logger.error('SMSPool SMS check failed', { orderId, error: error.message });
            return { success: false, error: error.message, status: 'ERROR' };
        }
    }

    // Legacy SMS check fallback
    async _legacyCheckSMS(orderId) {
        try {
            const response = await this.request(
                'get',
                this.endpoints.checkSMS,
                { orderid: orderId },
                null,
                15000
            );

            const data = response.data;

            // SMSPool checkSMS returns status code
            const statusCode = parseInt(data.status);
            const statusText = this.orderStatuses[statusCode] || 'UNKNOWN';

            if (statusCode === 3 && data.sms) {
                return {
                    success: true,
                    otp: data.sms.toString(),
                    status: 'RECEIVED',
                    fullText: data.full_sms || null,
                    receivedAt: new Date()
                };
            }

            if ([2, 5, 6].includes(statusCode)) {
                return {
                    success: false,
                    status: statusText,
                    message: `Order ${statusText.toLowerCase()}`
                };
            }

            return {
                success: false,
                status: 'WAITING',
                message: `Status: ${statusText}`,
                orderStatus: statusCode
            };

        } catch (error) {
            return { success: false, error: error.message, status: 'ERROR' };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    async cancelNumber(orderId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            if (!orderId) {
                return { success: false, error: 'MISSING_ORDER_ID' };
            }

            const response = await this.request(
                'post',
                this.endpoints.cancelSMS,
                null,
                { orderid: orderId },
                10000
            );

            const data = response.data;

            if (data?.success === 1) {
                return { success: true, status: 'CANCELLED', data };
            }

            return { success: false, error: data?.message || 'Cancel failed', data };

        } catch (error) {
            logger.error('SMSPool cancel failed', { orderId, error: error.message });
            return { success: false, error: error.message };
        }
    }

    async finishNumber(orderId) {
        // SMSPool auto-finishes on receipt, no explicit finish needed
        return { success: true, status: 'FINISHED', note: 'SMSPool auto-finishes' };
    }

    // ═══════════════════════════════════════════════════════════
    //  AVAILABILITY & CATALOG
    // ═══════════════════════════════════════════════════════════

    async checkAvailability(country, service) {
        const priceResult = await this.getPrice(country, service);
        return {
            available: priceResult.available && priceResult.stock > 0,
            stock: priceResult.stock || 0,
            price: priceResult.simPrice || 0,
            displayPrice: priceResult.displayPrice || 0
        };
    }

    async getAvailableCountries(service = 'Any') {
        try {
            const countries = await this._loadCountries();
            const poolService = this.mapService(service);

            // Filter countries that have the service available
            // We need to check prices for each, but that's expensive
            // Instead, return all countries and let the price check filter
            const availableCountries = countries.map(c => ({
                code: c.short_name || c.name?.substring(0, 2).toUpperCase() || c.ID,
                poolCode: c.ID,
                name: c.name
            }));

            return {
                success: true,
                countries: availableCountries,
                count: availableCountries.length
            };

        } catch (error) {
            logger.error('SMSPool country fetch failed', { error: error.message });
            return { success: false, error: error.message, countries: [] };
        }
    }

    async getAvailableServices() {
        try {
            const services = await this._loadServices();
            return {
                success: true,
                services: services.map(s => ({
                    id: s.ID,
                    name: s.name
                })),
                count: services.length
            };
        } catch (error) {
            return { success: false, error: error.message, services: [] };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  BALANCE
    // ═══════════════════════════════════════════════════════════

    async checkBalance() {
        try {
            const response = await this.request('get', this.endpoints.getBalance, null, null, 10000);
            const data = response.data;

            return {
                success: true,
                balance: parseFloat(data?.balance) || 0,
                currency: 'USD',
                raw: data
            };

        } catch (error) {
            logger.error('SMSPool balance check failed', { error: error.message });
            return { success: false, error: error.message, balance: 0 };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  MAPPING HELPERS
    // ═══════════════════════════════════════════════════════════

    mapService(service) {
        if (!service || service === 'Any') return 'not_listed';
        const normalized = service.toString().trim();
        return this.serviceMap[normalized] || 
               this.serviceMap[normalized.toLowerCase()] || 
               normalized.toLowerCase().replace(/\s+/g, '_');
    }

    mapCountry(country) {
        if (!country) throw new Error('BAD_COUNTRY: Country required');
        const normalized = country.toString().trim().toUpperCase();
        const mapped = this.countryMap[normalized];
        if (!mapped) {
            // Try to use as-is if it's a valid SMSPool country code
            return country.toString().trim();
        }
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

    // ═══════════════════════════════════════════════════════════
    //  UTILITIES
    // ═══════════════════════════════════════════════════════════

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

export default SMSPoolProvider;
