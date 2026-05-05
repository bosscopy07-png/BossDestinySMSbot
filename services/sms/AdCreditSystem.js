// ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — Part 1/2: Core Credit Management & Ad View Handling
// ═══════════════════════════════════════════════════════════════════════════════

import { User, AdView, Transaction } from '../../models/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * AdCreditSystem — Manages ad views → credit conversion
 *
 * Model:
 * - 1 ad view = 1 credit
 * - 2-3 credits = 1 number request
 * - Daily FREE limit: 3 requests
 * - Credits expire daily (optional)
 */
class AdCreditSystem {
    constructor() {
        this.AD_NETWORKS = {
            shorte_st: { name: 'Shorte.st', type: 'link', creditValue: 1 },
            adfly: { name: 'AdFly', type: 'link', creditValue: 1 },
            cpagrip: { name: 'CPAGrip', type: 'locker', creditValue: 2 },
            ogads: { name: 'OGAds', type: 'locker', creditValue: 2 },
            admaven: { name: 'AdMaven', type: 'push', creditValue: 1 },
            propeller: { name: 'PropellerAds', type: 'push', creditValue: 1 },
            aads: { name: 'A-Ads', type: 'crypto', creditValue: 1 }
        };

        this.COSTS = {
            NUMBER_REQUEST: config.adSystem?.creditsPerRequest || 2,
            DAILY_FREE_LIMIT: config.limits?.freeDaily || 3
        };

        this.activeVerifications = new Map(); // pending ad completions

        logger.info('AdCreditSystem initialized', {
            networks: Object.keys(this.AD_NETWORKS).length,
            costPerRequest: this.COSTS.NUMBER_REQUEST
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CREDIT MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get user's current ad credits
     */
    async getCredits(userId) {
        const user = await User.findOne({ userId }).lean();
        if (!user) return { credits: 0, dailyUsed: 0, dailyLimit: this.COSTS.DAILY_FREE_LIMIT };

        // Check if daily reset needed
        const lastReset = user.adCreditReset ? new Date(user.adCreditReset) : null;
        const now = new Date();
        const shouldReset = !lastReset || lastReset.getDate() !== now.getDate();

        if (shouldReset) {
            await User.updateOne(
                { userId },
                {
                    $set: {
                        adCredits: 0,
                        adCreditReset: now,
                        freeUsedToday: 0
                    }
                }
            );
            return { credits: 0, dailyUsed: 0, dailyLimit: this.COSTS.DAILY_FREE_LIMIT };
        }

        return {
            credits: user.adCredits || 0,
            dailyUsed: user.freeUsedToday || 0,
            dailyLimit: this.COSTS.DAILY_FREE_LIMIT
        };
    }

    /**
     * Check if user can request a free number
     */
    async canRequestNumber(userId) {
        const credits = await this.getCredits(userId);

        // Check daily limit first
        if (credits.dailyUsed >= credits.dailyLimit) {
            return {
                allowed: false,
                reason: 'DAILY_LIMIT_REACHED',
                message: `You've used ${credits.dailyUsed}/${credits.dailyLimit} free requests today. Resets at midnight.`,
                credits: credits.credits,
                required: this.COSTS.NUMBER_REQUEST
            };
        }

        // Check credits
        if (credits.credits >= this.COSTS.NUMBER_REQUEST) {
            return {
                allowed: true,
                reason: 'CREDITS_SUFFICIENT',
                credits: credits.credits,
                required: this.COSTS.NUMBER_REQUEST,
                remainingAfter: credits.credits - this.COSTS.NUMBER_REQUEST
            };
        }

        // Not enough credits — need to watch ad
        return {
            allowed: false,
            reason: 'INSUFFICIENT_CREDITS',
            message: `Need ${this.COSTS.NUMBER_REQUEST} credits. You have ${credits.credits}.`,
            credits: credits.credits,
            required: this.COSTS.NUMBER_REQUEST,
            shortfall: this.COSTS.NUMBER_REQUEST - credits.credits
        };
    }

    /**
     * Deduct credits for number request
     */
    async deductCredits(userId) {
        const check = await this.canRequestNumber(userId);
        if (!check.allowed) {
            throw new Error(check.reason);
        }

        await User.updateOne(
            { userId },
            {
                $inc: {
                    adCredits: -this.COSTS.NUMBER_REQUEST,
                    freeUsedToday: 1
                }
            }
        );

        logger.info('Credits deducted for free number', {
            userId,
            cost: this.COSTS.NUMBER_REQUEST,
            remaining: check.remainingAfter
        });

        return {
            success: true,
            deducted: this.COSTS.NUMBER_REQUEST,
            remaining: check.remainingAfter
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AD VIEW HANDLING
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Generate ad view URL for user
     */
    async generateAdView(userId, network = 'shorte_st') {
        const networkConfig = this.AD_NETWORKS[network];
        if (!networkConfig) {
            throw new Error(`INVALID_NETWORK: ${network}`);
        }

        const verificationId = `ad_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store pending verification
        this.activeVerifications.set(verificationId, {
            userId,
            network,
            createdAt: Date.now(),
            status: 'PENDING'
        });

        // Generate monetized link
        const adUrl = this._buildAdUrl(network, verificationId);

        logger.info('Ad view generated', { userId, network, verificationId });

        return {
            verificationId,
            adUrl,
            network: networkConfig.name,
            type: networkConfig.type,
            estimatedTime: networkConfig.type === 'locker' ? '30-60 sec' : '15-30 sec',
            creditValue: networkConfig.creditValue
        };
    }

    /**
     * Webhook handler for ad completion
     */
    async handleAdWebhook(verificationId, payload) {
        const verification = this.activeVerifications.get(verificationId);
        if (!verification) {
            logger.warn('Ad verification not found', { verificationId });
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        if (verification.status === 'COMPLETED') {
            return { success: false, error: 'ALREADY_COMPLETED' };
        }

        // Validate with ad network
        const isValid = await this._validateAdCompletion(verification, payload);
        if (!isValid) {
            verification.status = 'FAILED';
            this.activeVerifications.set(verificationId, verification);
            return { success: false, error: 'VALIDATION_FAILED' };
        }

        // Credit user
        const networkConfig = this.AD_NETWORKS[verification.network];
        const creditsToAdd = networkConfig.creditValue;

        await User.updateOne(
            { userId: verification.userId },
            { $inc: { adCredits: creditsToAdd } }
        );

        // Record ad view
        await AdView.create({
            viewId: verificationId,
            userId: verification.userId,
            network: verification.network,
            creditsEarned: creditsToAdd,
            completedAt: new Date(),
            metadata: payload
        });

        verification.status = 'COMPLETED';
        this.activeVerifications.set(verificationId, verification);

        logger.info('Ad credit awarded', {
            userId: verification.userId,
            verificationId,
            credits: creditsToAdd
        });

        return {
            success: true,
            creditsAdded: creditsToAdd,
            totalCredits: await this.getCredits(verification.userId)
        };
        }
                // ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — Part 2/2: URL Builders, Validation & Utilities
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  AD URL BUILDERS (Replace with actual API integrations)
    // ═══════════════════════════════════════════════════════════════════════

    _buildAdUrl(network, verificationId) {
        const baseUrls = {
            shorte_st: `https://sh.st/stub/${verificationId}`,
            adfly: `https://adf.ly/stub/${verificationId}`,
            cpagrip: `https://www.cpagrip.com/show.php?id=${verificationId}`,
            ogads: `https://locked1.com/stub/${verificationId}`,
            admaven: `https://admaven.com/stub/${verificationId}`,
            propeller: `https://propellerads.com/stub/${verificationId}`,
            aads: `https://a-ads.com/stub/${verificationId}`
        };

        // Add callback URL
        const callbackUrl = encodeURIComponent(`${process.env.BASE_URL}/webhook/ad/${verificationId}`);
        return `${baseUrls[network]}?callback=${callbackUrl}`;
    }

    async _validateAdCompletion(verification, payload) {
        // TODO: Implement actual validation per ad network
        // This should verify the completion token/signature with the ad network's API

        // Placeholder: accept if payload has valid structure
        return payload && (
            payload.completed === true ||
            payload.status === 'completed' ||
            payload.verified === true
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  UTILITY
    // ═══════════════════════════════════════════════════════════════════════

    getAvailableNetworks() {
        return Object.entries(this.AD_NETWORKS).map(([id, config]) => ({
            id,
            ...config
        }));
    }

    getPendingVerifications() {
        const now = Date.now();
        const pending = [];
        for (const [id, v] of this.activeVerifications) {
            if (v.status === 'PENDING' && now - v.createdAt < 3600000) { // 1 hour expiry
                pending.push({
                    id,
                    userId: v.userId,
                    network: v.network,
                    age: Math.floor((now - v.createdAt) / 1000)
                });
            }
        }
        return pending;
    }

    cleanupOldVerifications() {
        const now = Date.now();
        let cleaned = 0;
        for (const [id, v] of this.activeVerifications) {
            if (now - v.createdAt > 3600000 || v.status === 'COMPLETED') {
                this.activeVerifications.delete(id);
                cleaned++;
            }
        }
        return cleaned;
    }
}

export default AdCreditSystem;
