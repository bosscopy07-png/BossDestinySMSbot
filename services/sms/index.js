import TwilioProvider from './TwilioProvider.js';
import TelnyxProvider from './TelnyxProvider.js';
import CheapPanelProvider from './CheapPanelProvider.js';
import FreeProvider from './FreeProvider.js';
import NumberPoolManager from './NumberPoolManager.js';
import { purchaseNumbersBatch, disconnectBuyer } from './buy-numbers.js';
import logger from '../../utils/logger.js';

class SMSProviderManager {
    constructor() {
        this.providers = new Map();
        this.numberPool = null;
        this.isInitialized = false;
        this.initializeProviders();
    }

    initializeProviders() {
        const twilio = new TwilioProvider();
        
        this.providers.set('TWILIO', twilio);
        this.providers.set('TELNYX', new TelnyxProvider());
        this.providers.set('CHEAP_PANEL', new CheapPanelProvider());
        this.providers.set('FREE_PUBLIC', new FreeProvider());

        if (twilio.isActive) {
            this.numberPool = new NumberPoolManager(twilio);
        }

        logger.info('SMS Provider Manager initialized', {
            providers: Array.from(this.providers.keys()),
            hasPool: !!this.numberPool
        });
    }

    async initialize() {
        if (this.isInitialized) return;

        if (this.numberPool) {
            await this.numberPool.initialize();
        }

        for (const provider of this.providers.values()) {
            if (provider.initialize && typeof provider.initialize === 'function') {
                try {
                    await provider.initialize();
                } catch (e) {
                    logger.warn(`Provider ${provider.name} initialize failed`, { error: e.message });
                }
            }
        }

        this.isInitialized = true;
        logger.info('SMS Provider Manager fully initialized');
    }

    async getNumber(tier, country, service, preferredProvider = null) {
        if (!this.isInitialized) await this.initialize();

        if ((tier === 'VIP' || tier === 'BUNDLE') && this.numberPool) {
            try {
                return await this.numberPool.acquireNumber(country, service);
            } catch (poolError) {
                logger.warn('Pool failed, falling back to cheap panel', { error: poolError.message });
            }
        }

        if (tier === 'FREE') {
            const provider = this.providers.get('FREE_PUBLIC');
            if (!provider || !provider.isActive) {
                throw new Error('Free provider not available');
            }
            return provider.getNumber(country, service);
        }

        if (preferredProvider && this.providers.has(preferredProvider)) {
            const provider = this.providers.get(preferredProvider);
            if (provider.isActive) {
                return provider.getNumber(country, service);
            }
        }

        const provider = this.providers.get('CHEAP_PANEL');
        if (!provider || !provider.isActive) {
            throw new Error('No provider available for tier: ' + tier);
        }

        return provider.getNumber(country, service);
    }

    async checkSMS(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        if (providerName === 'TWILIO' || providerName === 'NUMBER_POOL') {
            return { success: false, status: 'WAITING', message: 'Check via webhook' };
        }

        const provider = this.providers.get(providerName);
        if (!provider) throw new Error(`Provider ${providerName} not found`);
        
        return provider.checkSMS(identifier);
    }

    async cancelNumber(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        if (providerName === 'NUMBER_POOL') {
            if (!this.numberPool) return { success: false, error: 'Pool not initialized' };
            return this.numberPool.releaseNumber(identifier);
        }

        const provider = this.providers.get(providerName);
        if (!provider) return { success: false, error: 'Provider not found' };
        
        if (providerName === 'CHEAP_PANEL' && provider.cancelNumber) {
            return provider.cancelNumber(identifier);
        }
        
        return { success: true, note: 'Nothing to cancel for this provider' };
    }

    async finishNumber(providerName, identifier) {
        const provider = this.providers.get(providerName);
        if (provider && provider.finishNumber) {
            return provider.finishNumber(identifier);
        }
        return { success: true };
    }

    async buyPoolNumbers(config = {}) {
        if (!this.numberPool) {
            throw new Error('Number pool not available — Twilio not configured');
        }

        if (!this.isInitialized) await this.initialize();

        const result = await purchaseNumbersBatch({
            ...config,
            poolManager: this.numberPool
        });

        if (result.success) {
            await this.numberPool.initialize();
        }

        return result;
    }

    async getPoolStats() {
        if (!this.numberPool) return { available: false };
        return {
            available: true,
            ...this.numberPool.getPoolStats(),
            detailed: this.numberPool.getDetailedStats ? this.numberPool.getDetailedStats() : null
        };
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

    getProvider(name) {
        return this.providers.get(name);
    }

    async shutdown() {
        this.providers.forEach(provider => {
            if (provider.stopCleanupJob) provider.stopCleanupJob();
        });

        if (this.numberPool) {
            this.numberPool.stopCleanupJob();
        }

        await disconnectBuyer();

        logger.info('SMS Provider Manager shut down');
    }
}

export default SMSProviderManager;
        
