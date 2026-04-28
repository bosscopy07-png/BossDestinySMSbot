import TwilioProvider from './TwilioProvider.js';
import TelnyxProvider from './TelnyxProvider.js';
import CheapPanelProvider from './CheapPanelProvider.js';
import FreeProvider from './FreeProvider.js';
import logger from '../../utils/logger.js';

class SMSProviderManager {
    constructor() {
        this.providers = new Map();
        this.initializeProviders();
    }

    initializeProviders() {
        this.providers.set('TWILIO', new TwilioProvider());
        this.providers.set('TELNYX', new TelnyxProvider());
        this.providers.set('CHEAP_PANEL', new CheapPanelProvider());
        this.providers.set('FREE_PUBLIC', new FreeProvider());

        logger.info('SMS Provider Manager initialized', {
            providers: Array.from(this.providers.keys())
        });
    }

    /**
     * Get provider for tier — DOES NOT acquire number, just returns provider instance
     */
    async getProviderForTier(tier, country = 'US', preferredProvider = null) {
        const tierMap = {
            'FREE': ['FREE_PUBLIC'],
            'CHEAP': ['CHEAP_PANEL', 'TELNYX', 'TWILIO'],
            'VIP': ['TELNYX', 'TWILIO'],
            'BUNDLE': ['CHEAP_PANEL', 'TELNYX', 'TWILIO']  // ← FIXED: BUNDLE uses cheap providers
        };

        const providerNames = tierMap[tier] || tierMap['CHEAP'];

        // Preferred provider first
        if (preferredProvider && providerNames.includes(preferredProvider)) {
            const provider = this.providers.get(preferredProvider);
            if (provider && provider.isActive) {
                return provider;
            }
        }

        // Find first active provider
        for (const name of providerNames) {
            const provider = this.providers.get(name);
            if (provider && provider.isActive) {
                return provider;
            }
        }

        throw new Error(`No available providers for tier ${tier}`);
    }

    /**
     * Get number — single acquisition, no wasted calls
     */
    async getNumber(tier, country, service, preferredProvider = null) {
        const provider = await this.getProviderForTier(tier, country, preferredProvider);
        const number = await provider.getNumber(country, service);

        // Validate response
        if (!number || !number.phoneNumber || number.phoneNumber.length < 7) {
            throw new Error(`Invalid number from ${provider.name}: ${number?.phoneNumber}`);
        }

        return {
            ...number,
            providerInstance: provider
        };
    }

    async checkSMS(providerName, identifier) {
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`Provider ${providerName} not found`);
        }
        return provider.checkSMS(identifier);
    }

    async cancelNumber(providerName, identifier) {
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
        return stats;
    }

    getActiveProviders() {
        return Array.from(this.providers.entries())
            .filter(([_, provider]) => provider.isActive)
            .map(([name, _]) => name);
    }

    disableProvider(name) {
        const provider = this.providers.get(name);
        if (provider) {
            provider.isActive = false;
            logger.warn(`Provider ${name} disabled`);
        }
    }

    enableProvider(name) {
        const provider = this.providers.get(name);
        if (provider) {
            provider.isActive = true;
            logger.info(`Provider ${name} enabled`);
        }
    }
}

export default SMSProviderManager;
            
