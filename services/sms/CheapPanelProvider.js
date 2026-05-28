// ═══════════════════════════════════════════════════════════════════════════════
//  services/CheapPanelProvider.js — 5SIM API Integration
// 
//  FIXED: Profit is now $0.10 flat (not $0.20/$0.30 tiered)
//  FIXED: Returns displayCost as raw + $0.10 (single source of truth for profit)
//  FIXED: getDisplayPrice simplified to flat $0.10 profit
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

const BASE_PROFIT = 0.10; // $0.10 flat profit per number

/**
 * CheapPanelProvider — 5SIM API Integration
 */
class CheapPanelProvider {
    constructor() {
        this.name = 'CHEAP_PANEL';
        this.tier = 'CHEAP';
        this.providerKey = '5sim'; // For provider router identification
        
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
    //  REQUEST HELPER
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
    //  PRICING — FIXED: Flat $0.10 profit
    // ═══════════════════════════════════════════════════════════

    /**
     * FIXED: Returns raw price + $0.10 flat profit
     * No more tiered $0.20/$0.30 — single consistent profit margin
     */
    getDisplayPrice(rawPrice) {
        const price = parseFloat(rawPrice) || 0;
        if (price <= 0) return null;
        return parseFloat((price + BASE_PROFIT).toFixed(4));
    }

    /**
     * Get price for country/service — returns both raw and display price
     */
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
            profit: BASE_PROFIT,
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
                const products = await this.getProducts();
                if (!products) {
                    return { available: false, error: 'Failed to fetch product catalog' };
                }
                return this._checkAvailabilityFromProducts(products, providerCountry, providerService);
            }

            if (response.status >= 400)
