import axios from 'axios';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class CheapPanelProvider {
    constructor() {
        this.name = 'CHEAP_PANEL';
        this.tier = 'CHEAP';
        this.baseUrl = config.cheapPanel.baseUrl;
        this.apiKey = config.cheapPanel.apiKey;
        this.isActive = true;
        this.stats = {
            totalSent: 0,
            totalSuccess: 0,
            totalFailed: 0,
            avgResponseTime: 0
        };
    }

    async sendSMS(to, message, options = {}) {
        // Cheap panels usually don't support outbound SMS
        // They provide virtual numbers for RECEIVING SMS
        // This method is for API structure consistency
        logger.warn('CheapPanel does not support outbound SMS - used for receiving only');
        return {
            success: false,
            error: 'Outbound SMS not supported',
            provider: this.name
        };
    }

    async getNumber(country = 'US', service = 'Any') {
        const startTime = Date.now();

        try {
            // Standard SMS-activate API format
            // Adapt based on your actual cheap panel provider
            const response = await axios.get(this.baseUrl, {
                params: {
                    api_key: this.apiKey,
                    action: 'getNumber',
                    service: this.mapService(service),
                    country: this.mapCountry(country),
                    operator: 'any'
                },
                timeout: 30000
            });

            const data = response.data;

            if (data.startsWith('ACCESS_NUMBER')) {
                const [, activationId, phoneNumber] = data.split(':');
                const duration = Date.now() - startTime;
                this.updateStats(true, duration);

                logger.info('CheapPanel number acquired', {
                    provider: this.name,
                    activationId,
                    country,
                    service
                });

                return {
                    phoneNumber: phoneNumber,
                    provider: this.name,
                    providerNumberId: activationId,
                    country: country,
                    service: service,
                    cost: 0.02 // Typical cheap panel cost
                };
            }

            if (data === 'NO_NUMBERS') {
                throw new Error('No numbers available');
            }

            if (data === 'NO_BALANCE') {
                throw new Error('Insufficient panel balance');
            }

            throw new Error(`Panel error: ${data}`);

        } catch (error) {
            const duration = Date.now() - startTime;
            this.updateStats(false, duration);

            logger.error('CheapPanel number acquisition failed', {
                country,
                service,
                error: error.message
            });

            throw error;
        }
    }

    async checkSMS(activationId) {
        try {
            const response = await axios.get(this.baseUrl, {
                params: {
                    api_key: this.apiKey,
                    action: 'getStatus',
                    id: activationId
                },
                timeout: 10000
            });

            const data = response.data;

            // SMS-activate status codes
            if (data.startsWith('STATUS_OK')) {
                const otp = data.split(':')[1];
                return { success: true, otp, status: 'RECEIVED' };
            }

            if (data === 'STATUS_WAIT_CODE') {
                return { success: false, otp: null, status: 'WAITING' };
            }

            if (data === 'STATUS_CANCEL') {
                return { success: false, otp: null, status: 'CANCELLED' };
            }

            return { success: false, otp: null, status: 'UNKNOWN', raw: data };

        } catch (error) {
            logger.error('CheapPanel status check failed', {
                activationId,
                error: error.message
            });
            return { success: false, error: error.message };
        }
    }

    async cancelNumber(activationId) {
        try {
            await axios.get(this.baseUrl, {
                params: {
                    api_key: this.apiKey,
                    action: 'setStatus',
                    status: 8, // Cancel
                    id: activationId
                },
                timeout: 10000
            });

            logger.info('CheapPanel number cancelled', { activationId });
            return { success: true };

        } catch (error) {
            logger.error('CheapPanel cancel failed', {
                activationId,
                error: error.message
            });
            return { success: false, error: error.message };
        }
    }

    mapService(service) {
        const serviceMap = {
            'WhatsApp': 'wa',
            'Telegram': 'tg',
            'Facebook': 'fb',
            'Instagram': 'ig',
            'Twitter': 'tw',
            'Binance': 'bin',
            'Coinbase': 'cb',
            'Gmail': 'go',
            'Outlook': 'ot',
            'Netflix': 'nf',
            'Amazon': 'am',
            'PayPal': 'pp',
            'TikTok': 'tk',
            'Snapchat': 'sc',
            'Discord': 'ds'
        };
        return serviceMap[service] || 'ot';
    }

    mapCountry(country) {
        const countryMap = {
            'US': '187',
            'UK': '16',
            'CA': '36',
            'NG': '25',
            'IN': '22',
            'DE': '43',
            'FR': '78',
            'RU': '0',
            'CN': '14'
        };
        return countryMap[country] || '0';
    }

    updateStats(success, duration) {
        this.stats.totalSent++;
        if (success) {
            this.stats.totalSuccess++;
        } else {
            this.stats.totalFailed++;
        }
        this.stats.avgResponseTime = (
            (this.stats.avgResponseTime * (this.stats.totalSent - 1) + duration)
            / this.stats.totalSent
        );
    }

    getStats() {
        return {
            name: this.name,
            tier: this.tier,
            isActive: this.isActive,
            ...this.stats,
            successRate: this.stats.totalSent > 0
                ? (this.stats.totalSuccess / this.stats.totalSent * 100).toFixed(2)
                : 100
        };
    }
}

export default CheapPanelProvider;
  
