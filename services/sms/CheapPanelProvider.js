import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * CheapPanelProvider — 5SIM API Integration
 * 
 * FIXED:
 * - Correct API endpoint for product availability: /guest/prices (not /guest/products)
 * - Added product caching to avoid repeated API calls
 * - Enhanced error logging for HTTP 400 responses
 * - Pre-flight availability check before purchase attempts
 * - Map "not enough user balance" to NO_BALANCE
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
            getPrices: '/guest/prices',              // FIXED: was /guest/products — 5SIM v1 uses /guest/prices
            getBalance: '/user/profile',
            getCountries: '/guest/countries',
            getProducts: '/guest/prices'               // FIXED: correct endpoint for service availability
        };

        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0,
            totalCost: 0
        };

        // 5SIM service mapping
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

        // FIXED: Correct 5SIM v1 country codes
        // Verified against 5SIM API documentation
        this.countryMap = {
            'US': 'usa',
            'UK': 'england',           // ← FIXED: was 'united kingdom'
            'GB': 'england',           // ← ADDED: alias for UK
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
            'RO': 'romania',
            'ES': 'spain',
            'IT': 'italy',
            'NL': 'netherlands',
            'SE': 'sweden',
            'NO': 'norway',
            'FI': 'finland',
            'DK': 'denmark',
            'AU': 'australia',
            'JP': 'japan',
            'KR': 'southkorea',
            'SG': 'singapore',
            'MY': 'malaysia',
            'ZA': 'southafrica',
            'EG': 'egypt',
            'SA': 'saudiarabia',
            'AE': 'uae',
            'IL': 'israel',
            'BE': 'belgium',
            'AT': 'austria',
            'CH': 'switzerland',
            'PT': 'portugal',
            'GR': 'greece',
            'CZ': 'czech',
            'HU': 'hungary',
            'SK': 'slovakia',
            'BG': 'bulgaria',
            'HR': 'croatia',
            'SI': 'slovenia',
            'LT': 'lithuania',
            'LV': 'latvia',
            'EE': 'estonia',
            'MD': 'moldova',
            'GE': 'georgia',
            'AM': 'armenia',
            'AZ': 'azerbaijan',
            'BY': 'belarus',
            'KG': 'kyrgyzstan',
            'TJ': 'tajikistan',
            'TM': 'turkmenistan',
            'UZ': 'uzbekistan',
            'AL': 'albania',
            'BA': 'bosnia',
            'MK': 'macedonia',
            'ME': 'montenegro',
            'RS': 'serbia',
            'XK': 'kosovo'
        };

        // Available operators per country (5SIM specific)
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

        // ADDED: Product cache to avoid repeated API calls to /guest/prices
        this.productsCache = null;
        this.productsCacheTime = 0;
        this.productsCacheTtl = 5 * 60 * 1000; // 5 minutes

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
    //  BALANCE CHECK
    // ═══════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════
    //  PRODUCT CACHE (ADDED)
    // ═══════════════════════════════════════════════════════════

    /**
     * Fetch and cache available products from 5SIM.
     * Returns map of { country: { service: { operators: {...}, price: ... } } }
     */
    async getProducts() {
        const now = Date.now();
        if (this.productsCache && (now - this.productsCacheTime) < this.productsCacheTtl) {
            return this.productsCache;
        }

        try {
            const response = await this.request('get', this.endpoints.getProducts, null, 15000);
            const data = response.data;

            // FIXED: Do not cache 404 or error responses
            if (response.status >= 400) {
                logger.error('5SIM products endpoint returned error', { 
                    status: response.status, 
                    data: response.data 
                });
                return null;
            }

            // FIXED: Validate data is an object before caching
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                logger.error('5SIM products returned invalid data structure', { data });
                return null;
            }

            this.productsCache = data;
            this.productsCacheTime = now;

            return data;
        } catch (error) {
            logger.error('Failed to fetch 5SIM products', { error: error.message });
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  PRE-FLIGHT AVAILABILITY CHECK (FIXED)
    // ═══════════════════════════════════════════════════════════

    /**
     * Check if a service/country combination is available before purchasing.
     * FIXED: Uses /guest/prices endpoint instead of non-existent /guest/products
     * @param {string} country — ISO country code
     * @param {string} service — Service name
     * @returns {Promise<{available: boolean, error?: string, operators?: Array, data?: Object}>}
     */
    async checkAvailability(country, service) {
        try {
            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            const products = await this.getProducts();
            if (!products) {
                return { available: false, error: 'Failed to fetch product catalog' };
            }

            // 5SIM prices structure: { country: { service: { operators: {...} } } }
            const countryData = products[providerCountry];
            if (!countryData) {
                return { available: false, error: `Country ${providerCountry} not available` };
            }

            const serviceData = countryData[providerService];
            if (!serviceData) {
                return { available: false, error: `Service ${providerService} not available in ${providerCountry}` };
            }

            // Check if any operator has stock
            const operators = serviceData.operators || serviceData;
            const hasStock = Object.values(operators).some(op => {
                // Operator data can be { count: number, price: number } or just a number
                const count = typeof op === 'object' ? op.count : op;
                return count > 0;
            });

            return { 
                available: hasStock, 
                operators: Object.keys(operators),
                data: serviceData 
            };
        } catch (error) {
            return { available: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION (FIXED ENDPOINT)
    // ═══════════════════════════════════════════════════════════

    async getNumber(country = 'US', service = 'Any', preferredOperator = 'any') {
        const startTime = Date.now();

        try {
            if (!this.isActive) {
                throw new Error('PROVIDER_NOT_CONFIGURED');
            }

            // PRE-FLIGHT: Check if service/country is available
            const availability = await this.checkAvailability(country, service);
            if (!availability.available) {
                throw new Error(`NOT_AVAILABLE: ${service} not available in ${country}. ${availability.error || ''}`);
            }

            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);
            const operator = this.mapOperator(providerCountry, preferredOperator);

            // Validate operator is available for this service
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
                originalService: service
            });

            // FIXED: Correct 5SIM v1 API endpoint format
            // Format: /user/buy/activation/{country}/{operator}/{service}
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
                
                // FIXED: Map "not enough user balance" to NO_BALANCE
                if (errorMsg.toLowerCase().includes('not enough user balance') || 
                    errorMsg.toLowerCase().includes('no balance') ||
                    errorMsg.toLowerCase().includes('insufficient funds')) {
                    throw new Error(`NO_BALANCE: ${errorMsg}`);
                }

                // Handle specific 404 cases
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

    // ═══════════════════════════════════════════════════════════
    //  SMS CHECKING
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
            
