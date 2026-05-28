// ═══════════════════════════════════════════════════════════════════════════════
//  services/OnlineSimProvider.js — OnlineSim.io API Integration
//  Cheaper alternative to 5SIM. Starts at $0.01, 90+ countries.
//  API Docs: https://onlinesim.io/openapi_docs/Onlinesim-API-UN/info
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

const BASE_PROFIT = 0.10; // Same $0.10 flat profit

/**
 * OnlineSimProvider — OnlineSim.io API Integration
 * 
 * Endpoints:
 *   GET /api/getBalance.php?apikey={key}
 *   GET /api/getNumbersStats.php?country={code}&service={service}&apikey={key}
 *   GET /api/getNum.php?service={service}&country={code}&apikey={key}
 *   GET /api/getState.php?tzid={tzid}&apikey={key}
 *   GET /api/setOperationOk.php?tzid={tzid}&apikey={key}
 *   GET /api/setOperationRevise.php?tzid={tzid}&apikey={key}
 */
class OnlineSimProvider {
    constructor() {
        this.name = 'ONLINE_SIM';
        this.tier = 'CHEAP';
        this.providerKey = 'onlinesim';
        
        this.baseUrl = config.onlineSim?.baseUrl || 'https://onlinesim.io/api';
        this.apiKey = config.onlineSim?.apiKey;
        this.isActive = !!this.apiKey;
        
        this.endpoints = {
            getBalance: '/getBalance.php',
            getStats: '/getNumbersStats.php',
            getNumber: '/getNum.php',
            getState: '/getState.php',
            setOk: '/setOperationOk.php',
            setRevise: '/setOperationRevise.php'
        };

        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0,
            totalCost: 0
        };

