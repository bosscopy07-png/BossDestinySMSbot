import TwilioProvider from './TwilioProvider.js';
import TelnyxProvider from './TelnyxProvider.js';
import CheapPanelProvider from './CheapPanelProvider.js';
import FreeProvider from './FreeProvider.js';
import NumberPoolManager from './NumberPoolManager.js';
import logger from '../../utils/logger.js';

class SMSProviderManager {
    constructor() {
        this.providers = new Map();
        this.numberPool = null;
        this.initializeProviders();
    }

    initializeProviders() {
        const twilio = new TwilioProvider();
        
        this.providers.set('TWILIO', twilio);
        this.providers.set('TELNYX', new TelnyxProvider());
        this.providers.set('CHEAP_PANEL', new CheapPanelProvider());
        this.providers.set('FREE_PUBLIC', new FreeProvider());

        // Initialize pool manager if Twilio is configured
        if (twilio.isActive) {
            this.numberPool = new NumberPoolManager(twilio);
        }

        logger.info('SMS Provider Manager initialized', {
            providers: Array.from(this.providers.keys()),
            hasPool: !!this.numberPool
        });
    }

    async getNumber(tier, country, service, preferredProvider = null) {
        // VIP and BUNDLE use pool if available
        if ((tier === 'VIP' || tier === 'BUNDLE') && this.numberPool) {
            try {
                return await this.numberPool.acquireNumber(country, service);
            } catch (poolError) {
                logger.warn('Pool failed, falling back to 5SIM', { error: poolError.message });
                // Fall through to cheap panel
            }
        }

        // FREE uses free provider
        if (tier === 'FREE') {
            const provider = this.providers.get('FREE_PUBLIC');
            return provider.getNumber(country, service);
        }

        // CHEAP (and fallback) use cheap panel
        const provider = this.providers.get('CHEAP_PANEL');
        if (!provider || !provider.isActive) {
            throw new Error('No cheap provider available');
        }

        return provider.getNumber(country, service);
    }

    async checkSMS(providerName, identifier) {
        if (providerName === 'TWILIO' || providerName === 'NUMBER_POOL') {
            // Twilio numbers receive SMS via webhook, not polling
            // Return waiting status — webhook will update DB
            return { success: false, status: 'WAITING', message: 'Check via webhook' };
        }

        const provider = this.providers.get(providerName);
        if (!provider) throw new Error(`Provider ${providerName} not found`);
        
        return provider.checkSMS(identifier);
    }

    async cancelNumber(providerName, identifier) {
        if (providerName === 'NUMBER_POOL') {
            return this.numberPool.releaseNumber(identifier);
        }

        const provider = this.providers.get(providerName);
        if (!provider) return { success: false };
        
        if (providerName === 'CHEAP_PANEL') {
            return provider.cancelNumber(identifier);
        }
        
        return { success: true };
    }

    getAllStats() {
        const stats = {};
        for (const [name, provider] of this.providers) {
            stats[name] = provider.getStats();
        }
        if (this.numberPool) {
            stats['POOL'] = this.numberPool.getPoolStats();
        }
        return stats;
    }

    getActiveProviders() {
        return Array.from(this.providers.entries())
            .filter(([_, provider]) => provider.isActive)
            .map(([name, _]) => name);
    }
}

export default SMSProviderManager;
