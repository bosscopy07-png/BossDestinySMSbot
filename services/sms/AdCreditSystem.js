
// ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — Time-based ad verification (no external postback)
// ═══════════════════════════════════════════════════════════════════════════════

import { User, AdView } from '../../models/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * AdCreditSystem — Manages ad views → credit conversion via time-based verification
 *
 * Architecture:
 * - Primary URL: omg10.com redirect
 * - Fallback URL: profitablecpmratenetwork.com redirect
 * - Verification: User must spend MIN_WATCH_TIME (30s) on ad before claiming
 * - No external postback required — time gate prevents instant abuse
 */
class AdCreditSystem {
    constructor() {
        this.PRIMARY_URL = config.adSystem?.primaryUrl || process.env.AD_PRIMARY_URL || 'https://omg10.com/4/10967769';
        this.FALLBACK_URL = config.adSystem?.fallbackUrl || process.env.AD_FALLBACK_URL || 'https://www.profitablecpmratenetwork.com/zs5wg1ki?key=cb472c48fad6246f544094483b9f9bcc';

        this.COSTS = {
            NUMBER_REQUEST: config.adSystem?.creditsPerRequest || 2,
            DAILY_FREE_LIMIT: config.limits?.freeDaily || 3
        };

        // Minimum time user must spend on ad before credits unlock (milliseconds)
        this.MIN_WATCH_TIME = 30000; // 30 seconds

        // Active ad sessions: verificationId -> { userId, startTime, credits, status, urlType }
        this.activeVerifications = new Map();

        // Cleanup interval
        this._startCleanupInterval();

        logger.info('AdCreditSystem initialized', {
            primaryUrl: this.PRIMARY_URL.substring(0, 30) + '...',
            fallbackUrl: this.FALLBACK_URL.substring(0, 30) + '...',
            minWatchTime: `${this.MIN_WATCH_TIME}ms`,
            costPerRequest: this.COSTS.NUMBER_REQUEST
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CREDIT MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    async getCredits(userId) {
        const user = await User.findOne({ userId }).lean();
        if (!user) {
            return { credits: 0, dailyUsed: 0, dailyLimit: this.COSTS.DAILY_FREE_LIMIT };
        }

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

    async canRequestNumber(userId) {
        const credits = await this.getCredits(userId);

        if (credits.dailyUsed >= credits.dailyLimit) {
            return {
                allowed: false,
                reason: 'DAILY_LIMIT_REACHED',
                message: `You've used ${credits.dailyUsed}/${credits.dailyLimit} free requests today. Resets at midnight UTC.`,
                credits: credits.credits,
                required: this.COSTS.NUMBER_REQUEST
            };
        }

        if (credits.credits >= this.COSTS.NUMBER_REQUEST) {
            return {
                allowed: true,
                reason: 'CREDITS_SUFFICIENT',
                credits: credits.credits,
                required: this.COSTS.NUMBER_REQUEST,
                remainingAfter: credits.credits - this.COSTS.NUMBER_REQUEST
            };
        }

        return {
            allowed: false,
            reason: 'INSUFFICIENT_CREDITS',
            message: `Need ${this.COSTS.NUMBER_REQUEST} credits. You have ${credits.credits}.`,
            credits: credits.credits,
            required: this.COSTS.NUMBER_REQUEST,
            shortfall: this.COSTS.NUMBER_REQUEST - credits.credits
        };
    }

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
    //  AD VIEW GENERATION — Records start time when user opens ad
    // ═══════════════════════════════════════════════════════════════════════

    async generateAdView(userId, networkType = 'primary') {
        const verificationId = `ad_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const isPrimary = networkType === 'primary';
        const baseUrl = isPrimary ? this.PRIMARY_URL : this.FALLBACK_URL;

        const separator = baseUrl.includes('?') ? '&' : '?';
        const adUrl = `${baseUrl}${separator}subId=${verificationId}&userId=${userId}`;

        // Store with startTime = now (user hasn't opened yet, but will soon)
        this.activeVerifications.set(verificationId, {
            userId,
            credits: 2,
            startTime: null, // Set when user actually opens
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
            estimatedTime: '30 sec',
            creditValue: 2,
            minWatchTime: this.MIN_WATCH_TIME
        };
    }

    /**
     * Record that user opened the ad (called when "Open Ad" button tapped)
     */
    recordAdStart(verificationId) {
        const verification = this.activeVerifications.get(verificationId);
        if (!verification) {
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        verification.startTime = Date.now();
        this.activeVerifications.set(verificationId, verification);

        logger.info('Ad watch started', {
            userId: verification.userId,
            verificationId,
            startedAt: verification.startTime
        });

        return {
            success: true,
            startedAt: verification.startTime,
            minWatchTime: this.MIN_WATCH_TIME,
            canClaimAt: verification.startTime + this.MIN_WATCH_TIME
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CREDIT CLAIM — User taps "Check My Credits" after watching
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check if enough time has passed and award credits
     */
    async claimCredits(verificationId) {
        const verification = this.activeVerifications.get(verificationId);

        if (!verification) {
            return {
                success: false,
                error: 'VERIFICATION_NOT_FOUND',
                message: 'Ad session expired. Please watch a new ad.'
            };
        }

        if (verification.status === 'COMPLETED') {
            return {
                success: false,
                error: 'ALREADY_COMPLETED',
                message: 'Credits already claimed for this ad.'
            };
        }

        // Must have started watching
        if (!verification.startTime) {
            return {
                success: false,
                error: 'WATCH_NOT_STARTED',
                message: 'Please open the ad first.',
                minWatchTime: this.MIN_WATCH_TIME
            };
        }

        const elapsed = Date.now() - verification.startTime;

        // Time gate: must wait MIN_WATCH_TIME
        if (elapsed < this.MIN_WATCH_TIME) {
            const remaining = Math.ceil((this.MIN_WATCH_TIME - elapsed) / 1000);
            return {
                success: false,
                error: 'TIME_NOT_ELAPSED',
                message: `Please wait ${remaining} more seconds.`,
                elapsed: Math.floor(elapsed / 1000),
                required: Math.floor(this.MIN_WATCH_TIME / 1000),
                remaining
            };
        }

        // Time satisfied — award credits
        return this._awardCredits(verificationId, verification, { elapsed });
    }

    /**
     * Internal: Award credits and record completion
     */
    async _awardCredits(verificationId, verification, metadata = {}) {
        const { userId, credits } = verification;

        try {
            await User.updateOne(
                { userId },
                { $inc: { adCredits: credits } }
            );

            await AdView.create({
                viewId: verificationId,
                userId,
                network: verification.urlType,
                creditsEarned: credits,
                status: 'COMPLETED',
                completedAt: new Date(),
                watchDuration: metadata.elapsed,
                metadata
            });

            verification.status = 'COMPLETED';
            verification.completedAt = Date.now();
            this.activeVerifications.set(verificationId, verification);

            const totalCredits = await this.getCredits(userId);

            logger.info('Ad credit awarded', {
                userId,
                verificationId,
                credits,
                watchDuration: metadata.elapsed,
                type: verification.urlType
            });

            return {
                success: true,
                creditsAdded: credits,
                totalCredits: totalCredits.credits,
                watchDuration: metadata.elapsed
            };

        } catch (error) {
            logger.error('Failed to award ad credits', {
                verificationId,
                userId,
                error: error.message
            });
            return {
                success: false,
                error: 'AWARD_FAILED',
                message: 'System error. Please try again.'
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  LEGACY POSTBACK — Kept for compatibility if networks ever support it
    // ═══════════════════════════════════════════════════════════════════════

    async handlePostback(query = {}) {
        const { verify, subId, status } = query;
        const verificationId = verify || subId;

        if (!verificationId) {
            return { success: false, error: 'MISSING_VERIFICATION_ID' };
        }

        // If network sends completed status, bypass time gate
        if (status === 'completed' || status === 'approved') {
            const verification = this.activeVerifications.get(verificationId);
            if (!verification) {
                return { success: false, error: 'VERIFICATION_NOT_FOUND' };
            }
            if (verification.status === 'COMPLETED') {
                return { success: false, error: 'ALREADY_COMPLETED' };
            }
            return this._awardCredits(verificationId, verification, { source: 'postback' });
        }

        return { success: false, error: 'STATUS_NOT_COMPLETED' };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  UTILITY
    // ═══════════════════════════════════════════════════════════════════════

    getAvailableNetworks() {
        return [
            {
                id: 'primary',
                name: 'Watch Ad',
                creditValue: 2,
                configured: !!this.PRIMARY_URL,
                minWatchTime: Math.floor(this.MIN_WATCH_TIME / 1000)
            },
            {
                id: 'fallback',
                name: 'Watch Ad (Alt)',
                creditValue: 2,
                configured: !!this.FALLBACK_URL,
                minWatchTime: Math.floor(this.MIN_WATCH_TIME / 1000)
            }
        ].filter(n => n.configured);
    }

    _startCleanupInterval() {
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
                    started: !!v.startTime,
                    elapsed: v.startTime ? Math.floor((now - v.startTime) / 1000) : 0,
                    age: Math.floor((now - v.createdAt) / 1000)
                });
            }
        }
        return pending;
    }
}

export default AdCreditSystem;
                    
