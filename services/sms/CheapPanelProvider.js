// ═══════════════════════════════════════════════════════════════════════════════
//  services/CheapPanelProvider.js — 5SIM API Integration
// 
//  CRITICAL FIXES:
//  - extractOTP: Proper type guards before string operations
//  - checkSMS: Correctly handles 5SIM response structure (sms field, not text)
//  - getNumber: Returns actual cost vs display price separately, preserves operator
//  - cancelNumber: Validates activation ID is numeric, not phone number
//  - request: Proper error logging without crashing
//  - FIXED: Detects empty/HTML responses, throws meaningful errors for fallback
//  - FIXED: Returns exact operator used in response to prevent mismatch
//  - FIXED: mapOperator no longer uses stale hardcoded whitelist
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * CheapPanelProvider — 5SIM API Integration
 */
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
            getBalance: '/user/profile',
            getCountries: '/guest/countries',
            getProducts: '/guest/prices'
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
            'Airbnb': 'airbnb',
            'Any': 'other',
            'Other': 'other'
        };

        this.countryMap = {
            'US': 'usa', 'UK': 'england', 'GB': 'england', 'CA': 'canada',
            'RU': 'russia', 'CN': 'china', 'IN': 'india', 'NG': 'nigeria',
            'DE': 'germany', 'FR': 'france', 'BR': 'brazil', 'MX': 'mexico',
            'ID': 'indonesia', 'PH': 'philippines', 'VN': 'vietnam', 'TH': 'thailand',
            'TR': 'turkey', 'PL': 'poland', 'UA': 'ukraine', 'KZ': 'kazakhstan',
            'RO': 'romania', 'ES': 'spain', 'IT': 'italy', 'NL': 'netherlands',
            'SE': 'sweden', 'NO': 'norway', 'FI': 'finland', 'DK': 'denmark',
            'AU': 'australia', 'JP': 'japan', 'KR': 'southkorea', 'SG': 'singapore',
            'MY': 'malaysia', 'ZA': 'southafrica', 'EG': 'egypt', 'SA': 'saudiarabia',
            'AE': 'uae', 'IL': 'israel', 'BE': 'belgium', 'AT': 'austria',
            'CH': 'switzerland', 'PT': 'portugal', 'GR': 'greece', 'CZ': 'czech',
            'HU': 'hungary', 'SK': 'slovakia', 'BG': 'bulgaria', 'HR': 'croatia',
            'SI': 'slovenia', 'LT': 'lithuania', 'LV': 'latvia', 'EE': 'estonia',
            'MD': 'moldova', 'GE': 'georgia', 'AM': 'armenia', 'AZ': 'azerbaijan',
            'BY': 'belarus', 'KG': 'kyrgyzstan', 'TJ': 'tajikistan', 'TM': 'turkmenistan',
            'UZ': 'uzbekistan', 'AL': 'albania', 'BA': 'bosnia', 'MK': 'macedonia',
            'ME': 'montenegro', 'RS': 'serbia', 'XK': 'kosovo'
        };

        this.reverseCountryMap = Object.fromEntries(
            Object.entries(this.countryMap).map(([iso, sim]) => [sim, iso])
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
            'BAD_OPERATOR': { recoverable: true, retryAfter: 2000, message: 'Invalid operator' },
            'PROVIDER_NOT_CONFIGURED': { recoverable: false, message: 'Provider not configured' },
            'INVALID_RESPONSE': { recoverable: true, retryAfter: 3000, message: 'Invalid provider response' },
            'FAKE_NUMBER_REJECTED': { recoverable: true, retryAfter: 2000, message: 'Provider returned test number, retrying' },
            'INVALID_PHONE_LENGTH': { recoverable: true, retryAfter: 2000, message: 'Invalid phone number from provider' },
            'INVALID_ACTIVATION_ID': { recoverable: false, message: 'Invalid activation ID from provider' },
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

    // ═══════════════════════════════════════════════════════════
    //  REQUEST HELPER — No rate limiting
    // ═══════════════════════════════════════════════════════════

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
        
        // CRITICAL FIX: Handle string error responses in HTTP 200 (5SIM quirk)
        if (typeof response.data === 'string') {
            const text = response.data.trim().toLowerCase();
            
            if (text === 'no free phones' || text.includes('no free') || text.includes('no numbers')) {
                logger.warn('5SIM returned string error', { url, text: response.data });
                throw new Error(`NO_NUMBERS: ${response.data}`);
            }
            
            if (text.includes('not enough') || text.includes('insufficient') || text.includes('no balance')) {
                logger.warn('5SIM returned balance error', { url, text: response.data });
                throw new Error(`NO_BALANCE: ${response.data}`);
            }
            
            if (text.includes('not available') || text.includes('invalid')) {
                logger.warn('5SIM returned availability error', { url, text: response.data });
                throw new Error(`NOT_AVAILABLE: ${response.data}`);
            }
        }
        
        // CRITICAL FIX: Detect empty/HTML responses that indicate real errors
        if (response.status >= 400 || !response.data || typeof response.data !== 'object') {
            const errorData = response.data;
            const isHtmlError = typeof errorData === 'string' && errorData.includes('<');
            const isEmpty = !errorData || (typeof errorData === 'string' && errorData.trim() === '');
            
            logger.error('5SIM API error response', {
                url,
                status: response.status,
                statusText: response.statusText,
                isHtmlError,
                isEmpty,
                dataPreview: isHtmlError ? 'HTML_ERROR_PAGE' : (isEmpty ? 'EMPTY_BODY' : errorData)
            });

            // Throw with meaningful error so getNumber() can categorize it
            if (response.status === 404) {
                throw new Error(`NOT_AVAILABLE: 5SIM returned 404 for ${url}`);
            }
            if (response.status === 400) {
                const msg = isHtmlError ? 'Invalid operator/country combination' : (errorData?.error || errorData?.message || 'Bad request');
                throw new Error(`NOT_AVAILABLE: ${msg}`);
            }
            if (response.status === 429) {
                throw new Error(`TIMEOUT: 5SIM rate limited (429)`);
            }
            if (isEmpty || isHtmlError) {
                throw new Error(`NOT_AVAILABLE: 5SIM returned empty/invalid response for this operator`);
            }
            
            throw new Error(`PROVIDER_ERROR: HTTP ${response.status} - ${errorData?.error || 'Unknown error'}`);
        }
        
        return response;
    }

    // ═══════════════════════════════════════════════════════════
    //  DYNAMIC PRICING
    // ═══════════════════════════════════════════════════════════

    getDisplayPrice(simPrice) {
        const price = parseFloat(simPrice) || 0;
        if (price <= 0.50) {
            return parseFloat((price + 0.20).toFixed(2));
        }
        return parseFloat((price + 0.30).toFixed(2));
    }

    async getPrice(country = 'US', service = 'Any') {
        try {
            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            const targetedEndpoint = `${this.endpoints.getPrices}?country=${providerCountry}&product=${providerService}`;
            
            let response;
            try {
                response = await this.request('get', targetedEndpoint, null, 10000);
            } catch (err) {
                logger.warn('Targeted price query failed, falling back to full catalog', { 
                    country: providerCountry, 
                    service: providerService,
                    error: err.message 
                });
                const products = await this.getProducts();
                if (!products) {
                    return { success: false, error: 'Failed to fetch product catalog' };
                }
                return this._extractPriceFromProducts(products, providerCountry, providerService);
            }

            if (response.status >= 400) {
                const products = await this.getProducts();
                if (!products) {
                    return { success: false, error: `Failed to fetch product catalog. HTTP ${response.status}` };
                }
                return this._extractPriceFromProducts(products, providerCountry, providerService);
            }

            const data = response.data;
            if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
                return { success: false, error: `No data returned for ${providerCountry}/${providerService}` };
            }

            return this._extractPriceFromProducts(data, providerCountry, providerService);

        } catch (error) {
            logger.error('Failed to get price', { country, service, error: error.message });
            return { success: false, error: error.message };
        }
    }

    _extractPriceFromProducts(products, providerCountry, providerService) {
        const countryData = products[providerCountry];
        if (!countryData) {
            return { success: false, error: `Country ${providerCountry} not available` };
        }

        const serviceData = countryData[providerService];
        if (!serviceData) {
            return { success: false, error: `Service ${providerService} not available in ${providerCountry}` };
        }

        let minPrice = Infinity;
        let cheapestOperator = null;
        let totalStock = 0;

        for (const [operatorName, operatorData] of Object.entries(serviceData)) {
            const count = typeof operatorData === 'object' ? (operatorData.count ?? 0) : 0;
            const price = typeof operatorData === 'object' ? (operatorData.cost ?? operatorData.price ?? Infinity) : Infinity;
            
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
            profit: parseFloat((displayPrice - minPrice).toFixed(2)),
            operator: cheapestOperator,
            stock: totalStock,
            available: true
        };
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
            
            for (const [simCountry, services] of Object.entries(products)) {
                const serviceData = services[providerService];
                if (!serviceData) continue;

                const hasStock = Object.values(serviceData).some(opData => {
                    const count = typeof opData === 'object' ? (opData.count ?? 0) : 0;
                    return count > 0;
                });

                if (hasStock) {
                    const isoCode = this.reverseCountryMap[simCountry];
                    if (isoCode) {
                        availableCountries.push({
                            code: isoCode,
                            simCode: simCountry,
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
            logger.error('Failed to get available countries', { service, error: error.message });
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
    //  BALANCE CHECK (with caching)
    // ═══════════════════════════════════════════════════════════

    async checkBalance() {
        const now = Date.now();
        if (this.balanceCache && (now - this.balanceCacheTime) < this.balanceCacheTtl) {
            return this.balanceCache;
        }

        try {
            const response = await this.request('get', this.endpoints.getBalance);
            const data = response.data;
            
            const result = {
                success: true,
                balance: parseFloat(data?.balance) || 0,
                currency: data?.currency || 'RUB',
                rating: data?.rating
            };

            this.balanceCache = result;
            this.balanceCacheTime = now;

            logger.info('5SIM account balance', {
                balance: result.balance,
                rating: result.rating,
                currency: result.currency
            });
            
            return result;
        } catch (error) {
            logger.error('Failed to check 5SIM balance', { error: error.message });
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
            const response = await this.request('get', this.endpoints.getProducts, null, 30000);
            this.productsCache = response.data;
            this.productsCacheTime = now;
            return this.productsCache;
        } catch (error) {
            logger.error('Failed to fetch 5SIM products', { error: error.message });
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  PRE-FLIGHT AVAILABILITY CHECK
    // ═══════════════════════════════════════════════════════════

    async checkAvailability(country, service) {
        try {
            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            const targetedEndpoint = `${this.endpoints.getProducts}?country=${providerCountry}&product=${providerService}`;
            
            let response;
            try {
                response = await this.request('get', targetedEndpoint, null, 10000);
            } catch (err) {
                logger.warn('Targeted price query failed, falling back to full catalog', { 
                    country: providerCountry, 
                    service: providerService,
                    error: err.message 
                });
 // ═══════════════════════════════════════════════════════════════════════════════
//  CheapPanelProvider.js — Part 2/3
//  Number Acquisition, SMS Checking & OTP Extraction
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION
    // ═══════════════════════════════════════════════════════════

    /**
     * FIXED: Preserves exact operator passed from tier selection.
     * No longer uses stale hardcoded operatorMap whitelist.
     * TierOperatorSelector already validated operator via 5SIM API.
     */
    async getNumber(country = 'US', service = 'Any', preferredOperator = 'any') {
        const startTime = Date.now();

        try {
            if (!this.isActive) {
                throw new Error('PROVIDER_NOT_CONFIGURED');
            }

            const balanceResult = await this.checkBalance();
            if (!balanceResult.success || balanceResult.balance <= 0) {
                logger.error('5SIM balance insufficient or check failed', { 
                    balance: balanceResult.balance,
                    error: balanceResult.error 
                });
                throw new Error('NO_BALANCE: Insufficient 5SIM balance. Fund wallet at 5sim.net');
            }

            const availability = await this.checkAvailability(country, service);
            if (!availability.available) {
                throw new Error(`NOT_AVAILABLE: ${service} not available in ${country}. ${availability.error || ''}`);
            }

            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);
            
            // FIXED: Trust the operator from tier selection. No stale whitelist.
            const operator = this.mapOperator(providerCountry, preferredOperator);

            logger.info('Requesting number from 5SIM', {
                country: providerCountry,
                service: providerService,
                operator,
                originalCountry: country,
                originalService: service,
                preferredOperator,
                usingPreferred: operator === preferredOperator,
                balance: balanceResult.balance
            });

            const endpoint = `${this.endpoints.getNumber}/${providerCountry}/${operator}/${providerService}`;
            
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

            // CRITICAL FIX: Handle empty/invalid responses before checking data fields
            if (statusCode >= 400 || !data || typeof data !== 'object') {
                const errorMsg = data?.error || data?.message || (typeof data === 'string' ? data : null) || `HTTP ${statusCode}`;
                const isEmptyResponse = !data || (typeof data === 'string' && data.trim() === '');
                
                // Check balance errors first
                const lowerMsg = (errorMsg || '').toLowerCase();
                if (lowerMsg.includes('not enough user balance') || 
                    lowerMsg.includes('no balance') ||
                    lowerMsg.includes('insufficient funds')) {
                    throw new Error(`NO_BALANCE: ${errorMsg}`);
                }

                // 404 = not available (country/service/operator combo doesn't work)
                if (statusCode === 404 || isEmptyResponse) {
                    throw new Error(`NOT_AVAILABLE: ${service} not available in ${country} with operator ${operator}. Try another country or operator.`);
                }

                // 400 = bad request (often means operator doesn't support this combo)
                if (statusCode === 400) {
                    throw new Error(`NOT_AVAILABLE: Invalid combination: ${operator} for ${service} in ${country}. Try another operator.`);
                }
                
                throw new Error(`PROVIDER_ERROR: ${errorMsg}`);
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
            const simPrice = parseFloat(data.price) || 0;
            const displayPrice = this.getDisplayPrice(simPrice);
            
            this.updateStats(true, duration, simPrice);

            logger.info('Number acquired from 5SIM', {
                activationId,
                phone: this.maskPhone(phoneStr),
                country: providerCountry,
                service: providerService,
                operator,
                simPrice,
                displayPrice,
                duration
            });

            // FIXED: Return exact operator used in the request
            return {
                phoneNumber: phoneStr,
                provider: this.name,
                providerNumberId: activationId,
                country,
                service,
                cost: simPrice,
                displayCost: displayPrice,
                operator: operator,
                expiresAt: new Date(Date.now() + 20 * 60 * 1000),
                isVirtual: true
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration, 0);

            logger.error('5SIM number acquisition failed', {
                country,
                service,
                preferredOperator,
                error: error.message
            });

            throw this.handleError(error);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SMS CHECKING — CRITICAL FIX FOR text.match CRASH
    // ═══════════════════════════════════════════════════════════

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
                hasSms: !!data?.sms,
                smsType: typeof data?.sms,
                isArray: Array.isArray(data?.sms),
                codeType: typeof data?.code
            });

            const status = (data?.status || '').toUpperCase();

            if (status === 'RECEIVED' || status === 'FINISHED') {
                const otp = this.extractOTP(data.code, data.sms);
                
                if (otp) {
                    let fullText = null;
                    if (Array.isArray(data.sms)) {
                        fullText = data.sms[0]?.text || data.sms[0]?.sms || JSON.stringify(data.sms);
                    } else if (typeof data.sms === 'string') {
                        fullText = data.sms;
                    } else if (typeof data.sms === 'object' && data.sms !== null) {
                        fullText = data.sms.text || data.sms.sms || JSON.stringify(data.sms);
                    }

                    return {
                        success: true,
                        otp,
                        status: 'RECEIVED',
                        fullText: fullText,
                        receivedAt: new Date()
                    };
                }

                return {
                    success: false,
                    status: 'CHECKING',
                    rawText: Array.isArray(data.sms) ? JSON.stringify(data.sms) : data.sms,
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

    // ═══════════════════════════════════════════════════════════
    //  OTP EXTRACTION
    // ═══════════════════════════════════════════════════════════

    extractOTP(code, text) {
        if (code !== null && code !== undefined) {
            const codeStr = code.toString().trim();
            const cleanCode = codeStr.replace(/[\s\-]/g, '');
            if (/^\d{4,8}$/.test(cleanCode)) {
                return cleanCode;
            }
            logger.debug('5SIM code field present but invalid format', { code, cleanCode });
        }

        if (text === null || text === undefined) {
            logger.debug('No SMS text provided', { text });
            return null;
        }

        let textStr;
        
        if (Array.isArray(text)) {
            const firstMessage = text[0];
            if (firstMessage && typeof firstMessage === 'object') {
                if (firstMessage.text && typeof firstMessage.text === 'string') {
                    textStr = firstMessage.text;
                } else if (firstMessage.sms && typeof firstMessage.sms === 'string') {
                    textStr = firstMessage.sms;
                } else {
                    const values = Object.values(firstMessage).filter(v => typeof v === 'string');
                    if (values.length > 0) {
                        textStr = values.join(' ');
                    } else {
                        logger.warn('SMS array element has no recognizable text field', { firstMessage });
                        return null;
                    }
                }
                
                if (firstMessage.code && (!code || code === null)) {
                    const arrayCode = firstMessage.code.toString().trim().replace(/[\s\-]/g, '');
                    if (/^\d{4,8}$/.test(arrayCode)) {
                        return arrayCode;
                    }
                }
            } else if (typeof firstMessage === 'string') {
                textStr = firstMessage;
            } else {
                logger.warn('SMS array first element is not object or string', { firstMessage });
                return null;
            }
        } else if (typeof text === 'string') {
            textStr = text;
        } else if (typeof text === 'number') {
            textStr = text.toString();
        } else if (typeof text === 'object') {
            if (text.text && typeof text.text === 'string') {
                textStr = text.text;
            } else if (text.sms && typeof text.sms === 'string') {
                textStr = text.sms;
            } else {
                logger.warn('SMS text is object with no recognizable text field', { text });
                return null;
            }
        } else {
            logger.error('SMS text is unexpected type', { textType: typeof text, textValue: text });
            return null;
        }

        const patterns = [
            /\b\d{4,8}\b/,
            /code[:\s]+(\d{4,8})/i,
            /otp[:\s]+(\d{4,8})/i,
            /verification[:\s]+(\d{4,8})/i,
            /(\d{4,8})[:\s]*is your/i,
            /(\d{4,8})[:\s]*is the/i,
            /验证码[:\s]*(\d{4,8})/i,
            /код[:\s]+(\d{4,8})/i,
            /code[:\s]*(\d{4,8})/i,
            /(\d{4,8})[:\s]*код/i,
            /pin[:\s]+(\d{4,8})/i,
            /password[:\s]+(\d{4,8})/i,
            /(\d{4,8})[:\s]*验证码/i,
            /your[:\s]+code[:\s]+is[:\s]+(\d{4,8})/i,
            /security[:\s]+code[:\s]+(\d{4,8})/i
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
            // ═══════════════════════════════════════════════════════════════════════════════
//  CheapPanelProvider.js — Part 3/3
//  Number Management, Mapping Helpers, Stats
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    //  NUMBER MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    async cancelNumber(activationId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            if (!activationId) {
                return { success: false, error: 'MISSING_ACTIVATION_ID' };
            }

            const cleanId = activationId.toString().trim();
            if (!/^\d+$/.test(cleanId)) {
                logger.error('Cancel called with non-numeric ID (likely phone number)', { activationId: cleanId });
                return { success: false, error: 'INVALID_ACTIVATION_ID: Expected numeric ID, got phone number' };
            }

            const endpoint = `${this.endpoints.cancel}/${cleanId}`;
            const response = await this.request('get', endpoint);

            logger.info('Number cancelled successfully', { 
                activationId: cleanId, 
                provider: this.name,
                status: response.status 
            });

            return { success: true, status: 'CANCELLED', data: response.data };

        } catch (error) {
            if (error.response?.status === 404 || error.message?.includes('not found')) {
                logger.info('Number already released or not found', { activationId });
                return { success: true, status: 'ALREADY_RELEASED' };
            }
            if (error.response?.status === 400) {
                logger.warn('Cancel request returned 400', { 
                    activationId, 
                    error: error.message,
                    data: error.response?.data 
                });
                return { success: false, error: error.message, status: 'ERROR' };
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

            const cleanId = activationId.toString().trim();
            if (!/^\d+$/.test(cleanId)) {
                return { success: false, error: 'INVALID_ACTIVATION_ID' };
            }
            
            const endpoint = `${this.endpoints.finish}/${cleanId}`;
            await this.request('get', endpoint);

            logger.info('Activation marked as finished', { activationId: cleanId });
            return { success: true, status: 'FINISHED' };

        } catch (error) {
            logger.warn('Finish request failed', { activationId, error: error.message });
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  LEGACY PRICING METHOD
    // ═══════════════════════════════════════════════════════════

    async getPrices(country = 'US', service = 'Any') {
        return this.getPrice(country, service);
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

    /**
     * FIXED: No longer uses hardcoded operator whitelist.
     * The tier system already validates operators via 5SIM API.
     * Trust the selected operator unless it's truly invalid.
     */
    mapOperator(country, preferred) {
        // If no preference or explicitly 'any', use 'any'
        if (!preferred || preferred === 'any') {
            return 'any';
        }

        // FIXED: Trust the tier system's operator selection.
        // The TierOperatorSelector already verified this operator exists 
        // and has stock via 5SIM's /guest/prices API.
        return preferred;
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

export default CheapPanelProvider;
            
