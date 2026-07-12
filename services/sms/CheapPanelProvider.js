// ═══════════════════════════════════════════════════════════════════════════════
//  services/CheapPanelProvider.js — 5SIM API Integration
//  FIXED: 
//   1. mapService() preserves original name if 5sim supports it directly
//   2. Dynamic service discovery — tries exact name first, then fallbacks
//   3. Cache TTL increased to 60 minutes
//   4. Rate limit queue prevents 429 errors
//   5. Service fallback chain for unknown services
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

const BASE_PROFIT = 0.10;

/**
 * CheapPanelProvider — 5SIM API Integration
 * 
 * CHANGES:
 *   1. mapService() tries exact lowercase name first, then serviceMap, then fallbacks
 *   2. Preserves original service name in purchase results to prevent INVALID_SERVICE
 *   3. Cache TTL: 60 minutes for products, 5 minutes for balance
 *   4. Token bucket rate limiting prevents 429 errors
 *   5. Dynamic service fallback chain
 */
class CheapPanelProvider {
    constructor() {
        this.name = 'CHEAP_PANEL';
        this.tier = 'CHEAP';
        this.providerKey = 'CHEAP_PANEL';
        
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

        // ─── SERVICE MAP: Display name → 5sim internal name ──────────────────────
        // For known services, map to 5sim's internal name
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
            'Google': 'google',
            'Microsoft': 'microsoft',
            'Yahoo': 'yahoo',
            'Rebtel': 'rebtel',
            'Signal': 'signal',
            'LinkedIn': 'linkedin',
            'WeChat': 'wechat',
            'Line': 'line',
            'Any': 'other',
            'Other': 'other'
        };

        // ─── SERVICE FALLBACK CHAIN: unknown → fallback ───────────────────────────
        // If exact name not in serviceMap, try these fallbacks
        this.serviceFallbackMap = {
            'rebtel': ['rebtel', 'other'],
            'gmail': ['google', 'other'],
            'outlook': ['microsoft', 'other'],
            'google': ['google', 'other'],
            'microsoft': ['microsoft', 'other'],
            'yahoo': ['yahoo', 'other'],
            'signal': ['signal', 'other'],
            'linkedin': ['linkedin', 'other'],
            'wechat': ['wechat', 'other'],
            'line': ['line', 'other']
        };

