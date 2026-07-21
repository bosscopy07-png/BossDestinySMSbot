import axios from 'axios';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

class ExchangeRateService {
    constructor() {
        this.cache = null;
        this.cacheExpiry = null;
        this.cacheDurationMs = 5 * 60 * 1000; // 5 minutes
        this.fallbackRate = parseFloat(config.payment?.nairaFallbackRate) || 1500;
    }

    /**
     * Get current NGN/USD exchange rate
     * Priority: Admin config > External API > Fallback
     */
    async getRate() {
        // Check cache first
        if (this.cache && this.cacheExpiry && Date.now() < this.cacheExpiry) {
            logger.info('Using cached exchange rate', { rate: this.cache });
            return this.cache;
        }

        // 1. Try admin-configured rate (highest priority)
        const adminRate = await this._getAdminRate();
        if (adminRate) {
            this.cache = adminRate;
            this.cacheExpiry = Date.now() + this.cacheDurationMs;
            logger.info('Using admin-configured exchange rate', { rate: adminRate });
            return adminRate;
        }

        // 2. Try external API
        const apiRate = await this._fetchExternalRate();
        if (apiRate) {
            this.cache = apiRate;
            this.cacheExpiry = Date.now() + this.cacheDurationMs;
            logger.info('Using external API exchange rate', { rate: apiRate });
            return apiRate;
        }

        // 3. Fallback to configured rate
        logger.warn('Using fallback exchange rate', { rate: this.fallbackRate });
        return this.fallbackRate;
    }

    /**
     * Get admin-configured rate from database/config
     */
    async _getAdminRate() {
        try {
            // Check if there's an admin-configured rate in env or settings
            const adminRate = config.payment?.nairaAdminRate;
            if (adminRate && !isNaN(parseFloat(adminRate))) {
                return parseFloat(adminRate);
            }
            return null;
        } catch (error) {
            logger.error('Error fetching admin rate', { error: error.message });
            return null;
        }
    }

    /**
     * Fetch rate from external API (e.g., ExchangeRate-API, OpenExchangeRates)
     */
    async _fetchExternalRate() {
        try {
            // Using a free NGN/USD rate API
            // Fallback to a reliable endpoint
            const response = await axios.get(
                'https://api.exchangerate-api.com/v4/latest/USD',
                { timeout: 10000 }
            );

            if (response.data && response.data.rates && response.data.rates.NGN) {
                const rate = response.data.rates.NGN;
                logger.info('External API rate fetched', { rate });
                return rate;
            }
            return null;
        } catch (error) {
            logger.error('External API rate fetch failed', { error: error.message });
            return null;
        }
    }

    /**
     * Convert NGN to USD using current rate
     */
    async ngnToUsd(amountNgn) {
        const rate = await this.getRate();
        const amountUsd = parseFloat((amountNgn / rate).toFixed(2));
        return { amountUsd, rate };
    }

    /**
     * Convert USD to NGN using current rate
     */
    async usdToNgn(amountUsd) {
        const rate = await this.getRate();
        const amountNgn = Math.ceil(amountUsd * rate);
        return { amountNgn, rate };
    }

    /**
     * Calculate USD amount from NGN with stored rate
     * Used during payment processing to ensure consistency
     */
    calculateUsd(amountNgn, exchangeRate) {
        return parseFloat((amountNgn / exchangeRate).toFixed(2));
    }

    /**
     * Clear cache (useful for admin operations)
     */
    clearCache() {
        this.cache = null;
        this.cacheExpiry = null;
        logger.info('Exchange rate cache cleared');
    }
}

export default new ExchangeRateService();
