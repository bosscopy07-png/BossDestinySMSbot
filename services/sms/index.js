// ═══════════════════════════════════════════════════════════════════════════════
// SMSProviderManager.js — Unified gateway for SMS number acquisition
// Part 1/3 — Imports, Constructor, Startup Validation & Provider Setup
// ═══════════════════════════════════════════════════════════════════════════════

import TwilioProvider from './TwilioProvider.js';
import TelnyxProvider from './TelnyxProvider.js';
import CheapPanelProvider from './CheapPanelProvider.js';
import FreeProvider from './FreeProvider.js';
import NumberPoolManager from './NumberPoolManager.js';
import NumberBuyer from './buy-numbers.js';
import logger from '../../utils/logger.js';

/**
 * SMSProviderManager — Unified gateway for SMS number acquisition
 *
 * ARCHITECTURE (STRICT — no cross-tier failover):
 *   VIP/BUNDLE → NumberPool (Twilio + Telnyx) only
 *   CHEAP      → CheapPanelProvider (5SIM) only
 *   FREE       → FreeProvider (public/shared numbers) only
 *
 * Each tier stands alone. If a tier's provider fails, that tier fails.
 * No silent fallback to other tiers.
 */
class SMSProviderManager {
    constructor() {
        this.providers = new Map();
        this.numberPool = null;
        this.numberBuyer = null;
        this.isInitialized = false;

        this.validateBaseUrl();
        this.initializeProviders();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  STARTUP VALIDATION
    // ═══════════════════════════════════════════════════════════════════════

    validateBaseUrl() {
        const baseUrl = process.env.BASE_URL;

        if (!baseUrl) {
            logger.error('FATAL: BASE_URL environment variable is not configured');
            throw new Error('BASE_URL is not configured');
        }

        try {
            new URL(baseUrl);
        } catch (e) {
            throw new Error(`BASE_URL is invalid: ${baseUrl}`);
        }

        this.baseUrl = baseUrl.replace(/\/$/, '');
        logger.info('BASE_URL validated', { baseUrl: this.baseUrl });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PROVIDER SETUP
    // ═══════════════════════════════════════════════════════════════════════

    initializeProviders() {
        const twilio = new TwilioProvider();
        const telnyx = new TelnyxProvider();
        const cheapPanel = new CheapPanelProvider();
        const freePublic = new FreeProvider();

        this.providers.set('TWILIO', twilio);
        this.providers.set('TELNYX', telnyx);
        this.providers.set('CHEAP_PANEL', cheapPanel);
        this.providers.set('FREE_PUBLIC', freePublic);

        // NumberPool gets ONLY Twilio + Telnyx for VIP/BUNDLE
        const poolProviders = [];
        if (twilio.isActive) poolProviders.push(twilio);
        if (telnyx.isActive) poolProviders.push(telnyx);

        if (poolProviders.length > 0) {
            this.numberPool = new NumberPoolManager(...poolProviders);
            this.numberBuyer = new NumberBuyer();
        }

        logger.info('SMS Provider Manager initialized', {
            providers: Array.from(this.providers.keys()),
            poolProviders: poolProviders.map(p => p.name),
            hasPool: !!this.numberPool,
            baseUrl: this.baseUrl
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    async initialize() {
        if (this.isInitialized) return;

        if (this.numberPool) {
            await this.numberPool.initialize();
        }

        if (this.numberBuyer) {
            await this.numberBuyer.init({
                twilio: this.providers.get('TWILIO'),
                telnyx: this.providers.get('TELNYX')
            });
        }

        for (const [name, provider] of this.providers) {
            if (provider.initialize && typeof provider.initialize === 'function') {
                try {
                    await provider.initialize();
                } catch (e) {
                    logger.warn(`Provider ${name} initialize failed`, { error: e.message });
                    provider.isActive = false;
                }
            }
        }

        this.isInitialized = true;
        logger.info('SMS Provider Manager fully initialized');
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  UTILITY HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }

    escapeTelegramMessage(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\*/g, '\\*')
            .replace(/_/g, '\\_')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/`/g, '\\`');
    }

    formatTelegramStatus(status) {
        const escaped = this.escapeTelegramMessage(status.message || status.error || 'Unknown status');

        if (status.success) {
            return `✅ *SMS Received*\n\n📱 Number: \`${this.maskPhone(status.number || 'unknown')}\`\n💬 Message: ${escaped}\n🔢 OTP: \`${status.otp || 'N/A'}\`\n⏱️ Delivery: ${status.deliveryTime}ms`;
        }

        if (status.status === 'TIMEOUT') {
            return `❌ *No SMS Received*\n\n📱 Number: \`${this.maskPhone(status.number || 'unknown')}\`\n⏱️ Waited: 90 seconds\n📝 Reason: ${escaped}\n\n💡 Try retrying with a new number.`;
        }

        if (status.status === 'POLLING') {
            return `⏳ *Waiting for SMS...*\n\n🔍 ${escaped}`;
        }

        return `⚠️ *Status Update*\n\n${escaped}`;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  STRICT TIER GETTERS — Each tier uses ONLY its designated provider
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get number for VIP/BUNDLE tier — uses NumberPool ONLY (Twilio/Telnyx)
     * NO fallback to CHEAP or FREE. If pool fails, this tier fails.
     */
    async getVipNumber(country, service, userId = null, preferredProvider = null) {
        if (!this.isInitialized) await this.initialize();

        if (!country || typeof country !== 'string' || country.length !== 2) {
            throw new Error(`INVALID_COUNTRY: Expected 2-letter ISO code, got: ${country}`);
        }

        if (!this.numberPool) {
            throw new Error('POOL_NOT_AVAILABLE: Number pool not configured. Check Twilio/Telnyx credentials.');
        }

        try {
            const result = await this.numberPool.acquireNumber(country, service, userId, preferredProvider);

            if (!result) {
                throw new Error('POOL_EMPTY: No numbers available in pool');
            }

            return {
                ...result,
                tier: 'VIP',
                acquisitionMethod: 'POOL',
                provider: result.provider || preferredProvider || 'POOL'
            };

        } catch (error) {
            logger.error('VIP/BUNDLE number acquisition failed', {
                country, service, userId, error: error.message
            });
            throw error; // NO fallback — let caller handle
        }
    }

    /**
     * Get number for CHEAP tier — uses CheapPanelProvider (5SIM) ONLY
     * NO fallback to FREE. If 5SIM fails, this tier fails.
     */
    async getCheapNumber(country, service) {
        if (!this.isInitialized) await this.initialize();

        if (!country || typeof country !== 'string' || country.length !== 2) {
            throw new Error(`INVALID_COUNTRY: Expected 2-letter ISO code, got: ${country}`);
        }

        const provider = this.providers.get('CHEAP_PANEL');

        if (!provider) {
            throw new Error('CHEAP_PROVIDER_NOT_FOUND: CheapPanelProvider not registered');
        }

        if (!provider.isActive) {
            throw new Error('CHEAP_PROVIDER_INACTIVE: 5SIM provider is not active. Check API key and balance.');
        }

        try {
            const result = await provider.getNumber(country, service);

            if (!result) {
                throw new Error('CHEAP_NO_NUMBERS: No numbers available from 5SIM');
            }

            return {
                phoneNumber: result.phoneNumber,
                provider: 'CHEAP_PANEL',
                providerNumberId: result.providerNumberId,
                country: result.country || country,
                service: result.service || service,
                tier: 'CHEAP',
                acquisitionMethod: 'CHEAP_PANEL',
                cost: result.cost || 0,
                displayCost: result.displayCost || result.cost || 0
            };

        } catch (error) {
            logger.error('CHEAP number acquisition failed', {
                country, service, error: error.message
            });
            throw error; // NO fallback — let caller handle
        }
    }

    /**
     * Get dynamic price for CHEAP tier
     * Returns { simPrice, displayPrice, profit } for display to user
     */
    async getCheapPrice(country, service) {
        const provider = this.providers.get('CHEAP_PANEL');

        if (!provider || !provider.isActive) {
            throw new Error('CHEAP_PROVIDER_INACTIVE');
        }

        const result = await provider.getPrice(country, service);

        if (!result.success) {
            throw new Error(result.error || 'PRICE_CHECK_FAILED');
        }

        return {
            simPrice: result.simPrice,
            displayPrice: result.displayPrice,
            profit: result.profit,
            operator: result.operator,
            stock: result.stock,
            available: result.available
        };
    }

    /**
     * Get available countries for CHEAP tier
     * Returns list of countries with stock for the service
     */
    async getCheapCountries(service = 'Any') {
        const provider = this.providers.get('CHEAP_PANEL');

        if (!provider || !provider.isActive) {
            throw new Error('CHEAP_PROVIDER_INACTIVE');
        }

        const result = await provider.getAvailableCountries(service);

        if (!result.success) {
            throw new Error(result.error || 'COUNTRY_CHECK_FAILED');
        }

        return result.countries;
    }

    /**
     * Cancel CHEAP number with activation ID
     */
    async cancelCheapNumber(activationId) {
        const provider = this.providers.get('CHEAP_PANEL');

        if (!provider || !provider.isActive) {
            return { success: false, error: 'CHEAP_PROVIDER_INACTIVE' };
        }

        if (!activationId) {
            return { success: false, error: 'MISSING_ACTIVATION_ID' };
        }

        const cleanId = activationId.toString().trim();
        if (!/^\d+$/.test(cleanId)) {
            logger.error('cancelCheapNumber called with non-numeric ID', { activationId: cleanId });
            return { success: false, error: 'INVALID_ACTIVATION_ID: Must be numeric 5SIM activation ID' };
        }

        return provider.cancelNumber(cleanId);
    }

    /**
     * Finish CHEAP number with activation ID
     */
    async finishCheapNumber(activationId) {
        const provider = this.providers.get('CHEAP_PANEL');

        if (!provider || !provider.isActive) {
            return { success: false, error: 'CHEAP_PROVIDER_INACTIVE' };
        }

        if (!activationId) {
            return { success: false, error: 'MISSING_ACTIVATION_ID' };
        }

        const cleanId = activationId.toString().trim();
        if (!/^\d+$/.test(cleanId)) {
            return { success: false, error: 'INVALID_ACTIVATION_ID' };
        }

        return provider.finishNumber(cleanId);
    }

    /**
     * Get number for FREE tier — uses FreeProvider with ad-credit system
     */
    async getFreeNumber(country, service, userId = null) {
        if (!this.isInitialized) await this.initialize();

        if (!country || typeof country !== 'string' || country.length !== 2) {
            throw new Error(`INVALID_COUNTRY: Expected 2-letter ISO code, got: ${country}`);
        }

        const provider = this.providers.get('FREE_PUBLIC');
        if (!provider) {
            throw new Error('FREE_PROVIDER_NOT_FOUND: FreeProvider not registered');
        }

        if (!provider.isActive) {
            throw new Error('FREE_PROVIDER_INACTIVE: Free provider is not active');
        }

        try {
            const result = await provider.getNumber(country, service);

            if (!result) {
                throw new Error('FREE_NO_NUMBERS: No free numbers available');
            }

            return {
                phoneNumber: result.phoneNumber,
                provider: 'FREE_PUBLIC',
                providerNumberId: result.sessionId,
                country: result.country || country,
                service: result.service || service,
                tier: 'FREE',
                acquisitionMethod: 'FREE_PUBLIC',
                sessionId: result.sessionId,
                cost: 0,
                isPublic: true,
                warning: result.warning
            };

        } catch (error) {
            logger.error('FREE number acquisition failed', {
                country, service, userId, error: error.message
            });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  LEGACY getNumber — DEPRECATED, redirects to strict getters
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * LEGACY: Old getNumber with failover.
     * NOW STRICT: Routes to tier-specific getter, NO failover between tiers.
     */
    async getNumber(tier, country, service, preferredProvider = null, userId = null) {
        logger.warn('LEGACY getNumber() called — use tier-specific getters', { tier, country });

        switch (tier?.toUpperCase()) {
            case 'VIP':
            case 'BUNDLE':
                return this.getVipNumber(country, service, userId, preferredProvider);

            case 'CHEAP':
                return this.getCheapNumber(country, service);

            case 'FREE':
                return this.getFreeNumber(country, service, userId);

            default:
                throw new Error(`INVALID_TIER: "${tier}". Must be VIP, BUNDLE, CHEAP, or FREE`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  BALANCE CHECKING
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check balances for all active providers
     * Returns { providerName: { balance, currency, success, error } }
     */
    async checkBalances() {
        const results = {};

        for (const [name, provider] of this.providers) {
            if (!provider.isActive) {
                results[name] = { success: false, error: 'INACTIVE', balance: 0 };
                continue;
            }

            try {
                if (typeof provider.checkBalance === 'function') {
                    const balance = await provider.checkBalance();
                    results[name] = {
                        success: true,
                        balance: balance.balance || 0,
                        currency: balance.currency || 'USD',
                        rating: balance.rating,
                        raw: balance
                    };
                } else {
                    results[name] = {
                        success: false,
                        error: 'METHOD_NOT_SUPPORTED',
                        balance: 0
                    };
                }
            } catch (error) {
                results[name] = {
                    success: false,
                    error: error.message,
                    balance: 0
                };
            }
        }

        if (this.numberPool) {
            try {
                const poolStats = this.numberPool.getPoolStats?.() || {};
                results['POOL'] = {
                    success: true,
                    balance: poolStats.totalNumbers || 0,
                    currency: 'NUMBERS',
                    available: poolStats.available || 0,
                    active: poolStats.active || 0
                };
            } catch (e) {
                results['POOL'] = { success: false, error: e.message };
            }
        }

        return results;
    }

    /**
     * Get available providers with their status
     * Returns array of { name, tier, isActive, hasBalance, balance }
     */
    async getAvailableProviders() {
        const balances = await this.checkBalances();
        const providers = [];

        for (const [name, provider] of this.providers) {
            const balanceInfo = balances[name] || { success: false, balance: 0 };

            providers.push({
                name: provider.name || name,
                tier: provider.tier || 'UNKNOWN',
                isActive: provider.isActive,
                hasBalance: balanceInfo.success && (balanceInfo.balance > 0 || name === 'FREE_PUBLIC'),
                balance: balanceInfo.balance,
                currency: balanceInfo.currency,
                rating: balanceInfo.rating,
                error: balanceInfo.error
            });
        }

        providers.sort((a, b) => {
            if (a.isActive !== b.isActive) return b.isActive - a.isActive;
            if (a.hasBalance !== b.hasBalance) return b.hasBalance - a.hasBalance;
            return a.name.localeCompare(b.name);
        });

        return providers;
    }

    /**
     * Check if a specific provider has sufficient balance
     */
    async hasSufficientBalance(providerName, requiredAmount = 0) {
        const balances = await this.checkBalances();
        const providerBalance = balances[providerName];

        if (!providerBalance || !providerBalance.success) {
            return { sufficient: false, reason: 'BALANCE_CHECK_FAILED' };
        }

        if (requiredAmount > 0 && providerBalance.balance < requiredAmount) {
            return {
                sufficient: false,
                reason: 'INSUFFICIENT_BALANCE',
                required: requiredAmount,
                available: providerBalance.balance
            };
        }

        return {
            sufficient: true,
            available: providerBalance.balance,
            currency: providerBalance.currency
        };
    }
        // ═══════════════════════════════════════════════════════════════════════════════
// SMSProviderManager.js — Part 2/3
// SMS Checking, Free Tier Polling & Number Release/Cancellation
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  SMS CHECKING — Each provider uses its own correct method
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check SMS for a CHEAP tier number (5SIM).
     * 5SIM uses: checkSMS(activationId)
     */
    async checkCheapSMS(orderId) {
        if (!this.isInitialized) await this.initialize();

        const provider = this.providers.get('CHEAP_PANEL');
        if (!provider) {
            throw new Error('CHEAP_PROVIDER_NOT_FOUND');
        }

        if (typeof provider.checkSMS === 'function') {
            return provider.checkSMS(orderId);
        }

        throw new Error('CHEAP_PROVIDER_NO_CHECK_METHOD: Provider missing checkSMS');
    }

    /**
     * Check SMS for a FREE tier number.
     * FreeProvider uses: pollForSMS(sessionId, onStatusUpdate) for live polling
     * OR checkSMS(sessionId) for one-shot check
     */
    async checkFreeSMS(sessionId, onStatusUpdate = null) {
        if (!this.isInitialized) await this.initialize();

        const provider = this.providers.get('FREE_PUBLIC');
        if (!provider) {
            throw new Error('FREE_PROVIDER_NOT_FOUND');
        }

        // If live polling requested and provider supports it
        if (onStatusUpdate && typeof provider.pollForSMS === 'function') {
            return provider.pollForSMS(sessionId, onStatusUpdate);
        }

        // One-shot check
        if (typeof provider.checkSMS === 'function') {
            return provider.checkSMS(sessionId);
        }

        // Fallback: try getSMS
        if (typeof provider.getSMS === 'function') {
            return provider.getSMS(sessionId);
        }

        throw new Error('FREE_PROVIDER_NO_CHECK_METHOD: FreeProvider missing checkSMS/pollForSMS/getSMS');
    }

    /**
     * Check SMS for POOL number (VIP/BUNDLE).
     * Pool numbers use webhooks — check database/session status.
     */
    async checkPoolSMS(sessionId) {
        if (!this.isInitialized) await this.initialize();

        if (!this.numberPool) {
            throw new Error('POOL_NOT_AVAILABLE');
        }

        // Pool numbers are webhook-driven — return waiting status
        // Actual SMS is stored in Session model by webhook handler
        return {
            success: false,
            status: 'WAITING',
            message: 'Pool numbers use webhooks. Check session status in database.',
            provider: 'NUMBER_POOL'
        };
    }

    /**
     * LEGACY checkSMS — DEPRECATED.
     * Routes to correct tier-specific checker.
     */
    async checkSMS(providerName, identifier, options = {}) {
        logger.warn('LEGACY checkSMS() called — use tier-specific checkers', { providerName });

        if (providerName === 'FREE_PUBLIC' || providerName === 'FREE') {
            return this.checkFreeSMS(identifier, options.onStatusUpdate);
        }

        if (providerName === 'CHEAP_PANEL' || providerName === 'CHEAP') {
            return this.checkCheapSMS(identifier);
        }

        if (providerName === 'NUMBER_POOL' || providerName === 'TWILIO' || providerName === 'TELNYX') {
            return this.checkPoolSMS(identifier);
        }

        // Direct provider lookup fallback
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`PROVIDER_NOT_FOUND: ${providerName}`);
        }

        const checkMethod = provider.checkSMS || provider.getSMS || provider.getCode;
        if (typeof checkMethod !== 'function') {
            return {
                success: false,
                status: 'UNSUPPORTED',
                message: `Provider ${providerName} does not support SMS checking`
            };
        }

        return checkMethod.call(provider, identifier);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FREE TIER POLLING (For OTPCommands.startFreePolling)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Poll for SMS on a free tier session.
     * This is what OTPCommands.startFreePolling() calls.
     */
    async pollFreeSMS(sessionId, onStatusUpdate = null) {
        return this.checkFreeSMS(sessionId, onStatusUpdate);
    }

    /**
     * Retry free tier with new number.
     */
    async retryFreeNumber(sessionId, country = 'US', service = 'Any') {
        const provider = this.providers.get('FREE_PUBLIC');
        if (!provider) {
            throw new Error('FREE_PROVIDER_NOT_AVAILABLE');
        }

        if (typeof provider.retryWithNewNumber === 'function') {
            return provider.retryWithNewNumber(sessionId, country, service);
        }

        // Fallback: cancel old, get new
        if (typeof provider.cancelNumber === 'function') {
            await provider.cancelNumber(sessionId).catch(() => {});
        }

        return this.getFreeNumber(country, service);
    }

    /**
     * Get first active provider name (legacy compatibility)
     */
    getCurrentProvider() {
        const active = this.getActiveProviders();
        return active.length > 0 ? active[0] : null;
    }

    /**
     * Get free provider health status.
     */
    getFreeProviderHealth() {
        const provider = this.providers.get('FREE_PUBLIC');
        if (!provider) {
            return { available: false };
        }

        return {
            available: true,
            providers: typeof provider.getProviderHealth === 'function' ? provider.getProviderHealth() : [],
            activeSessions: typeof provider.getActiveSessions === 'function' ? provider.getActiveSessions() : []
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  NUMBER RELEASE / CANCELLATION
    // ═══════════════════════════════════════════════════════════════════════

    async cancelNumber(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        // Pool numbers (VIP/BUNDLE)
        if (providerName === 'NUMBER_POOL' || providerName === 'TWILIO' || providerName === 'TELNYX') {
            if (!this.numberPool) {
                return { success: false, error: 'POOL_NOT_INITIALIZED' };
            }
            return this.numberPool.releaseNumber(identifier, 'USER_CANCELLED');
        }

        // FreeProvider sessions
        if (providerName === 'FREE_PUBLIC' || providerName === 'FREE') {
            const provider = this.providers.get('FREE_PUBLIC');
            if (provider?.cancelNumber && typeof provider.cancelNumber === 'function') {
                return provider.cancelNumber(identifier);
            }
            return { success: true, status: 'RELEASED' };
        }

        // CheapPanel (5SIM) — route to dedicated method
        if (providerName === 'CHEAP_PANEL' || providerName === 'CHEAP') {
            return this.cancelCheapNumber(identifier);
        }

        // Direct lookup
        const provider = this.providers.get(providerName);
        if (!provider) {
            return { success: false, error: `PROVIDER_NOT_FOUND: ${providerName}` };
        }

        if (provider.cancelNumber && typeof provider.cancelNumber === 'function') {
            return provider.cancelNumber(identifier);
        }

        return { success: true, note: 'Nothing to cancel for this provider' };
    }

    async finishNumber(providerName, identifier) {
        if (!this.isInitialized) await this.initialize();

        if (providerName === 'NUMBER_POOL' || providerName === 'TWILIO' || providerName === 'TELNYX') {
            if (!this.numberPool) {
                return { success: false, error: 'POOL_NOT_INITIALIZED' };
            }
            return this.numberPool.releaseNumber(identifier, 'SESSION_END');
        }

        if (providerName === 'FREE_PUBLIC' || providerName === 'FREE') {
            const provider = this.providers.get('FREE_PUBLIC');
            if (provider?.finishNumber && typeof provider.finishNumber === 'function') {
                return provider.finishNumber(identifier);
            }
            return { success: true, status: 'FINISHED' };
        }

        if (providerName === 'CHEAP_PANEL' || providerName === 'CHEAP') {
            return this.finishCheapNumber(identifier);
        }

        const provider = this.providers.get(providerName);
        if (provider?.finishNumber && typeof provider.finishNumber === 'function') {
            return provider.finishNumber(identifier);
        }

        return { success: true, note: 'No finish action required' };
    }
    // ═══════════════════════════════════════════════════════════════════════════════
// SMSProviderManager.js — Part 3/3
// Pool Management, Stats & Monitoring, Shutdown
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  POOL MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    async buyPoolNumbers(country = 'US', quantity = 1, preferredProvider = null) {
        if (!this.numberPool || !this.numberBuyer) {
            throw new Error('POOL_NOT_AVAILABLE: Number pool not configured');
        }

        if (!this.isInitialized) await this.initialize();

        const result = await this.numberBuyer.buyMultiple(
            [{ country, count: quantity, preferredProvider }],
            { abortOnError: false }
        );

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

    // ═══════════════════════════════════════════════════════════════════════
    //  STATS & MONITORING
    // ═══════════════════════════════════════════════════════════════════════

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

    getProviderInstance(name) {
        return this.providers.get(name);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SHUTDOWN
    // ═══════════════════════════════════════════════════════════════════════

    async shutdown() {
        if (this.numberBuyer) {
            try {
                await this.numberBuyer.shutdown();
            } catch (e) {
                logger.warn('NumberBuyer shutdown failed', { error: e.message });
            }
        }

        if (this.numberPool) {
            try {
                await this.numberPool.uninitialize();
            } catch (e) {
                logger.warn('Pool uninitialize failed', { error: e.message });
            }
        }

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
