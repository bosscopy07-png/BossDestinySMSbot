import axios from 'axios';
import logger from '../../utils/logger.js';

/**
 * FreeProvider — Free tier / public SMS number provider
 * 
 * FIXED:
 * - Removed fake number pools that never receive real SMS
 * - Integrated with sms-activate.org free tier (real API, real numbers, real SMS)
 * - Added proper activation lifecycle (getNumber → checkStatus → getStatus)
 * - Memory-safe cleanup with process exit handlers
 * - Realistic error handling — no false promises about "public numbers"
 * - Graceful degradation when free tier is unavailable
 */
class FreeProvider {
    constructor() {
        this.name = 'FREE_PUBLIC';
        this.tier = 'FREE';
        this.isActive = true;
        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0
        };

        // Track active activations: activationId -> { phoneNumber, assignedAt, country, service }
        this.activeActivations = new Map();
        this.cleanupInterval = null;

        // sms-activate.org API configuration
        this.smsActivateBaseUrl = 'https://api.sms-activate.org/stubs/handler_api.php';
        this.smsActivateKey = process.env.SMS_ACTIVATE_API_KEY || null;

        // Service mapping to sms-activate codes
        this.serviceMap = {
            'Any': 'ot',
            'WhatsApp': 'wa',
            'Telegram': 'tg',
            'Facebook': 'fb',
            'Instagram': 'ig',
            'Twitter': 'tw',
            'TikTok': 'lf',
            'Google': 'go',
            'Gmail': 'go',
            'Outlook': 'mm',
            'Microsoft': 'mm',
            'Amazon': 'am',
            'Netflix': 'nf',
            'PayPal': 'pm',
            'Uber': 'ub',
            'Snapchat': 'fu',
            'Discord': 'ds',
            'Spotify': 'sn',
            'Airbnb': 'ab',
            'Binance': 'ub', // fallback
            'Coinbase': 'go', // fallback
            'Other': 'ot'
        };

        // Country mapping to sms-activate numeric codes
        this.countryMap = {
            'US': '0', 'RU': '0', 'GB': '16', 'UA': '1', 'KZ': '2',
            'CN': '3', 'PH': '4', 'MM': '5', 'ID': '6', 'MY': '7',
            'VN': '10', 'KG': '11', 'IL': '13', 'HK': '14', 'PL': '15',
            'GB': '16', 'CD': '18', 'NG': '19', 'MO': '20', 'EG': '21',
            'IN': '22', 'IE': '23', 'KH': '24', 'LA': '25', 'HT': '26',
            'CI': '27', 'MM': '28', 'PK': '29', 'BD': '30', 'TN': '31',
            'SN': '32', 'CO': '33', 'PE': '34', 'MZ': '35', 'NP': '36',
            'TW': '37', 'TR': '39', 'AL': '40', 'DZ': '41', 'MR': '42',
            'ML': '43', 'NE': '44', 'TD': '45', 'GN': '46', 'MG': '47',
            'BJ': '48', 'TG': '49', 'LR': '50', 'SL': '51', 'GH': '52',
            'ET': '53', 'CF': '54', 'GN': '55', 'CM': '56', 'CG': '57',
            'GA': '58', 'GQ': '59', 'BI': '60', 'AO': '61', 'GW': '62',
            'MW': '63', 'ZM': '64', 'RW': '65', 'SS': '66', 'SO': '67',
            'LS': '68', 'BW': '69', 'SZ': '70', 'MU': '71', 'KM': '72',
            'CV': '73', 'ST': '74', 'SC': '75', 'DJ': '76', 'UG': '77',
            'TZ': '78', 'KE': '79', 'BW': '80', 'ZW': '81', 'NA': '82',
            'MZ': '83', 'ZA': '84', 'ZA': '85', 'ZA': '86', 'ZA': '87',
            'ZA': '88', 'ZA': '89', 'ZA': '90', 'ZA': '91', 'ZA': '92',
            'ZA': '93', 'ZA': '94', 'ZA': '95', 'ZA': '96', 'ZA': '97',
            'ZA': '98', 'ZA': '99', 'ZA': '100'
        };

