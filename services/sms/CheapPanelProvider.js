import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * CheapPanelProvider — 5SIM API Integration
 * 
 * FIXED:
 * - Added getDisplayPrice() for dynamic profit margin
 * - Added getAvailableCountries() for dynamic country list
 * - Added getPriceForCountryService() for pre-purchase price check
 * - Fixed cancelNumber to properly handle 5SIM responses
 * - Balance caching to reduce API calls
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

        // Reverse map: 5SIM country code → ISO code
        this.reverseCountryMap = Object.fromEntries(
            Object.entries(this.countryMap).map(([iso, sim]) => [sim, iso])
        );

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
    //  DYNAMIC PRICING (NEW)
    // ═══════════════════════════════════════════════════════════

    /**
     * Calculate display price with profit margin
     * @param {number} simPrice - Actual 5SIM price
     * @returns {number} Price to charge user
     */
    getDisplayPrice(simPrice) {
        const price = parseFloat(simPrice) || 0;
        if (price <= 0.50) {
            return parseFloat((price + 0.20).toFixed(2));
        }
        return parseFloat((price + 0.30).toFixed(2));
    }

    /**
     * Get actual 5SIM price for country + service before purchase
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

        // Find cheapest operator with stock
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
    //  AVAILABLE COUNTRIES (NEW)
    // ═══════════════════════════════════════════════════════════

    /**
     * Get list of countries available on 5SIM with stock for a service
     */
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

                // Check if any operator has stock
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

            // Sort alphabetically by name
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
    //  BALANCE CHECK (FIXED — with caching)
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
    //  NUMBER ACQUISITION (FIXED — returns actual price)
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
            const simPrice = parseFloat(data.price) || 0;
            const displayPrice = this.getDisplayPrice(simPrice);
            
            this.updateStats(true, duration, simPrice);

            logger.info('Number acquired from 5SIM', {
                activationId,
                phone: this.maskPhone(phoneStr),
                country: providerCountry,
                service: providerService,
                operator,
                simPrice: simPrice,
                displayPrice: displayPrice,
                duration
            });

            return {
                phoneNumber: phoneStr,
                provider: this.name,
                providerNumberId: activationId,
                country,
                service,
                cost: simPrice,           // Actual 5SIM cost
                displayCost: displayPrice, // What user pays
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

        // ═══════════════════════════════════════════════════════════
    //  SMS CHECKING (FIXED — 5SIM returns "sms" not "text")
    // ═════════════════════════════════════════════════════════==

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
                hasSms: !!data?.sms
            });

            const status = (data?.status || '').toUpperCase();

            if (status === 'RECEIVED' || status === 'FINISHED') {
                // FIXED: 5SIM API returns SMS text in field "sms", NOT "text"
                const otp = this.extractOTP(data.code, data.sms);
                
                if (otp) {
                    return {
                        success: true,
                        otp,
                        status: 'RECEIVED',
                        fullText: data.sms || null,
                        receivedAt: new Date()
                    };
                }

                return {
                    success: false,
                    status: 'CHECKING',
                    rawText: data.sms,
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
    //  NUMBER MANAGEMENT (FIXED — proper cancel handling)
    // ═══════════════════════════════════════════════════════════

    async cancelNumber(activationId) {
        try {
            if (!this.isActive) {
                return { success: false, error: 'PROVIDER_NOT_CONFIGURED' };
            }

            if (!activationId) {
                return { success: false, error: 'MISSING_ACTIVATION_ID' };
            }

            // FIXED: Ensure we use numeric activation ID, not phone number
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
    //  LEGACY PRICING METHOD (kept for compatibility)
    // ═══════════════════════════════════════════════════════════

    async getPrices(country = 'US', service = 'Any') {
        return this.getPrice(country, service);
    }

    // ═══════════════════════════════════════════════════════════
    //  REQUEST HELPER
    // ═══════════════════════════════════════════════════════════

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
        
        const response = await axios(config);
        
        if (response.status >= 400) {
            logger.error('5SIM API error response', {
                url,
                status: response.status,
                statusText: response.statusText,
                data: response.data
            });
        }
        
        return response;
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

    mapOperator(country, preferred) {
        if (preferred && preferred !== 'any') {
            const operators = this.operatorMap[country] || this.operatorMap['default'];
            if (operators.includes(preferred)) return preferred;
        }
        return 'any';
    }

    // ═══════════════════════════════════════════════════════════
    //  VALIDATION HELPERS
    // ═══════════════════════════════════════════════════════════

    isFakeNumber(phone) {
        if (!phone) return true;
        const clean = phone.toString().replace(/\D/g, '');
        return this.fakeNumbers.has(clean) || this.fakeNumbers.has(phone);
    }

        extractOTP(code, text) {
        // FIXED: Handle 5SIM code field which can be string, number, or null
        if (code !== null && code !== undefined) {
            const codeStr = code.toString().trim();
            // 5SIM sometimes returns code with spaces or dashes
            const cleanCode = codeStr.replace(/[\s\-]/g, '');
            if (/^\d{4,8}$/.test(cleanCode)) {
                return cleanCode;
            }
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
            const match = text.match(pattern);
            if (match) {
                const otp = match[1] || match[0];
                const cleanOtp = otp.toString().replace(/\D/g, '');
                if (/^\d{4,8}$/.test(cleanOtp)) return cleanOtp;
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
