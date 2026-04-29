import TwilioProvider from './TwilioProvider.js';
import TelnyxProvider from './TelnyxProvider.js';
import CheapPanelProvider from './CheapPanelProvider.js';
import FreeProvider from './FreeProvider.js';
import NumberPoolManager from './NumberPoolManager.js';
import NumberBuyer from './NumberBuyer.js';
import logger from '../../utils/logger.js';

/**
 * SMSProviderManager — Unified gateway for SMS number acquisition across all providers
 * 
 * Tiers:
 *   VIP/BUNDLE  → NumberPool (Twilio + Telnyx) with preferred provider support
 *   CHEAP       → CheapPanelProvider (rented numbers)
 *   FREE        → FreeProvider (public/shared numbers)
 */
class SMSProviderManager {
    constructor() {
        this.providers = new Map();
        this.numberPool = null;
        this.numberBuyer = null;
        this.isInitialized = false;

        this.initializeProviders();
    }

    // ─── Provider Setup ──────────────────────────────────────────────────

    initializeProviders() {
        const twilio = new TwilioProvider();
        const telnyx = new TelnyxProvider();
        const cheapPanel = new CheapPanelProvider();
        const freePublic = new FreeProvider();

        this.providers.set('TWILIO', twilio);
        this.providers.set('TELNYX', telnyx);
        this.providers.set('CHEAP_PANEL', cheapPanel);
        this.providers.set('FREE_PUBLIC', freePublic);

        // NumberPool gets ALL active infrastructure providers
        const poolProviders = [];
        if (twilio.isActive) poolProviders.push(twilio);
        if (telnyx.isActive) poolProviders.push(telnyx);

        if (poolProviders.length > 0) {
            // Pass all active providers to pool manager
            this.numberPool = new NumberPoolManager(...poolProviders);
            this.numberBuyer = new NumberBuyer();
        }

        logger.info('SMS Provider Manager initialized', {
            providers: Array.from(this.providers.keys()),
            poolProviders: poolProviders.map(p => p.name),
            hasPool: !!this.numberPool
        });
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    async initialize() {
        if (this.isInitialized) return;

        // Initialize number pool first (connects DB, loads available numbers)
        if (this.numberPool) {
            await this.numberPool.initialize();
        }

        // Initialize number buyer (shares the pool)
        if (this.numberBuyer) {
            await this.numberBuyer.init({
                twilio: this.providers.get('TWILIO'),
                telnyx: this.providers.get('TELNYX')
            });
        }

        // Initialize optional providers (cheap panel, free, etc.)
        for (const [name, provider] of this.providers) {
            if (provider.initialize && typeof provider.initialize === 'function') {
                try {
                    await provider.initialize();
                } catch (e) {
                    logger.warn(`Provider ${name} initialize failed`, { error: e.message });
                    provider.isActive = false; // Mark inactive on failure
                }
            }
        }

        this.isInitialized = true;
        logger.info('SMS Provider Manager fully initialized');
    }

    // ─── Number Acquisition ──────────────────────────────────────────────

    /**
     * Get a number for SMS verification.
     * @param {string} tier — 'VIP' | 'BUNDLE' | 'CHEAP' | 'FREE'
     * @param {string} country — ISO country code
     * @param {string} service — Service name (e.g., 'whatsapp', 'telegram')
     * @param {string} preferredProvider — 'TWILIO' | 'TELNYX' | null
     * @param {string} userId — Optional user identifier
     */
    async getNumber(tier, country, service, preferredProvider = null, userId = null) {
        if (!this.isInitialized) await this.initialize();

        // VIP/BUNDLE: Use number pool (owned numbers)
        if ((tier === 'VIP' || tier === 'BUNDLE') && this.numberPool) {
            try {
                // Pass preferredProvider through to pool
                return await this.numberPool.acquireNumber(
                    country,
                    service,
                    userId,
                    preferredProvider
                );
            } catch (poolError) {
                logger.warn('Pool acquisition failed, falling back', {
                    error: poolError.message,
                    country,
                    tier
                });
                // Fall through to cheap panel below
            }
        }

        // FREE: Use public/shared numbers
        if (tier === 'FREE') {
            const provider = this.providers.get('FREE_PUBLIC');
            if (!provider?.isActive) {
                throw new Error('FREE_PROVIDER_UNAVAILABLE: Free provider not active');
            }
            return provider.getNumber(country, service);
        }

        // CHEAP or pool fallback: Use cheap panel (rented numbers)
        if (preferredProvider && this.providers.has(preferredProvider)) {
            const provider = this.providers.get(preferredProvider);
            if (provider?.isActive && provider.getNumber) {
                return provider.getNumber(country, service);
            }
        }

        const cheapPanel = this.providers.get('CHEAP_PANEL');
        if (!cheapPanel?.isActive) {
            throw new Error(`NO_PROVIDER_AVAILABLE: No active provider for tier ${tier}`);
        }

        return cheapPanel.getNumber(country, service);
    }

    // ─── SMS Checking ────────────────────────────────────────────────────

    async checkSMS(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        // Pool numbers use webhooks, not polling
        if (providerName === 'TWILIO' || providerName === 'TELNYX' || providerName === 'NUMBER_POOL') {
            return {
                success: false,
                status: 'WAITING',
                message: 'Check via webhook or provider API',
                provider: providerName
            };
        }

        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`PROVIDER_NOT_FOUND: ${providerName}`);
        }

