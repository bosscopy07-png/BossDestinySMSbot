import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * CheapPanelProvider — 5SIM API Integration
 * 
 * FIXED:
 * - Added mandatory balance check before EVERY purchase attempt
 * - Balance insufficient → throws NO_BALANCE (recoverable: false) → orchestrator skips provider
 * - Correct API endpoint: /guest/prices
 * - Product caching with structure validation
 * - Enhanced error logging for HTTP 400 responses
 * - Pre-flight availability check before purchase
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

        this.operatorMap = {
            'default': 'any',
            'usa': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual8', 'virtual12', 'virtual15', 'virtual16', 'virtual20', 'virtual21', 'virtual23', 'virtual24', 'virtual25', 'virtual26', 'virtual29', 'virtual30', 'virtual31', 'virtual32', 'virtual33', 'virtual34', 'virtual35', 'virtual36', 'virtual37', 'virtual38', 'virtual39', 'virtual40', 'virtual41', 'virtual42', 'virtual43', 'virtual44', 'virtual45'],
            'england': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual8', 'virtual16', 'virtual21', 'virtual26', 'virtual30', 'virtual32', 'virtual38'],
            'canada': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual16', 'virtual21', 'virtual26'],
            'russia': ['any', 'beeline', 'megafon', 'mts', 'tele2', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual8', 'virtual16', 'virtual21', 'virtual26'],
            'china': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual16'],
            'india': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual16', 'virtual21'],
            'germany': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual16', 'virtual21', 'virtual26'],
            'france': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual16', 'virtual21'],
            'brazil': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual16'],
            'mexico': ['any', 'virtual2', 'virtual4', 'virtual5', 'virtual7', 'virtual16']
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

        // FIXED: Cache balance to avoid repeated API calls
        this.balanceCache = null;
        this.balanceCacheTime = 0;
        this.balanceCacheTtl = 30 * 1000; // 30 seconds

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
    //  BALANCE CHECK (FIXED — added caching)
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
            const response = await this.request('get', this.endpoints.getProducts, null, 15000);
            const data = response.data;

            if (response.status >= 400) {
                logger.error('5SIM prices endpoint returned error', { 
                    status: response.status, 
                    data: response.data 
                });
                return null;
            }

            if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
                logger.error('5SIM prices returned invalid data structure', { 
                    data,
                    type: typeof data,
                    isArray: Array.isArray(data)
                });
                return null;
            }

            const firstCountry = Object.values(data)[0];
            if (!firstCountry || typeof firstCountry !== 'object') {
                logger.error('5SIM prices data missing country structure', { firstCountry });
                return null;
            }

            this.productsCache = data;
            this.productsCacheTime = now;

            logger.info('5SIM products cache refreshed', { 
                countries: Object.keys(data).length,
                sampleCountry: Object.keys(data)[0]
            });

            return data;
        } catch (error) {
            logger.error('Failed to fetch 5SIM prices', { error: error.message });
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

            if (response.status >= 400) {
                const products = await this.getProducts();
                if (!products) {
                    return { available: false, error: `Failed to fetch product catalog. HTTP ${response.status}` };
                }
                return this._checkAvailabilityFromProducts(products, providerCountry, providerService);
            }

            const data = response.data;
            if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
                return { available: false, error: `No data returned for ${providerCountry}/${providerService}` };
            }

            return this._checkAvailabilityFromProducts(data, providerCountry, providerService);

        } catch (error) {
            return { available: false, error: error.message };
        }
    }

    _checkAvailabilityFromProducts(products, providerCountry, providerService) {
        const countryData = products[providerCountry];
        if (!countryData) {
            return { available: false, error: `Country ${providerCountry} not available` };
        }

        const serviceData = countryData[providerService];
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
    //  NUMBER ACQUISITION (FIXED — mandatory balance check)
    // ═══════════════════════════════════════════════════════════

    async getNumber(country = 'US', service = 'Any', preferredOperator = 'any') {
        const startTime = Date.now();

        try {
            if (!this.isActive) {
                throw new Error('PROVIDER_NOT_CONFIGURED');
            }

            // FIXED: Mandatory balance check BEFORE any API call
            const balanceResult = await this.checkBalance();
            if (!balanceResult.success || balanceResult.balance <= 0) {
                logger.error('5SIM balance insufficient or check failed', { 
                    balance: balanceResult.balance,
                    error: balanceResult.error 
                });
                throw new Error('NO_BALANCE: Insufficient 5SIM balance. Fund wallet at 5sim.net');
            }

            // Pre-flight availability check
            const availability = await this.checkAvailability(country, service);
            if (!availability.available) {
                throw new Error(`NOT_AVAILABLE: ${service} not available in ${country}. ${availability.error || ''}`);
            }

            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);
            const operator = this.mapOperator(providerCountry, preferredOperator);

            if (availability.operators && !availability.operators.includes(operator) && operator !== 'any') {
                logger.warn('Preferred operator not available, falling back to any', {
                    operator,
                    available: availability.operators
                });
            }

            logger.info('Requesting number from 5SIM', {
                country: providerCountry,
                service: providerService,
                operator,
                originalCountry: country,
                originalService: service,
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

            if (statusCode >= 400) {
                const errorMsg = data?.error || data?.message || `HTTP ${statusCode}`;
                
                if (errorMsg.toLowerCase().includes('not enough user balance') || 
                    errorMsg.toLowerCase().includes('no balance') ||
                    errorMsg.toLowerCase().includes('insufficient funds')) {
                    throw new Error(`NO_BALANCE: ${errorMsg}`);
                }

                if (statusCode === 404) {
                    if (errorMsg.includes('country') || errorMsg.includes('not found')) {
                        throw new Error(`BAD_COUNTRY: ${providerCountry} not available`);
                    }
                    if (errorMsg.includes('service') || errorMsg.includes('product')) {
                        throw new Error(`BAD_SERVICE: ${providerService} not available in ${providerCountry}`);
                    }
                    throw new Error(`NOT_AVAILABLE: ${errorMsg}`);
                }
                
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
                operator,
                price: data.price,
                duration
            });

            return {
                phoneNumber: phoneStr,
                provider: this.name,
                providerNumberId: activationId,
                country,
                service,
                cost: parseFloat(data.price) || 0.02,
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
                error: error.message
            });

            throw this.handleError(error);
        }
    }

    // ════════════
