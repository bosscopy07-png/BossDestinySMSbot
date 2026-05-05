// ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — Simplified: Primary + Fallback redirect URLs
// ═══════════════════════════════════════════════════════════════════════════════

import { User, AdView } from '../../models/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * AdCreditSystem — Manages ad views → credit conversion
 *
 * Architecture:
 * - Primary URL: omg10.com redirect (no API needed)
 * - Fallback URL: profitablecpmratenetwork.com redirect (no API needed)
 * - Server-side postback for verification via webhook
 * - In-memory verification tracking with automatic cleanup
 */
class AdCreditSystem {
    constructor() {
        // Primary and fallback ad URLs from config or env
        this.PRIMARY_URL = config.adSystem?.primaryUrl || process.env.AD_PRIMARY_URL || 'https://omg10.com/4/10967769';
        this.FALLBACK_URL = config.adSystem?.fallbackUrl || process.env.AD_FALLBACK_URL || 'https://www.profitablecpmratenetwork.com/zs5wg1ki?key=cb472c48fad6246f544094483b9f9bcc';

        this.COSTS = {
            NUMBER_REQUEST: config.adSystem?.creditsPerRequest || 2,
            DAILY_FREE_LIMIT: config.limits?.freeDaily || 3
        };

        // Verification tracking: verificationId -> { userId, credits, status, createdAt }
        this.activeVerifications = new Map();

        // Start cleanup interval
        this._startCleanupInterval();

        logger.info('AdCreditSystem initialized', {
            primaryUrl: this.PRIMARY_URL.substring(0, 30) + '...',
            fallbackUrl: this.FALLBACK_URL.substring(0, 30) + '...',
            costPerRequest: this.COSTS.NUMBER_REQUEST
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CREDIT MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get user's current ad credits + daily usage
     */
    async getCredits(userId) {
        const user = await User.findOne({ userId }).lean();
        if (!user) {
            return { credits: 0, dailyUsed: 0, dailyLimit: this.COSTS.DAILY_FREE_LIMIT };
        }

        // Check if daily reset needed (midnight UTC)
        const lastReset = user.adCreditReset ? new Date(user.adCreditReset) : null;
        const now = new Date();
        const shouldReset = !lastReset ||
            lastReset.getUTCDate() !== now.getUTCDate() ||
            lastReset.getUTCMonth() !== now.getUTCMonth() ||
            lastReset.getUTCFullYear() !== now.getUTCFullYear();

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

        // Daily limit check
        if (credits.dailyUsed >= credits.dailyLimit) {
            return {
                allowed: false,
                reason: 'DAILY_LIMIT_REACHED',
                message: `You've used ${credits.dailyUsed}/${credits.dailyLimit} free requests today. Resets at midnight UTC.`,
                credits: credits.credits,
                required: this.COSTS.NUMBER_REQUEST
            };
        }

        // Credit check
        if (credits.credits >= this.COSTS.NUMBER_REQUEST) {
            return {
                allowed: true,
                reason: 'CREDITS_SUFFICIENT',
                credits: credits.credits,
                required: this.COSTS.NUMBER_REQUEST,
                remainingAfter: credits.credits - this.COSTS.NUMBER_REQUEST
            };
        }

        // Need more credits — show ad prompt
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
    //  AD VIEW GENERATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Generate ad view URL for user
     * Returns { verificationId, adUrl, network, type, creditValue }
     */
    async generateAdView(userId, networkType = 'primary') {
        const verificationId = `ad_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const isPrimary = networkType === 'primary';
        const baseUrl = isPrimary ? this.PRIMARY_URL : this.FALLBACK_URL;

        // Build tracking URL with verification params
        const separator = baseUrl.includes('?') ? '&' : '?';
        const adUrl = `${baseUrl}${separator}subId=${verificationId}&userId=${userId}`;

        // Store pending verification
        this.activeVerifications.set(verificationId, {
            userId,
            credits: 2, // Each ad view = 2 credits
            createdAt: Date.now(),
            status: 'PENDING',
            urlType: isPrimary ? 'primary' : 'fallback'
        });

        logger.info('Ad view generated', { userId, verificationId, type: isPrimary ? 'primary' : 'fallback' });

        return {
            verificationId,
            adUrl,
            network: isPrimary ? 'Ad Network' : 'Fallback Network',
            type: 'redirect',
            estimatedTime: '15-30 sec',
            creditValue: 2
        };
    }

    /**
     * Get available ad options for user
     */
    getAvailableNetworks() {
        return [
            {
                id: 'primary',
                name: 'Watch Ad',
                creditValue: 2,
                configured: !!this.PRIMARY_URL
            },
            {
                id: 'fallback',
                name: 'Watch Ad (Alt)',
                creditValue: 2,
                configured: !!this.FALLBACK_URL
            }
        ].filter(n => n.configured);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  POSTBACK WEBHOOK HANDLER
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Handle postback from ad network
     * Route: GET /webhook/ad?verify={verificationId}&status=completed
     */
    async handlePostback(query = {}) {
        const { verify, subId, status, userId: queryUserId } = query;

        const verificationId = verify || subId;
        if (!verificationId) {
            return { success: false, error: 'MISSING_VERIFICATION_ID' };
        }

        // Allow manual override for testing: ?status=completed&verify=xxx
        const isCompleted = status === 'completed' || status === 'approved';

        return this._processVerification(verificationId, {
            status: isCompleted ? 'completed' : 'pending',
            query
        });
    }

    /**
     * Process verified completion — award credits to user
     */
    async _processVerification(verificationId, metadata = {}) {
        const verification = this.activeVerifications.get(verificationId);

        if (!verification) {
            logger.warn('Verification not found or expired', { verificationId });
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        if (verification.status === 'COMPLETED') {
            return { success: false, error: 'ALREADY_COMPLETED' };
        }

        const { userId, credits } = verification;

        try {
            // Update user credits
            await User.updateOne(
                { userId },
                { $inc: { adCredits: credits } }
            );

            // Record the ad view
            await AdView.create({
                viewId: verificationId,
                userId,
                network: verification.urlType,
                creditsEarned: credits,
                status: 'COMPLETED',
                completedAt: new Date(),
                metadata
            });

            // Mark as completed
            verification.status = 'COMPLETED';
            verification.completedAt = Date.now();
            this.activeVerifications.set(verificationId, verification);

            logger.info('Ad credit awarded', {
                userId,
                verificationId,
                credits,
                type: verification.urlType
            });

            const totalCredits = await this.getCredits(userId);

            return {
                success: true,
                creditsAdded: credits,
                totalCredits: totalCredits.credits
            };

        } catch (error) {
            logger.error('Failed to award ad credits', {
                verificationId,
                userId,
                error: error.message
            });
            return { success: false, error: 'AWARD_FAILED', details: error.message };
        }
    }

    /**
     * Manual verification for admin/testing
     */
    async manualVerify(verificationId) {
        return this._processVerification(verificationId, { source: 'manual' });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CLEANUP
    // ═══════════════════════════════════════════════════════════════════════

    _startCleanupInterval() {
        // Clean up old verifications every 5 minutes
        setInterval(() => {
            const cleaned = this.cleanupOldVerifications();
            if (cleaned > 0) {
                logger.debug('Cleaned old verifications', { count: cleaned });
            }
        }, 300000);
    }

    cleanupOldVerifications() {
        const now = Date.now();
        const maxAge = 3600000; // 1 hour
        let cleaned = 0;

        for (const [id, v] of this.activeVerifications) {
            if (now - v.createdAt > maxAge || v.status === 'COMPLETED') {
                this.activeVerifications.delete(id);
                cleaned++;
            }
        }
        return cleaned;
    }

    getPendingVerifications() {
        const now = Date.now();
        const pending = [];
        for (const [id, v] of this.activeVerifications) {
            if (v.status === 'PENDING' && now - v.createdAt < 3600000) {
                pending.push({
                    id,
                    userId: v.userId,
                    age: Math.floor((now - v.createdAt) / 1000)
                });
            }
        }
        return pending;
    }
}

export default AdCreditSystem;
                                                             