        // OnlineSim service codes (partial list — extend as needed)
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
            'Airbnb': 'airbnb',
            'Any': 'other',
            'Other': 'other'
        };

        // OnlineSim country codes (numeric)
        this.countryMap = {
            'US': 1, 'UK': 2, 'GB': 2, 'RU': 0, 'UA': 1,
            'CN': 3, 'IN': 4, 'NG': 5, 'DE': 6, 'FR': 7,
            'BR': 8, 'MX': 9, 'ID': 10, 'PH': 11, 'VN': 12,
            'TH': 13, 'TR': 14, 'PL': 15, 'KZ': 16, 'RO': 17,
            'ES': 18, 'IT': 19, 'NL': 20, 'SE': 21, 'NO': 22,
            'FI': 23, 'DK': 24, 'AU': 25, 'JP': 26, 'KR': 27,
            'SG': 28, 'MY': 29, 'ZA': 30, 'EG': 31, 'SA': 32,
            'AE': 33, 'IL': 34, 'BE': 35, 'AT': 36, 'CH': 37,
            'PT': 38, 'GR': 39, 'CZ': 40, 'HU': 41, 'SK': 42,
            'BG': 43, 'HR': 44, 'SI': 45, 'LT': 46, 'LV': 47,
            'EE': 48, 'MD': 49, 'GE': 50, 'AM': 51, 'AZ': 52,
            'BY': 53, 'KG': 54, 'TJ': 55, 'TM': 56, 'UZ': 57,
            'AL': 58, 'BA': 59, 'MK': 60, 'ME': 61, 'RS': 62,
            'XK': 63, 'CA': 64
        };

        this.reverseCountryMap = Object.fromEntries(
            Object.entries(this.countryMap).map(([iso, code]) => [code, iso])
        );

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
            'TIMEOUT': { recoverable: true, retryAfter: 10000, message: 'Provider timeout' },
            'CONNECTION_ERROR': { recoverable: true, retryAfter: 5000, message: 'Connection error' },
            'NOT_AVAILABLE': { recoverable: true, retryAfter: 3000, message: 'Service not available in this country' }
        };

        this.productsCache = null;
        this.productsCacheTime = 0;
        this.productsCacheTtl = 5 * 60 * 1000;

        this.balanceCache = null;
        this.balanceCacheTime = 0;
        this.balanceCacheTtl = 30 * 1000;

        if (this.isActive) {
            this.checkBalance().catch(err => 
                logger.warn('Initial OnlineSim balance check failed', { error: err.message })
            );
            logger.info('OnlineSimProvider initialized', {
                provider: this.name,
                baseUrl: this.baseUrl,
                hasKey: !!this.apiKey
            });
        } else {
            logger.warn('OnlineSimProvider disabled - no API key configured');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  REQUEST HELPER
    // ═══════════════════════════════════════════════════════════

    async request(method, endpoint, params = {}, timeout = 10000) {
        const url = `${this.baseUrl}${endpoint}`;
        const axiosConfig = {
            method,
            url,
            params: { ...params, apikey: this.apiKey },
            timeout,
            validateStatus: () => true
        };
        
        const response = await axios(axiosConfig);
        
        // OnlineSim returns { response: "1", ... } for success, { response: "NO_NUMBERS", ... } for errors
        const data = response.data;
        
        if (typeof data === 'string') {
            if (data.includes('NO_NUMBERS') || data.includes('NO_NUMBER')) {
                throw new Error(`NO_NUMBERS: ${data}`);
            }
            if (data.includes('BAD_KEY') || data.includes('ERROR')) {
                throw new Error(`BAD_KEY: ${data}`);
            }
            if (data.includes('NO_BALANCE') || data.includes('LOW_BALANCE')) {
                throw new Error(`NO_BALANCE: ${data}`);
            }
            throw new Error(`PROVIDER_ERROR: ${data}`);
        }

        if (data && data.response) {
            const respCode = data.response.toString();
            if (respCode !== '1' && respCode !== 'TZ_NUM_WAIT') {
                if (respCode.includes('NO_NUMBERS') || respCode.includes('NO_NUMBER')) {
                    throw new Error(`NO_NUMBERS: ${respCode}`);
                }
                if (respCode.includes('BAD_KEY')) {
                    throw new Error(`BAD_KEY: ${respCode}`);
                }
                if (respCode.includes('NO_BALANCE') || respCode.includes('LOW_BALANCE')) {
                    throw new Error(`NO_BALANCE: ${respCode}`);
                }
                if (respCode.includes('BAD_SERVICE')) {
                    throw new Error(`BAD_SERVICE: ${respCode}`);
                }
                if (respCode.includes('BAD_COUNTRY')) {
                    throw new Error(`BAD_COUNTRY: ${respCode}`);
                }
                throw new Error(`PROVIDER_ERROR: ${respCode}`);
            }
        }

        if (response.status >= 400) {
            throw new Error(`PROVIDER_ERROR: HTTP ${response.status}`);
        }

        return response;
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
            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            const response = await this.request('get', this.endpoints.getStats, {
                country: providerCountry,
                service: providerService
            }, 10000);

            const data = response.data;
            
            if (!data || !Array.isArray(data)) {
                return { success: false, error: 'Invalid stats response' };
            }

            // Find cheapest operator with stock
            let minPrice = Infinity;
            let cheapestOperator = null;
            let totalStock = 0;

            for (const op of data) {
                const count = parseInt(op.count) || 0;
                const price = parseFloat(op.price) || Infinity;
                const operatorName = op.operator || op.name || 'any';
                
                totalStock += count;
                if (count > 0 && price < minPrice) {
                    minPrice = price;
                    cheapestOperator = operatorName;
                }
            }

            if (minPrice === Infinity || totalStock === 0) {
                return { success: false, error: 'No stock available', available: false };
            }

            const displayPrice = this.getDisplayPrice(minPrice);

            return {
                success: true,
                simPrice: minPrice,
                displayPrice: displayPrice,
                profit: BASE_PROFIT,
                operator: cheapestOperator,
                stock: totalStock,
                available: true
            };

        } catch (error) {
            logger.error('Failed to get OnlineSim price', { country, service, error: error.message });
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  AVAILABLE COUNTRIES
    // ═══════════════════════════════════════════════════════════

    async getAvailableCountries(service = 'Any') {
        try {
            const providerService = this.mapService(service);
            const products = await this.getProducts();
            
            if (!products) {
                return { success: false, error: 'Failed to fetch products' };
            }

            const availableCountries = [];
            const seen = new Set();
            
            for (const [countryCode, services] of Object.entries(products)) {
                const serviceData = services[providerService];
                if (!serviceData) continue;

                const hasStock = Object.values(serviceData).some(opData => {
                    const count = typeof opData === 'object' ? (opData.count ?? 0) : 0;
                    return count > 0;
                });

                if (hasStock) {
                    const isoCode = this.reverseCountryMap[countryCode];
                    if (isoCode && !seen.has(isoCode)) {
                        seen.add(isoCode);
                        availableCountries.push({
                            code: isoCode,
                            simCode: countryCode,
                            name: this._getCountryName(isoCode)
                        });
                    }
                }
            }

            availableCountries.sort((a, b) => a.name.localeCompare(b.name));

            return {
                success: true,
                countries: availableCountries,
                count: availableCountries.length
            };

        } catch (error) {
            logger.error('Failed to get OnlineSim available countries', { service, error: error.message });
            return { success: false, error: error.message };
        }
    }

    _getCountryName(isoCode) {
        const names = {
            'US': 'United States', 'UK': 'United Kingdom', 'CA': 'Canada',
            'RU': 'Russia', 'CN': 'China', 'IN': 'India', 'NG': 'Nigeria',
            'DE': 'Germany', 'FR': 'France', 'BR': 'Brazil', 'MX': 'Mexico',
            'ID': 'Indonesia', 'PH': 'Philippines', 'VN': 'Vietnam', 'TH': 'Thailand',
            'TR': 'Turkey', 'PL': 'Poland', 'UA': 'Ukraine', 'KZ': 'Kazakhstan',
            'RO': 'Romania', 'ES': 'Spain', 'IT': 'Italy', 'NL': 'Netherlands',
            'SE': 'Sweden', 'NO': 'Norway', 'FI': 'Finland', 'DK': 'Denmark',
            'AU': 'Australia', 'JP': 'Japan', 'KR': 'South Korea', 'SG': 'Singapore',
            'MY': 'Malaysia', 'ZA': 'South Africa', 'EG': 'Egypt', 'SA': 'Saudi Arabia',
            'AE': 'UAE', 'IL': 'Israel', 'BE': 'Belgium', 'AT': 'Austria',
            'CH': 'Switzerland', 'PT': 'Portugal', 'GR': 'Greece', 'CZ': 'Czech Republic',
            'HU': 'Hungary', 'SK': 'Slovakia', 'BG': 'Bulgaria', 'HR': 'Croatia',
            'SI': 'Slovenia', 'LT': 'Lithuania', 'LV': 'Latvia', 'EE': 'Estonia',
            'MD': 'Moldova', 'GE': 'Georgia', 'AM': 'Armenia', 'AZ': 'Azerbaijan',
            'BY': 'Belarus', 'KG': 'Kyrgyzstan', 'TJ': 'Tajikistan', 'TM': 'Turkmenistan',
            'UZ': 'Uzbekistan', 'AL': 'Albania', 'BA': 'Bosnia', 'MK': 'Macedonia',
            'ME': 'Montenegro', 'RS': 'Serbia', 'XK': 'Kosovo'
        };
        return names[isoCode] || isoCode;
    }

    // ═══════════════════════════════════════════════════════════
    //  BALANCE CHECK
    // ═══════════════════════════════════════════════════════════

    async checkBalance() {
        const now = Date.now();
        if (this.balanceCache && (now - this.balanceCacheTime) < this.balanceCacheTtl) {
            return this.balanceCache;
        }

        try {
            const response = await this.request('get', this.endpoints.getBalance, {}, 10000);
            const data = response.data;
            
            const result = {
                success: true,
                balance: parseFloat(data?.balance) || 0,
                currency: data?.currency || 'USD',
                rating: data?.rating
            };

            this.balanceCache = result;
            this.balanceCacheTime = now;

            logger.info('OnlineSim account balance', {
                balance: result.balance,
                currency: result.currency
            });
            
            return result;
        } catch (error) {
            logger.error('Failed to check OnlineSim balance', { error: error.message });
            return { success: false, error: error.message, balance: 0 };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  PRODUCT CACHE
    // ═══════════════════════════════════════════════════════════

    async getProducts() {
        const now = Date.now();
        if (this.productsCache && (now - this.productsCacheTime) < this.productsCacheTtl) {
            return this.productsCache;
        }

        try {
            // OnlineSim doesn't have a direct products endpoint like 5SIM
            // We build it from stats calls or use a cached aggregate
            // For now, return null to trigger fallback behavior
            // In production, you'd cache stats responses per country
            return null;
        } catch (error) {
            logger.error('Failed to fetch OnlineSim products', { error: error.message });
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  PRE-FLIGHT AVAILABILITY CHECK
    // ═══════════════════════════════════════════════════════════

    async checkAvailability(country, service) {
        try {
            const priceResult = await this.getPrice(country, service);
            return {
                available: priceResult.success && priceResult.available,
                operators: priceResult.operator ? [priceResult.operator] : [],
                error: priceResult.error
            };
        } catch (error) {
            return { available: false, error: error.message };
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

            const balanceResult = await this.checkBalance();
            if (!balanceResult.success || balanceResult.balance <= 0) {
                logger.error('OnlineSim balance insufficient', { 
                    balance: balanceResult.balance,
                    error: balanceResult.error 
                });
                throw new Error('NO_BALANCE: Insufficient OnlineSim balance');
            }

            const availability = await this.checkAvailability(country, service);
            if (!availability.available) {
                throw new Error(`NOT_AVAILABLE: ${service} not available in ${country}`);
            }

            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            logger.info('Requesting number from OnlineSim', {
                country: providerCountry,
                service: providerService,
                originalCountry: country,
                originalService: service,
                preferredOperator,
                balance: balanceResult.balance
            });

            const response = await this.request('get', this.endpoints.getNumber, {
                service: providerService,
                country: providerCountry,
                operator: preferredOperator !== 'any' ? preferredOperator : undefined,
                number: true,
                reuse: 0
            }, 30000);

            const data = response.data;
            
            if (!data || !data.tzid) {
                throw new Error(`INVALID_RESPONSE: Missing tzid. Response: ${JSON.stringify(data)}`);
            }

            if (!data.number) {
                throw new Error(`INVALID_RESPONSE: Missing number. Response: ${JSON.stringify(data)}`);
            }

            const phoneStr = data.number.toString().trim();
            const tzid = data.tzid.toString().trim();

            if (this.isFakeNumber(phoneStr)) {
                logger.error('OnlineSim returned fake number', { phone: phoneStr, tzid });
                await this.cancelNumber(tzid).catch(() => {});
                throw new Error(`FAKE_NUMBER_REJECTED: ${phoneStr}`);
            }

            if (phoneStr.length < 7 || phoneStr.length > 15) {
                logger.error('OnlineSim returned invalid phone length', { phone: phoneStr, length: phoneStr.length });
                await this.cancelNumber(tzid).catch(() => {});
                throw new Error(`INVALID_PHONE_LENGTH: ${phoneStr}`);
            }

            // Get price info for this purchase
            const priceInfo = await this.getPrice(country, service);
            const simPrice = priceInfo.success ? priceInfo.simPrice : 0;
            const displayPrice = this.getDisplayPrice(simPrice);

            const duration = Date.now() - startTime;
            this.updateStats(true, duration, simPrice);

            logger.info('Number acquired from OnlineSim', {
                tzid,
                phone: this.maskPhone(phoneStr),
                country: providerCountry,
                service: providerService,
                simPrice,
                displayPrice,
                duration
            });

            return {
                phoneNumber: phoneStr,
                provider: this.name,
                providerNumberId: tzid,
                country,
                service,
                cost: simPrice,
                displayCost: displayPrice,
                operator: preferredOperator || 'any',
                expiresAt: new Date(Date.now() + 20 * 60 * 1000),
                isVirtual: true
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration, 0);

            logger.error('OnlineSim number acquisition failed', {
                country,
                service,
                preferredOperator,
                error: error.message
            });

            throw this.handleError(error);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SMS CHECKING
    // ═══════════════════════════════════════════════════════════

    async checkSMS(tzid) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            if (!tzid) {
                return { success: false, error: 'INVALID_TZID' };
            }

            const response = await this.request('get', this.endpoints.getState, {
                tzid: tzid.toString(),
                message_to_code: 1
            }, 15000);

            const data = response.data;
            
            if (!data || !Array.isArray(data)) {
                return { success: false, error: 'Invalid state response', status: 'ERROR' };
            }

            const msg = data[0];
            if (!msg) {
                return { success: false, status: 'WAITING', message: 'No messages yet' };
            }

            const status = (msg.response || msg.status || '').toUpperCase();

            if (status === 'TZ_NUM_ANSWER' || status === 'OK' || msg.msg) {
                const otp = this.extractOTP(msg.msg, msg.msg);
                
                if (otp) {
                    return {
                        success: true,
                        otp,
                        status: 'RECEIVED',
                        fullText: msg.msg,
                        receivedAt: new Date()
                    };
                }

                return {
                    success: false,
                    status: 'CHECKING',
                    rawText: msg.msg,
                    message: 'SMS received but OTP extraction failed'
                };
            }

            if (status === 'TZ_OVER' || status === 'TZ_NUM_WAIT' || status === 'WAITING') {
                return { success: false, status: 'WAITING', message: 'Waiting for SMS' };
            }

            if (status === 'TZ_OVER_EMPTY' || status === 'CANCELLED') {
                return { success: false, status: 'CANCELLED', message: 'Number was cancelled or expired empty' };
            }

            if (status === 'ERROR') {
                return { success: false, status: 'ERROR', message: msg.msg || 'Unknown error' };
            }

            return { success: false, status: 'WAITING', message: `Status: ${status}` };

        } catch (error) {
            logger.error('OnlineSim SMS check failed', { tzid, error: error.message });
            return { success: false, error: error.message, status: 'ERROR' };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  OTP EXTRACTION (same logic as 5SIM)
    // ═══════════════════════════════════════════════════════════

    extractOTP(code, text) {
        if (code !== null && code !== undefined) {
            const codeStr = code.toString().trim();
            const cleanCode = codeStr.replace(/[\s\-]/g, '');
            if (/^\d{4,8}$/.test(cleanCode)) {
                return cleanCode;
            }
        }

        if (text === null || text === undefined) {
            return null;
        }

        let textStr = typeof text === 'string' ? text : text?.toString() || '';

        const patterns = [
            /\b\d{4,8}\b/,
            /code[:\s]+(\d{4,8})/i,
            /otp[:\s]+(\d{4,8})/i,
            /verification[:\s]+(\d{4,8})/i,
            /(\d{4,8})[:\s]*is your/i,
            /验证码[:\s]*(\d{4,8})/i,
            /код[:\s]+(\d{4,8})/i,
            /pin[:\s]+(\d{4,8})/i,
            /your[:\s]+code[:\s]+is[:\s]+(\d{4,8})/i
        ];

        for (const pattern of patterns) {
            const match = textStr.match(pattern);
            if (match) {
                const otp = match[1] || match[0];
                const cleanOtp = otp.toString().replace(/\D/g, '');
                if (/^\d{4,8}$/.test(cleanOtp)) return cleanOtp;
            }
        }

        const digits = textStr.match(/\b\d{4,8}\b/g);
        if (digits?.length > 0) return digits[digits.length - 1];

        return null;
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    async cancelNumber(tzid) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            if (!tzid) {
                return { success: false, error: 'MISSING_TZID' };
            }

            const response = await this.request('get', this.endpoints.setRevise, {
                tzid: tzid.toString()
            });

            logger.info('OnlineSim number cancelled', { tzid, status: response.status });
            return { success: true, status: 'CANCELLED', data: response.data };

        } catch (error) {
            logger.warn('OnlineSim cancel failed', { tzid, error: error.message });
            return { success: false, error: error.message, status: 'ERROR' };
        }
    }

    async finishNumber(tzid) {
        try {
            if (!tzid) {
                return { success: false, error: 'MISSING_TZID' };
            }

            const response = await this.request('get', this.endpoints.setOk, {
                tzid: tzid.toString()
            });

            logger.info('OnlineSim activation marked as finished', { tzid });
            return { success: true, status: 'FINISHED', data: response.data };

        } catch (error) {
            logger.warn('OnlineSim finish failed', { tzid, error: error.message });
            return { success: false, error: error.message };
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
        if (mapped === undefined) throw new Error(`BAD_COUNTRY: ${country} not supported by OnlineSim`);
        return mapped;
    }

    // ═══════════════════════════════════════════════════════════
    //  VALIDATION HELPERS
    // ═══════════════════════════════════════════════════════════

    isFakeNumber(phone) {
        if (!phone) return true;
        const clean = phone.toString().replace(/\D/g, '');
        return this.fakeNumbers.has(clean) || this.fakeNumbers.has(phone);
    }

    getHeaders() {
        return {
            'Accept': 'application/json'
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

export default OnlineSimProvider;
