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
        // Register all providers
        this.providers.set('TWILIO', new TwilioProvider());
        this.providers.set('TELNYX', new TelnyxProvider());
        this.providers.set('CHEAP_PANEL', new CheapPanelProvider());
        this.providers.set('FREE_PUBLIC', new FreeProvider());

        logger.info('SMS Provider Manager initialized', {
            providers: Array.from(this.providers.keys())
        });
    }

    async getProviderForTier(tier, country = 'US', preferredProvider = null) {
        const tierMap = {
            'FREE': ['FREE_PUBLIC'],
            'CHEAP': ['CHEAP_PANEL', 'TELNYX', 'TWILIO'],
            'VIP': ['TELNYX', 'TWILIO']
        };

        const providerNames = tierMap[tier] || tierMap['CHEAP'];

        // If preferred provider specified and available, try it first
        if (preferredProvider && providerNames.includes(preferredProvider)) {
            const provider = this.providers.get(preferredProvider);
            if (provider && provider.isActive) {
                return provider;
            }
        }

        // Find first available provider with best stats
        for (const name of providerNames) {
            const provider = this.providers.get(name);
            if (provider && provider.isActive) {
                // Check if provider has numbers for this country
                try {
                    await provider.getNumber(country);
                    return provider;
                } catch (err) {
                    logger.warn(`Provider ${name} unavailable for ${country}`, {
                        error: err.message
                    });
                    continue;
                }
            }
        }

        throw new Error(`No available providers for tier ${tier} in ${country}`);
    }

    async getNumber(tier, country, service, preferredProvider = null) {
        const provider = await this.getProviderForTier(tier, country, preferredProvider);
        const number = await provider.getNumber(country, service);

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

        if (providerName === 'CHEAP_PANEL') {
            return await provider.checkSMS(identifier); // activationId
        }

        if (providerName === 'FREE_PUBLIC') {
            return await provider.checkSMS(identifier); // phoneNumber
        }

        // For Twilio/Telnyx, you'd check via their APIs or webhooks
        return { success: false, status: 'CHECK_NOT_SUPPORTED' };
    }

    async cancelNumber(providerName, identifier) {
        const provider = this.providers.get(providerName);
        if (!provider) return { success: false };

        if (providerName === 'CHEAP_PANEL') {
            return await provider.cancelNumber(identifier);
        }

        return { success: true }; // Others auto-release
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