        if (!provider.checkSMS) {
            return {
                success: false,
                status: 'UNSUPPORTED',
                message: `Provider ${providerName} does not support SMS checking`
            };
        }

        return provider.checkSMS(identifier);
    }

    // ─── Number Release / Cancellation ───────────────────────────────────

    async cancelNumber(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        // Pool numbers
        if (providerName === 'NUMBER_POOL' || providerName === 'TWILIO' || providerName === 'TELNYX') {
            if (!this.numberPool) {
                return { success: false, error: 'POOL_NOT_INITIALIZED' };
            }
            return this.numberPool.releaseNumber(identifier, 'USER_CANCELLED');
        }

        const provider = this.providers.get(providerName);
        if (!provider) {
            return { success: false, error: `PROVIDER_NOT_FOUND: ${providerName}` };
        }

        if (provider.cancelNumber && typeof provider.cancelNumber === 'function') {
            return provider.cancelNumber(identifier);
        }

        return { success: true, note: 'Nothing to cancel for this provider' };
    }

    // ─── Number Finish / Completion ────────────────────────────────────

    async finishNumber(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        // Pool numbers: release back to pool when user is done
        if (providerName === 'NUMBER_POOL' || providerName === 'TWILIO' || providerName === 'TELNYX') {
            if (!this.numberPool) {
                return { success: false, error: 'POOL_NOT_INITIALIZED' };
            }
            return this.numberPool.releaseNumber(identifier, 'SESSION_END');
        }

        const provider = this.providers.get(providerName);
        if (provider?.finishNumber && typeof provider.finishNumber === 'function') {
            return provider.finishNumber(identifier);
        }

        return { success: true, note: 'No finish action required' };
    }

    // ─── Pool Management ───────────────────────────────────────────────

    /**
     * Buy new numbers for the pool.
     * Uses NumberBuyer for retry/backoff logic.
     */
    async buyPoolNumbers(country = 'US', quantity = 1, preferredProvider = null) {
        if (!this.numberPool || !this.numberBuyer) {
            throw new Error('POOL_NOT_AVAILABLE: Number pool not configured');
        }

        if (!this.isInitialized) await this.initialize();

        // Use NumberBuyer for robust purchase with retry/backoff
        const result = await this.numberBuyer.buyMultiple(
            [{ country, count: quantity, preferredProvider }],
            { abortOnError: false }
        );

        // Refresh pool to pick up new numbers from DB
        // (buyNewNumber already pushed to pool, but re-init ensures sync)
        if (result.totalSuccess > 0) {
            await this.numberPool.initialize();
        }

        return {
            success: result.totalFailed === 0,
            purchased: result.results[0]?.numbers || [],
            failed: result.totalFailed,
            totalCost: result.totalCost,
            errors: result.results[0]?.errors || []
        };
    }

    /**
     * Buy numbers across multiple countries in one call.
     */
    async buyPoolNumbersBulk(configs) {
        if (!this.numberPool || !this.numberBuyer) {
            throw new Error('POOL_NOT_AVAILABLE: Number pool not configured');
        }

        if (!this.isInitialized) await this.initialize();

        const result = await this.numberBuyer.buyMultiple(configs, { abortOnError: false });

        if (result.totalSuccess > 0) {
            await this.numberPool.initialize();
        }

        return result;
    }

    // ─── Stats & Monitoring ──────────────────────────────────────────────

    async getPoolStats() {
        if (!this.numberPool) {
            return { available: false, reason: 'POOL_NOT_CONFIGURED' };
        }

        return {
            available: true,
            pools: this.numberPool.getPoolStats(),
            detailed: this.numberPool.getDetailedStats?.() || null
        };
    }

    getAllStats() {
        const stats = {};
        for (const [name, provider] of this.providers) {
            stats[name] = provider.getStats ? provider.getStats() : { isActive: provider.isActive };
        }
        if (this.numberPool) {
            stats['POOL'] = this.numberPool.getPoolStats();
            stats['POOL_DETAILED'] = this.numberPool.getDetailedStats?.();
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

    // ─── Shutdown ────────────────────────────────────────────────────────

    async shutdown() {
        // Shutdown number buyer first (stops any in-flight purchases)
        if (this.numberBuyer) {
            try {
                await this.numberBuyer.shutdown();
            } catch (e) {
                logger.warn('NumberBuyer shutdown failed', { error: e.message });
            }
        }

        // Uninitialize pool (clears memory, stops cleanup)
        if (this.numberPool) {
            try {
                await this.numberPool.uninitialize();
            } catch (e) {
                logger.warn('Pool uninitialize failed', { error: e.message });
            }
        }

        // Stop individual provider cleanup jobs
        for (const [name, provider] of this.providers) {
            if (provider.stopCleanupJob && typeof provider.stopCleanupJob === 'function') {
                try {
                    provider.stopCleanupJob();
                } catch (e) {
                    logger.warn(`Provider ${name} cleanup failed`, { error: e.message });
                }
            }
        }

        this.isInitialized = false;
        logger.info('SMS Provider Manager shut down');
    }
}

export default SMSProviderManager;
                    