        // ─── COUNTRY MAP: ISO → 5sim country code ─────────────────────────────────
        this.countryMap = {
    'US': 'usa',
    'UK': 'england',
    'GB': 'england',
    'CA': 'canada',
    'MX': 'mexico',
    'GT': 'guatemala',
    'BZ': 'belize',
    'SV': 'elsalvador',
    'HN': 'honduras',
    'NI': 'nicaragua',
    'CR': 'costarica',
    'PA': 'panama',
    'CU': 'cuba',
    'DO': 'dominicanrepublic',
    'HT': 'haiti',
    'JM': 'jamaica',
    'TT': 'trinidadandtobago',
    'BS': 'bahamas',
    'BB': 'barbados',

    'AR': 'argentina',
    'BO': 'bolivia',
    'BR': 'brazil',
    'CL': 'chile',
    'CO': 'colombia',
    'EC': 'ecuador',
    'GY': 'guyana',
    'PY': 'paraguay',
    'PE': 'peru',
    'SR': 'suriname',
    'UY': 'uruguay',
    'VE': 'venezuela',

    'AL': 'albania',
    'AD': 'andorra',
    'AT': 'austria',
    'BY': 'belarus',
    'BE': 'belgium',
    'BA': 'bosnia',
    'BG': 'bulgaria',
    'HR': 'croatia',
    'CY': 'cyprus',
    'CZ': 'czech',
    'DK': 'denmark',
    'EE': 'estonia',
    'FI': 'finland',
    'FR': 'france',
    'DE': 'germany',
    'GR': 'greece',
    'HU': 'hungary',
    'IS': 'iceland',
    'IE': 'ireland',
    'IT': 'italy',
    'XK': 'kosovo',
    'LV': 'latvia',
    'LI': 'liechtenstein',
    'LT': 'lithuania',
    'LU': 'luxembourg',
    'MT': 'malta',
    'MD': 'moldova',
    'MC': 'monaco',
    'ME': 'montenegro',
    'NL': 'netherlands',
    'MK': 'macedonia',
    'NO': 'norway',
    'PL': 'poland',
    'PT': 'portugal',
    'RO': 'romania',
    'RU': 'russia',
    'SM': 'sanmarino',
    'RS': 'serbia',
    'SK': 'slovakia',
    'SI': 'slovenia',
    'ES': 'spain',
    'SE': 'sweden',
    'CH': 'switzerland',
    'UA': 'ukraine',
    'VA': 'vatican',

    'AM': 'armenia',
    'AZ': 'azerbaijan',
    'BH': 'bahrain',
    'BD': 'bangladesh',
    'BT': 'bhutan',
    'BN': 'brunei',
    'KH': 'cambodia',
    'CN': 'china',
    'GE': 'georgia',
    'HK': 'hongkong',
    'IN': 'india',
    'ID': 'indonesia',
    'IR': 'iran',
    'IQ': 'iraq',
    'IL': 'israel',
    'JP': 'japan',
    'JO': 'jordan',
    'KZ': 'kazakhstan',
    'KW': 'kuwait',
    'KG': 'kyrgyzstan',
    'LA': 'laos',
    'LB': 'lebanon',
    'MY': 'malaysia',
    'MV': 'maldives',
    'MN': 'mongolia',
    'MM': 'myanmar',
    'NP': 'nepal',
    'KP': 'northkorea',
    'KR': 'southkorea',
    'OM': 'oman',
    'PK': 'pakistan',
    'PS': 'palestine',
    'PH': 'philippines',
    'QA': 'qatar',
    'SA': 'saudiarabia',
    'SG': 'singapore',
    'LK': 'srilanka',
    'SY': 'syria',
    'TW': 'taiwan',
    'TJ': 'tajikistan',
    'TH': 'thailand',
    'TL': 'timorleste',
    'TR': 'turkey',
    'TM': 'turkmenistan',
    'AE': 'uae',
    'UZ': 'uzbekistan',
    'VN': 'vietnam',
    'YE': 'yemen',

    'DZ': 'algeria',
    'AO': 'angola',
    'BJ': 'benin',
    'BW': 'botswana',
    'BF': 'burkinafaso',
    'BI': 'burundi',
    'CM': 'cameroon',
    'CV': 'capeverde',
    'CF': 'centralafricanrepublic',
    'TD': 'chad',
    'KM': 'comoros',
    'CG': 'congo',
    'CD': 'drcongo',
    'DJ': 'djibouti',
    'EG': 'egypt',
    'GQ': 'equatorialguinea',
    'ER': 'eritrea',
    'SZ': 'eswatini',
    'ET': 'ethiopia',
    'GA': 'gabon',
    'GM': 'gambia',
    'GH': 'ghana',
    'GN': 'guinea',
    'GW': 'guineabissau',
    'CI': 'ivorycoast',
    'KE': 'kenya',
    'LS': 'lesotho',
    'LR': 'liberia',
    'LY': 'libya',
    'MG': 'madagascar',
    'MW': 'malawi',
    'ML': 'mali',
    'MR': 'mauritania',
    'MU': 'mauritius',
    'MA': 'morocco',
    'MZ': 'mozambique',
    'NA': 'namibia',
    'NE': 'niger',
    'NG': 'nigeria',
    'RW': 'rwanda',
    'ST': 'saotomeandprincipe',
    'SN': 'senegal',
    'SC': 'seychelles',
    'SL': 'sierraleone',
    'SO': 'somalia',
    'ZA': 'southafrica',
    'SS': 'southsudan',
    'SD': 'sudan',
    'TZ': 'tanzania',
    'TG': 'togo',
    'TN': 'tunisia',
    'UG': 'uganda',
    'ZM': 'zambia',
    'ZW': 'zimbabwe',

    'AU': 'australia',
    'NZ': 'newzealand',
    'FJ': 'fiji',
    'PG': 'papuanewguinea',
    'WS': 'samoa',
    'SB': 'solomonislands',
    'TO': 'tonga',
    'VU': 'vanuatu'
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

        // ─── RATE LIMITING: Token bucket (prevents 429) ─────────────────────────
        this._maxRps = 3; // 3 requests per second max (conservative)
        this._tokens = this._maxRps;
        this._lastRefill = Date.now();
        this._tokenInterval = 1000 / this._maxRps;
        this._requestQueue = [];
        this._isProcessingQueue = false;

        // ─── CACHE: 60 minutes for products, 5 minutes for balance ───────────────
        this.productsCache = null;
        this.productsCacheTime = 0;
        this.productsCacheTtl = 60 * 60 * 1000; // 60 minutes

        this.balanceCache = null;
        this.balanceCacheTime = 0;
        this.balanceCacheTtl = 5 * 60 * 1000; // 5 minutes

        // ─── PREWARM: Background cache refresh ───────────────────────────────────
        this._prewarmInterval = null;
        if (this.isActive) {
            this._startPrewarm();
            this.checkBalance().catch(err => 
                logger.warn('Initial balance check failed', { error: err.message })
            );
            logger.info('CheapPanelProvider initialized', {
                provider: this.name,
                baseUrl: this.baseUrl,
                hasKey: !!this.apiKey,
                cacheTtl: '60min'
            });
        } else {
            logger.warn('CheapPanelProvider disabled - no API key configured');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  PREWARM: Background cache refresh every 50 minutes
    // ═══════════════════════════════════════════════════════════

    _startPrewarm() {
        // Initial prewarm
        this.prewarmCache().catch(() => {});
        
        // Refresh every 50 minutes (before 60min expiry)
        this._prewarmInterval = setInterval(() => {
            if (this.isActive) {
                this.prewarmCache().catch(err => 
                    logger.debug('Prewarm failed', { error: err.message })
                );
            }
        }, 50 * 60 * 1000);
    }

    async prewarmCache() {
        try {
            logger.info('Prewarming 5SIM cache...');
            await this.getProducts();
            logger.info('5SIM cache prewarmed', { 
                hasProducts: !!this.productsCache,
                productCountries: this.productsCache ? Object.keys(this.productsCache).length : 0
            });
        } catch (error) {
            logger.warn('Prewarm failed', { error: error.message });
        }
    }

    stopPrewarm() {
        if (this._prewarmInterval) {
            clearInterval(this._prewarmInterval);
            this._prewarmInterval = null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  TOKEN BUCKET + REQUEST QUEUE (prevents 429)
    // ═══════════════════════════════════════════════════════════

    _refillTokens() {
        const now = Date.now();
        const elapsed = now - this._lastRefill;
        const tokensToAdd = Math.floor(elapsed / this._tokenInterval);
        if (tokensToAdd > 0) {
            this._tokens = Math.min(this._maxRps, this._tokens + tokensToAdd);
            this._lastRefill = now;
        }
    }

    async _acquireToken() {
        this._refillTokens();
        if (this._tokens > 0) {
            this._tokens--;
            return true;
        }
        const waitMs = this._tokenInterval - (Date.now() - this._lastRefill) % this._tokenInterval;
        await new Promise(r => setTimeout(r, waitMs + 50));
        return this._acquireToken();
    }

    async queuedRequest(method, endpoint, data = null, timeout = 10000) {
        return new Promise((resolve, reject) => {
            this._requestQueue.push({ method, endpoint, data, timeout, resolve, reject, retries: 0 });
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this._isProcessingQueue || this._requestQueue.length === 0) return;
        this._isProcessingQueue = true;
        await this._acquireToken();
        
        const { method, endpoint, data, timeout, resolve, reject, retries } = this._requestQueue.shift();
        
        try {
            const result = await this.request(method, endpoint, data, timeout);
            resolve(result);
        } catch (error) {
            if (error.message?.includes('429') && retries < 3) {
                const backoff = Math.min(60000, 2000 * Math.pow(2, retries));
                logger.warn('5SIM rate limited, retrying', { endpoint, retry: retries + 1, backoff });
                setTimeout(() => {
                    this._requestQueue.unshift({ method, endpoint, data, timeout, resolve, reject, retries: retries + 1 });
                    this._isProcessingQueue = false;
                    this._processQueue();
                }, backoff);
                return;
            }
            reject(error);
        } finally {
            this._isProcessingQueue = false;
            setTimeout(() => this._processQueue(), this._tokenInterval);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  CORE REQUEST (unchanged logic, called by queue)
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
    //  DISPLAY PRICE (unchanged)
    // ═══════════════════════════════════════════════════════════

    getDisplayPrice(rawPrice) {
        const price = parseFloat(rawPrice) || 0;
        if (price <= 0) return null;
        return parseFloat((price + BASE_PROFIT).toFixed(4));
    }

    // ═══════════════════════════════════════════════════════════
    //  GET PRICE (with service fallback chain)
    // ═══════════════════════════════════════════════════════════

    async getPrice(country = 'US', service = 'Any') {
        try {
            const providerCountry = this.mapCountry(country);
            
            // Try primary service mapping first
            let providerService = this.mapService(service);
            let usedService = providerService;

            const targetedEndpoint = `${this.endpoints.getPrices}?country=${providerCountry}&product=${providerService}`;
            
            let response;
            try {
                response = await this.queuedRequest('get', targetedEndpoint, null, 10000);
            } catch (err) {
                // If failed, try fallback services
                const fallbacks = this._getServiceFallbacks(service);
                for (const fallback of fallbacks) {
                    if (fallback === providerService) continue;
                    try {
                        const fbEndpoint = `${this.endpoints.getPrices}?country=${providerCountry}&product=${fallback}`;
                        response = await this.queuedRequest('get', fbEndpoint, null, 10000);
                        usedService = fallback;
                        logger.info('Used service fallback for price', { 
                            original: service, 
                            mapped: providerService, 
                            fallback: fallback 
                        });
                        break;
                    } catch (fbErr) {
                        continue;
                    }
                }
                
                if (!response) {
                    // All fallbacks failed, use full catalog
                    const products = await this.getProducts();
                    if (!products) {
                        return { success: false, error: 'Failed to fetch product catalog' };
                    }
                    return this._extractPriceFromProducts(products, providerCountry, providerService, service);
                }
            }

            if (response.status >= 400) {
                const products = await this.getProducts();
                if (!products) {
                    return { success: false, error: `Failed to fetch product catalog. HTTP ${response.status}` };
                }
                return this._extractPriceFromProducts(products, providerCountry, providerService, service);
            }

            const data = response.data;
            if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
                return { success: false, error: `No data returned for ${providerCountry}/${providerService}` };
            }

            return this._extractPriceFromProducts(data, providerCountry, usedService, service);

        } catch (error) {
            logger.error('Failed to get price', { country, service, error: error.message });
            return { success: false, error: error.message };
        }
    }

    /**
     * Get fallback services to try
     */
    _getServiceFallbacks(service) {
        const normalized = service.toString().trim().toLowerCase();
        const fallbacks = this.serviceFallbackMap[normalized] || [];
        return [...new Set([normalized, ...fallbacks, 'other'])];
    }

    // ═══════════════════════════════════════════════════════════
    //  EXTRACT PRICE FROM PRODUCTS (preserves original service name)
    // ═══════════════════════════════════════════════════════════

    _extractPriceFromProducts(products, providerCountry, providerService, originalService = null) {
        const countryData = products[providerCountry];
        if (!countryData) {
            return { success: false, error: `Country ${providerCountry} not available` };
        }

        let serviceData = countryData[providerService];
        
        // If exact service not found, try fallbacks
        if (!serviceData && originalService) {
            const fallbacks = this._getServiceFallbacks(originalService);
            for (const fb of fallbacks) {
                if (countryData[fb]) {
                    serviceData = countryData[fb];
                    logger.debug('Used service fallback in products', { 
                        original: originalService, 
                        fallback: fb 
                    });
                    break;
                }
            }
        }

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
            available: true,
            originalService: originalService || providerService,
            mappedService: providerService
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  GET AVAILABLE COUNTRIES (with service fallback)
    // ═══════════════════════════════════════════════════════════

    async getAvailableCountries(service = 'Any') {
        try {
            const providerService = this.mapService(service);
            const products = await this.getProducts();
            
            if (!products) {
                return { success: false, error: 'Failed to fetch products' };
            }

            const availableCountries = [];
            const fallbacks = this._getServiceFallbacks(service);
            
            for (const [simCountry, services] of Object.entries(products)) {
                // Check primary service and all fallbacks
                let serviceData = services[providerService];
                let usedFallback = null;
                
                if (!serviceData) {
                    for (const fb of fallbacks) {
                        if (fb === providerService) continue;
                        if (services[fb]) {
                            serviceData = services[fb];
                            usedFallback = fb;
                            break;
                        }
                    }
                }

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
                            name: this._getCountryName(isoCode),
                            fallbackService: usedFallback
                        });
                    }
                }
            }

            availableCountries.sort((a, b) => a.name.localeCompare(b.name));

            return {
                success: true,
                countries: availableCountries,
                count: availableCountries.length,
                originalService: service,
                mappedService: providerService
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
    //  CHECK BALANCE (uses queuedRequest, 5min cache)
    // ═══════════════════════════════════════════════════════════

    async checkBalance() {
        const now = Date.now();
        if (this.balanceCache && (now - this.balanceCacheTime) < this.balanceCacheTtl) {
            return this.balanceCache;
        }

        try {
            const response = await this.queuedRequest('get', this.endpoints.getBalance, null, 10000);
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
    //  GET PRODUCTS (60min cache)
    // ═══════════════════════════════════════════════════════════

    async getProducts() {
        const now = Date.now();
        if (this.productsCache && (now - this.productsCacheTime) < this.productsCacheTtl) {
            return this.productsCache;
        }

        try {
            const response = await this.queuedRequest('get', this.endpoints.getProducts, null, 30000);
            this.productsCache = response.data;
            this.productsCacheTime = now;
            logger.info('5SIM products fetched', { 
                countries: Object.keys(this.productsCache).length,
                cacheExpiry: new Date(now + this.productsCacheTtl).toISOString()
            });
            return this.productsCache;
        } catch (error) {
            logger.error('Failed to fetch 5SIM products', { error: error.message });
            // Return stale cache if available
            if (this.productsCache) {
                logger.warn('Returning stale product cache');
                return this.productsCache;
            }
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  CHECK AVAILABILITY (with service fallback)
    // ═══════════════════════════════════════════════════════════

    async checkAvailability(country, service) {
        try {
            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);
            const fallbacks = this._getServiceFallbacks(service);

            const targetedEndpoint = `${this.endpoints.getProducts}?country=${providerCountry}&product=${providerService}`;
            
            let response;
            let usedService = providerService;
            
            try {
                response = await this.queuedRequest('get', targetedEndpoint, null, 10000);
            } catch (err) {
                // Try fallback services
                for (const fb of fallbacks) {
                    if (fb === providerService) continue;
                    try {
                        const fbEndpoint = `${this.endpoints.getProducts}?country=${providerCountry}&product=${fb}`;
                        response = await this.queuedRequest('get', fbEndpoint, null, 10000);
                        usedService = fb;
                        break;
                    } catch (fbErr) {
                        continue;
                    }
                }
                
                if (!response) {
                    const products = await this.getProducts();
                    if (!products) {
                        return { available: false, error: 'Failed to fetch product catalog' };
                    }
                    return this._checkAvailabilityFromProducts(products, providerCountry, providerService, service);
                }
            }

            if (response.status >= 400) {
                const products = await this.getProducts();
                if (!products) {
                    return { available: false, error: `Failed to fetch product catalog. HTTP ${response.status}` };
                }
                return this._checkAvailabilityFromProducts(products, providerCountry, providerService, service);
            }

            const data = response.data;
            if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
                return { available: false, error: `No data returned for ${providerCountry}/${providerService}` };
            }

            return this._checkAvailabilityFromProducts(data, providerCountry, usedService, service);

        } catch (error) {
            return { available: false, error: error.message };
        }
    }

    _checkAvailabilityFromProducts(products, providerCountry, providerService, originalService = null) {
        const countryData = products[providerCountry];
        if (!countryData) {
            return { available: false, error: `Country ${providerCountry} not available` };
        }

        let serviceData = countryData[providerService];
        
        // Try fallbacks if primary not found
        if (!serviceData && originalService) {
            const fallbacks = this._getServiceFallbacks(originalService);
            for (const fb of fallbacks) {
                if (countryData[fb]) {
                    serviceData = countryData[fb];
                    break;
                }
            }
        }

        if (!serviceData) {
            return { available: false, error: `Service ${providerService} not available in ${providerCountry}` };
        }

        const operators = serviceData;
        const operatorNames = Object.keys(operators);
        
        const hasStock = operatorNames.some(opName => {
            const op = operators[opName];
            const count = typeof op === 'object' ? (op.count ?? 0) : (typeof op === 'number' ? op : 0);
            return count > 0;
        });

        return { 
            available: hasStock, 
            operators: operatorNames,
            data: serviceData 
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  GET NUMBER (preserves original service name in result)
    // ═══════════════════════════════════════════════════════════

    async getNumber(country = 'US', service = 'Any', preferredOperator = 'any') {
        const startTime = Date.now();
        const originalService = service; // PRESERVE original name

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
            
            const response = await this.queuedRequest('get', endpoint, null, 30000);
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

            if (statusCode >= 400 || !data || typeof data !== 'object') {
                const errorMsg = data?.error || data?.message || (typeof data === 'string' ? data : null) || `HTTP ${statusCode}`;
                const isEmptyResponse = !data || (typeof data === 'string' && data.trim() === '');
                
                const lowerMsg = (errorMsg || '').toLowerCase();
                if (lowerMsg.includes('not enough user balance') || 
                    lowerMsg.includes('no balance') ||
                    lowerMsg.includes('insufficient funds')) {
                    throw new Error(`NO_BALANCE: ${errorMsg}`);
                }

                if (statusCode === 404 || isEmptyResponse) {
                    throw new Error(`NOT_AVAILABLE: ${service} not available in ${country} with operator ${operator}. Try another country or operator.`);
                }

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

            // CRITICAL: Return originalService to prevent INVALID_SERVICE downstream
            return {
                phoneNumber: phoneStr,
                provider: this.name,
                providerNumberId: activationId,
                country,
                service: originalService,        // ← PRESERVE ORIGINAL
                mappedService: providerService,  // ← 5sim internal name
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
    //  CHECK SMS (uses queuedRequest)
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
            const response = await this.queuedRequest('get', endpoint, null, 15000);
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
    //  EXTRACT OTP (unchanged)
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

    // ═══════════════════════════════════════════════════════════
    //  CANCEL NUMBER (uses queuedRequest)
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
            const response = await this.queuedRequest('get', endpoint);

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

    // ═══════════════════════════════════════════════════════════
    //  FINISH NUMBER (uses queuedRequest)
    // ═══════════════════════════════════════════════════════════

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
            await this.queuedRequest('get', endpoint);

            logger.info('Activation marked as finished', { activationId: cleanId });
            return { success: true, status: 'FINISHED' };

        } catch (error) {
            logger.warn('Finish request failed', { activationId, error: error.message });
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GET PRICES (alias for getPrice)
    // ═══════════════════════════════════════════════════════════

    async getPrices(country = 'US', service = 'Any') {
        return this.getPrice(country, service);
    }

    // ═══════════════════════════════════════════════════════════
    //  MAP SERVICE: Try exact name first, then serviceMap, then fallbacks
    // ═══════════════════════════════════════════════════════════

    mapService(service) {
        if (!service || service === 'Any') return 'other';
        
        const normalized = service.toString().trim();
        const lower = normalized.toLowerCase();
        
        // 1. Try exact match in serviceMap (preserves casing)
        const exactMapped = this.serviceMap[normalized];
        if (exactMapped) return exactMapped;
        
        // 2. Try lowercase match
        const lowerMapped = this.serviceMap[normalized.toLowerCase()];
        if (lowerMapped) return lowerMapped;
        
        // 3. Try serviceFallbackMap
        const fallbacks = this.serviceFallbackMap[lower];
        if (fallbacks && fallbacks.length > 0) {
            logger.debug('Using service fallback', { original: service, fallback: fallbacks[0] });
            return fallbacks[0];
        }
        
        // 4. Try lowercase exact (5sim might support it directly)
        // This fixes "Rebtel" → "rebtel" instead of "other"
        logger.debug('Using direct lowercase service name', { original: service, mapped: lower });
        return lower;
    }

    // ═══════════════════════════════════════════════════════════
    //  MAP COUNTRY (unchanged)
    // ═══════════════════════════════════════════════════════════

    mapCountry(country) {
        if (!country) throw new Error('BAD_COUNTRY: Country required');
        const mapped = this.countryMap[country.toUpperCase()];
        if (!mapped) throw new Error(`BAD_COUNTRY: ${country} not supported`);
        return mapped;
    }

    // ═══════════════════════════════════════════════════════════
    //  MAP OPERATOR (unchanged)
    // ═══════════════════════════════════════════════════════════

    mapOperator(country, preferred) {
        if (!preferred || preferred === 'any') {
            return 'any';
        }
        return preferred;
    }

    // ═══════════════════════════════════════════════════════════
    //  VALIDATION HELPERS (unchanged)
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
    //  STATS (unchanged)
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