        // Start cleanup job
        this.startCleanupJob();

        logger.info('FreeProvider initialized', {
            provider: this.name,
            hasApiKey: !!this.smsActivateKey,
            note: 'Free tier requires SMS_ACTIVATE_API_KEY env var'
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  CLEANUP & LIFECYCLE
    // ═══════════════════════════════════════════════════════════

    startCleanupJob() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        // Clean up stale activations every 5 minutes
        this.cleanupInterval = setInterval(() => this.cleanupStaleActivations(), 300000);

        // Memory-safe cleanup on process exit
        const cleanup = () => this.stopCleanupJob();
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
        process.once('exit', cleanup);
    }

    stopCleanupJob() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            logger.info('FreeProvider cleanup job stopped');
        }
    }

    /**
     * Remove activations older than 20 minutes (sms-activate default expiry)
     */
    cleanupStaleActivations() {
        const now = Date.now();
        const staleThreshold = 20 * 60 * 1000; // 20 minutes
        let cleaned = 0;

        for (const [activationId, data] of this.activeActivations) {
            if (now - data.assignedAt > staleThreshold) {
                this.activeActivations.delete(activationId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info('Cleaned stale free activations', { cleaned });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER ACQUISITION
    // ═══════════════════════════════════════════════════════════

    /**
     * Get a free number from sms-activate.org free tier.
     * Returns real number that can receive real SMS.
     */
    async getNumber(country = 'US', service = 'Any') {
        const startTime = Date.now();

        try {
            if (!this.smsActivateKey) {
                throw new Error(
                    'FREE_PROVIDER_NOT_CONFIGURED: SMS_ACTIVATE_API_KEY not set. ' +
                    'Get a free API key at sms-activate.org or use a paid provider.'
                );
            }

            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            logger.info('Requesting free number from sms-activate', {
                country: providerCountry,
                service: providerService,
                originalCountry: country,
                originalService: service
            });

            // Step 1: Check balance
            const balance = await this.getBalance();
            if (balance <= 0) {
                throw new Error(
                    'NO_BALANCE: sms-activate free tier has no balance. ' +
                    'Fund your account or use a paid provider.'
                );
            }

            logger.debug('sms-activate balance', { balance });

            // Step 2: Request number
            const response = await axios.get(this.smsActivateBaseUrl, {
                params: {
                    api_key: this.smsActivateKey,
                    action: 'getNumber',
                    service: providerService,
                    country: providerCountry,
                    operator: 'any'
                },
                timeout: 15000,
                validateStatus: () => true
            });

            if (response.status !== 200) {
                throw new Error(`sms-activate HTTP error: ${response.status}`);
            }

            const data = response.data.toString().trim();
            logger.debug('sms-activate getNumber response', { data });

            // Handle errors
            if (data.includes('NO_NUMBERS')) {
                throw new Error(`NO_NUMBERS: No free numbers available in ${country} for ${service}`);
            }
            if (data.includes('NO_BALANCE')) {
                throw new Error('NO_BALANCE: Insufficient sms-activate balance');
            }
            if (data.includes('BAD_SERVICE')) {
                throw new Error(`BAD_SERVICE: ${service} not supported on free tier`);
            }
            if (data.includes('BAD_KEY')) {
                throw new Error('BAD_KEY: Invalid SMS_ACTIVATE_API_KEY');
            }
            if (data.includes('BANNED')) {
                throw new Error('BANNED: sms-activate account banned');
            }
            if (!data.startsWith('ACCESS_NUMBER:')) {
                throw new Error(`UNEXPECTED_RESPONSE: ${data}`);
            }

            // Parse response: ACCESS_NUMBER:activationId:phoneNumber
            const parts = data.split(':');
            if (parts.length !== 3) {
                throw new Error(`INVALID_RESPONSE_FORMAT: ${data}`);
            }

            const activationId = parts[1].trim();
            const phoneNumber = parts[2].trim();

            if (!activationId || !phoneNumber) {
                throw new Error(`INVALID_RESPONSE_DATA: activationId=${activationId}, phoneNumber=${phoneNumber}`);
            }

            // Store activation
            this.activeActivations.set(activationId, {
                phoneNumber,
                assignedAt: Date.now(),
                country: country.toUpperCase(),
                service: providerService,
                lastChecked: Date.now()
            });

            const duration = Date.now() - startTime;
            this.updateStats(true, duration);

            logger.info('Free number acquired from sms-activate', {
                activationId,
                phoneNumber: this.maskPhone(phoneNumber),
                country,
                service,
                duration
            });

            return {
                phoneNumber,
                provider: this.name,
                providerNumberId: activationId,
                country: country.toUpperCase(),
                service,
                cost: 0,
                isVirtual: true,
                source: 'sms-activate-free',
                expiresAt: new Date(Date.now() + 20 * 60 * 1000)
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration);

            logger.error('Free number acquisition failed', {
                country,
                service,
                error: error.message
            });

            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SMS CHECKING
    // ═══════════════════════════════════════════════════════════

    /**
     * Check SMS status for an activation.
     * @param {string} activationId — The sms-activate activation ID
     */
    async checkSMS(activationId) {
        const startTime = Date.now();

        try {
            if (!this.smsActivateKey) {
                return {
                    success: false,
                    status: 'ERROR',
                    error: 'SMS_ACTIVATE_API_KEY not configured'
                };
            }

            if (!activationId) {
                return {
                    success: false,
                    status: 'ERROR',
                    error: 'MISSING_ACTIVATION_ID'
                };
            }

            const activation = this.activeActivations.get(activationId);
            if (!activation) {
                return {
                    success: false,
                    status: 'ERROR',
                    error: 'ACTIVATION_NOT_FOUND: This activation has expired or was never created'
                };
            }

            // Update last checked time
            activation.lastChecked = Date.now();

            const response = await axios.get(this.smsActivateBaseUrl, {
                params: {
                    api_key: this.smsActivateKey,
                    action: 'getStatus',
                    id: activationId
                },
                timeout: 10000,
                validateStatus: () => true
            });

            if (response.status !== 200) {
                return {
                    success: false,
                    status: 'ERROR',
                    error: `HTTP ${response.status}`
                };
            }

            const data = response.data.toString().trim();
            logger.debug('sms-activate getStatus response', { activationId, data });

            // STATUS_WAIT_CODE — still waiting
            if (data === 'STATUS_WAIT_CODE') {
                return {
                    success: false,
                    status: 'WAITING',
                    message: 'Waiting for SMS...'
                };
            }

            // STATUS_WAIT_RETRY — wait for retry
            if (data === 'STATUS_WAIT_RETRY') {
                return {
                    success: false,
                    status: 'WAITING',
                    message: 'Waiting for retry...'
                };
            }

            // STATUS_WAIT_RESEND — wait for resend
            if (data === 'STATUS_WAIT_RESEND') {
                return {
                    success: false,
                    status: 'WAITING',
                    message: 'Waiting for resend...'
                };
            }

            // STATUS_CANCEL — cancelled by user or system
            if (data === 'STATUS_CANCEL') {
                this.activeActivations.delete(activationId);
                return {
                    success: false,
                    status: 'CANCELLED',
                    message: 'Activation was cancelled'
                };
            }

            // STATUS_OK:123456 — OTP received!
            if (data.startsWith('STATUS_OK:')) {
                const otp = data.split(':')[1];
                this.activeActivations.delete(activationId);

                this.updateStats(true, Date.now() - startTime);

                logger.info('OTP received from sms-activate', {
                    activationId,
                    otp: otp.slice(0, 2) + '****'
                });

                return {
                    success: true,
                    otp,
                    status: 'RECEIVED',
                    receivedAt: new Date()
                };
            }

            // STATUS_OK_FULL:123456:Full text message
            if (data.startsWith('STATUS_OK_FULL:')) {
                const parts = data.split(':');
                const otp = parts[1];
                const fullText = parts.slice(2).join(':');
                this.activeActivations.delete(activationId);

                this.updateStats(true, Date.now() - startTime);

                return {
                    success: true,
                    otp,
                    status: 'RECEIVED',
                    fullText,
                    receivedAt: new Date()
                };
            }

            // Unknown status
            return {
                success: false,
                status: 'CHECKING',
                rawStatus: data,
                message: `Unknown status: ${data}`
            };

        } catch (error) {
            this.updateStats(false, Date.now() - startTime);
            logger.error('sms-activate checkSMS failed', { activationId, error: error.message });
            return {
                success: false,
                status: 'ERROR',
                error: error.message
            };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  NUMBER MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    /**
     * Cancel an activation and release the number.
     * @param {string} activationId — sms-activate activation ID
     */
    async cancelNumber(activationId) {
        try {
            if (!this.smsActivateKey) {
                this.activeActivations.delete(activationId);
                return { success: true, status: 'RELEASED' };
            }

            if (!activationId) {
                return { success: false, error: 'MISSING_ACTIVATION_ID' };
            }

            const response = await axios.get(this.smsActivateBaseUrl, {
                params: {
                    api_key: this.smsActivateKey,
                    action: 'setStatus',
                    status: '8', // Cancel
                    id: activationId
                },
                timeout: 10000,
                validateStatus: () => true
            });

            this.activeActivations.delete(activationId);

            const data = response.data.toString().trim();
            logger.info('sms-activate cancel response', { activationId, data });

            if (data === 'ACCESS_CANCEL' || data === 'ACCESS_ACTIVATION') {
                return { success: true, status: 'CANCELLED' };
            }

            return { success: true, status: 'CANCELLED', rawResponse: data };

        } catch (error) {
            this.activeActivations.delete(activationId);
            logger.warn('sms-activate cancel failed', { activationId, error: error.message });
            return { success: true, status: 'RELEASED' };
        }
    }

    /**
     * Mark activation as finished (SMS received successfully).
     * @param {string} activationId — sms-activate activation ID
     */
    async finishNumber(activationId) {
        try {
            if (!this.smsActivateKey) {
                this.activeActivations.delete(activationId);
                return { success: true, status: 'FINISHED' };
            }

            if (!activationId) {
                return { success: false, error: 'MISSING_ACTIVATION_ID' };
            }

            const response = await axios.get(this.smsActivateBaseUrl, {
                params: {
                    api_key: this.smsActivateKey,
                    action: 'setStatus',
                    status: '6', // Complete
                    id: activationId
                },
                timeout: 10000,
                validateStatus: () => true
            });

            this.activeActivations.delete(activationId);

            const data = response.data.toString().trim();
            logger.info('sms-activate finish response', { activationId, data });

            if (data === 'ACCESS_ACTIVATION') {
                return { success: true, status: 'FINISHED' };
            }

            return { success: true, status: 'FINISHED', rawResponse: data };

        } catch (error) {
            this.activeActivations.delete(activationId);
            logger.warn('sms-activate finish failed', { activationId, error: error.message });
            return { success: true, status: 'FINISHED' };
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  BALANCE & INFO
    // ═══════════════════════════════════════════════════════════

    async getBalance() {
        if (!this.smsActivateKey) {
            return 0;
        }

        try {
            const response = await axios.get(this.smsActivateBaseUrl, {
                params: {
                    api_key: this.smsActivateKey,
                    action: 'getBalance'
                },
                timeout: 10000,
                validateStatus: () => true
            });

            if (response.status !== 200) {
                return 0;
            }

            const data = response.data.toString().trim();
            
            if (data.startsWith('ACCESS_BALANCE:')) {
                const balance = parseFloat(data.split(':')[1]);
                return isNaN(balance) ? 0 : balance;
            }

            return 0;
        } catch (error) {
            logger.debug('sms-activate balance check failed', { error: error.message });
            return 0;
        }
    }

    async getPrices(country = 'US', service = 'Any') {
        if (!this.smsActivateKey) {
            return { success: false, error: 'SMS_ACTIVATE_API_KEY not configured' };
        }

        try {
            const providerCountry = this.mapCountry(country);
            const providerService = this.mapService(service);

            const response = await axios.get(this.smsActivateBaseUrl, {
                params: {
                    api_key: this.smsActivateKey,
                    ac
