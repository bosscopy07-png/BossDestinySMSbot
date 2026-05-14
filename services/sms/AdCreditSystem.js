// ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — MongoDB-backed, cross-process safe
// ═══════════════════════════════════════════════════════════════════════════════

import { User, AdView, CreditTransaction, AdVerification } from '../../models/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';
import crypto from 'crypto';

class AdCreditSystem {
    constructor() {
        this.PRIMARY_URL = config.adSystem?.primaryUrl || process.env.AD_PRIMARY_URL || 'https://omg10.com/4/10967769';
        this.FALLBACK_URL = config.adSystem?.fallbackUrl || process.env.AD_FALLBACK_URL || 'https://www.profitablecpmratenetwork.com/zs5wg1ki?key=cb472c48fad6246f544094483b9f9bcc';

        this.COSTS = {
            NUMBER_REQUEST: config.adSystem?.creditsPerRequest || 2,
            DAILY_FREE_LIMIT: config.limits?.freeDaily || 3
        };

        this.MIN_WATCH_TIME = 30000;
        this.CLAIM_COOLDOWN = 60000;
        this.MAX_CLAIMS_PER_HOUR = 10;
        this.HOLD_EXPIRY_MS = 30000;

        this.POSTBACK_SECRET = config.adSystem?.postbackSecret || process.env.AD_POSTBACK_SECRET || 'default-secret-change-me';

        // In-memory tracking (kept for speed, but backed by MongoDB)
        this.activeHolds = new Map();
        this.userClaimHistory = new Map();
        this.userHoldHistory = new Map();

        this.MAX_CLAIM_HISTORY_PER_USER = 50;
        this.MAX_HOLDS_PER_USER = 5;

        this._startCleanupInterval();

        logger.info('AdCreditSystem v3 initialized', {
            primaryUrl: this._maskUrl(this.PRIMARY_URL),
            costPerRequest: this.COSTS.NUMBER_REQUEST,
            dailyFreeLimit: this.COSTS.DAILY_FREE_LIMIT
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  VERIFICATION CRUD (MongoDB-backed)
    // ═══════════════════════════════════════════════════════════════════════

    async createVerification(userId, networkType = 'primary') {
        const verificationId = `ad_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const isPrimary = networkType === 'primary';
        const networkEnum = isPrimary ? 'omg10' : 'profitablecpm';

        const verification = await AdVerification.create({
            verificationId,
            userId: String(userId),
            credits: 2,
            status: 'PENDING',
            urlType: networkEnum
        });

        logger.info('Ad verification created', { userId, verificationId, network: networkEnum });

        return {
            verificationId,
            adUrl: this._buildAdUrl(verificationId, userId),
            network: networkEnum,
            creditValue: 2,
            minWatchTime: this.MIN_WATCH_TIME
        };
    }

    async getVerification(verificationId) {
        return AdVerification.findOne({ verificationId }).lean();
    }

    async updateVerification(verificationId, updates) {
        return AdVerification.findOneAndUpdate(
            { verificationId },
            { $set: updates },
            { new: true }
        ).lean();
    }
    // Add to AdCreditSystem class

/**
 * Cleanup old verifications from MongoDB
 * Called by FreeProvider's cleanup job
 */
async cleanupOldVerifications() {
    // MongoDB TTL handles automatic deletion, but we can force cleanup
    const cutoff = new Date(Date.now() - 3600000); // 1 hour old
    
    const result = await AdVerification.deleteMany({
        createdAt: { $lt: cutoff },
        status: { $in: ['PENDING', 'STARTED'] } // Don't delete COMPLETED (keep for records)
    });
    
    if (result.deletedCount > 0) {
        logger.debug('Cleaned old ad verifications', { count: result.deletedCount });
    }
    
    return result.deletedCount;
}
    

    // ═══════════════════════════════════════════════════════════════════════
    //  AD VIEW GENERATION
    // ═══════════════════════════════════════════════════════════════════════

    async generateAdView(userId, networkType = 'primary') {
        const recentGens = this._getRecentAdGenerations(userId, 60000);
        if (recentGens > 5) {
            return {
                success: false,
                error: 'RATE_LIMITED',
                message: 'Too many ad requests. Please slow down.'
            };
        }

        const result = await this.createVerification(userId, networkType);
        this._recordAdGeneration(userId);

        return {
            success: true,
            ...result
        };
    }

    _buildAdUrl(verificationId, userId) {
        const baseUrl = config.baseUrl || process.env.BASE_URL || 'https://yourbot.com';
        return `${baseUrl}/webhooks/ad/redirect?vid=${verificationId}&uid=${userId}`;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  RECORD AD START — Now MongoDB-backed
    // ═══════════════════════════════════════════════════════════════════════

    async recordAdStart(verificationId, requestingUserId) {
        const verification = await this.getVerification(verificationId);

        if (!verification) {
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        if (verification.userId !== String(requestingUserId)) {
            logger.warn('Ad start ownership mismatch', {
                expected: verification.userId,
                got: requestingUserId
            });
            return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }

        if (verification.status === 'COMPLETED') {
            return { success: false, error: 'ALREADY_COMPLETED' };
        }

        const updated = await this.updateVerification(verificationId, {
            startTime: new Date(),
            status: 'STARTED'
        });

        logger.info('Ad watch started', {
            userId: verification.userId,
            verificationId,
            startedAt: updated.startTime
        });

        return {
            success: true,
            startedAt: updated.startTime,
            minWatchTime: this.MIN_WATCH_TIME,
            canClaimAt: new Date(Date.now() + this.MIN_WATCH_TIME)
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CLAIM CREDITS — MongoDB-backed
    // ═══════════════════════════════════════════════════════════════════════

    async claimCredits(verificationId, requestingUserId, userMetadata = {}) {
        const verification = await this.getVerification(verificationId);

        if (!verification) {
            return {
                success: false,
                error: 'VERIFICATION_NOT_FOUND',
                message: 'Ad session expired. Please watch a new ad.'
            };
        }

        if (verification.userId !== String(requestingUserId)) {
            return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }

        if (verification.status === 'COMPLETED') {
            return {
                success: false,
                error: 'ALREADY_COMPLETED',
                message: 'Credits already claimed for this ad.'
            };
        }

        if (!verification.startTime) {
            return {
                success: false,
                error: 'WATCH_NOT_STARTED',
                message: 'Please open the ad first.',
                minWatchTime: Math.floor(this.MIN_WATCH_TIME / 1000)
            };
        }

        const elapsed = Date.now() - new Date(verification.startTime).getTime();
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

        const lastClaim = this._getLastClaimTime(requestingUserId);
        if (lastClaim && (Date.now() - lastClaim) < this.CLAIM_COOLDOWN) {
            const waitSec = Math.ceil((this.CLAIM_COOLDOWN - (Date.now() - lastClaim)) / 1000);
            return {
                success: false,
                error: 'CLAIM_COOLDOWN',
                message: `Please wait ${waitSec} seconds before your next ad.`,
                waitSeconds: waitSec
            };
        }

        const recentClaims = this._getRecentClaimsCount(requestingUserId, 3600000);
        if (recentClaims >= this.MAX_CLAIMS_PER_HOUR) {
            return {
                success: false,
                error: 'HOURLY_LIMIT_REACHED',
                message: `Ad limit reached: ${this.MAX_CLAIMS_PER_HOUR} per hour. Try again later.`,
                limit: this.MAX_CLAIMS_PER_HOUR
            };
        }

        return this._awardCredits(verification, requestingUserId, {
            elapsed,
            userMetadata,
            claimedAt: Date.now()
        });
    }

    async _awardCredits(verification, requestingUserId, metadata = {}) {
        try {
            // Atomic credit increment
            const userAfter = await User.findOneAndUpdate(
                { userId: requestingUserId },
                { $inc: { adCredits: verification.credits } },
                { new: true }
            );

            if (!userAfter) {
                throw new Error('User not found during award');
            }

            // Persist to AdView collection
            await AdView.create({
                viewId: verification.verificationId,
                userId: requestingUserId,
                network: verification.urlType,
                creditsEarned: verification.credits,
                status: 'COMPLETED',
                completedAt: new Date(),
                watchDuration: metadata.elapsed || 0,
                metadata: {
                    ...metadata,
                    source: metadata.source || 'time_based_claim'
                }
            });

            // Update verification status
            await this.updateVerification(verification.verificationId, {
                status: 'COMPLETED',
                claimedAt: new Date(),
                watchDuration: metadata.elapsed || 0
            });

            this._recordClaim(requestingUserId);

            await this._logTransaction({
                userId: requestingUserId,
                type: 'AD_AWARD',
                amount: verification.credits,
                reason: metadata.source || 'claim',
                metadata: { verificationId: verification.verificationId, network: verification.urlType }
            });

            logger.info('Ad credit awarded', {
                userId: requestingUserId,
                verificationId: verification.verificationId,
                credits: verification.credits,
                watchDuration: metadata.elapsed
            });

            return {
                success: true,
                creditsAdded: verification.credits,
                totalCredits: userAfter.adCredits,
                watchDuration: metadata.elapsed
            };

        } catch (error) {
            logger.error('Failed to award ad credits', {
                verificationId: verification.verificationId,
                userId: requestingUserId,
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
    //  POSTBACK HANDLER
    // ═══════════════════════════════════════════════════════════════════════

    async handlePostback(network, query = {}) {
        const { verify, subId, status } = query;
        const verificationId = verify || subId;

        if (!verificationId) {
            return { success: false, error: 'MISSING_VERIFICATION_ID' };
        }

        if (status !== 'completed' && status !== 'approved') {
            return { success: false, error: 'STATUS_NOT_COMPLETED' };
        }

        const verification = await this.getVerification(verificationId);
        if (!verification) {
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        if (verification.status === 'COMPLETED') {
            return { success: false, error: 'ALREADY_COMPLETED' };
        }

        return this._awardCredits(verification, verification.userId, { source: 'postback' });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CREDIT INQUIRY & TRANSACTIONS (unchanged from v2)
    // ═══════════════════════════════════════════════════════════════════════

    async getCredits(userId) {
        const now = new Date();
        const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

        const user = await User.findOne({ userId: String(userId) }).lean();
        if (!user) {
            return { credits: 0, dailyUsed: 0, dailyLimit: this.COSTS.DAILY_FREE_LIMIT, holds: 0, effectiveAvailable: this.COSTS.DAILY_FREE_LIMIT };
        }

        const lastReset = user.adCreditReset ? new Date(user.adCreditReset).getTime() : 0;
        const shouldReset = lastReset < todayUTC;

        if (shouldReset) {
            await User.updateOne(
                { userId: String(userId) },
                { $set: { adCredits: 0, adCreditReset: now, freeUsedToday: 0 } }
            );
            return { credits: 0, dailyUsed: 0, dailyLimit: this.COSTS.DAILY_FREE_LIMIT, holds: 0, effectiveAvailable: this.COSTS.DAILY_FREE_LIMIT };
        }

        const freeRemaining = Math.max(0, this.COSTS.DAILY_FREE_LIMIT - (user.freeUsedToday || 0));
        const creditBalance = user.adCredits || 0;
        const activeHoldCount = await this._countActiveHolds(userId);

        return {
            credits: creditBalance,
            dailyUsed: user.freeUsedToday || 0,
            dailyLimit: this.COSTS.DAILY_FREE_LIMIT,
            holds: activeHoldCount,
            effectiveAvailable: freeRemaining + Math.max(0, creditBalance - (activeHoldCount * this.COSTS.NUMBER_REQUEST))
        };
    }

    async canRequestNumber(userId) {
        const credits = await this.getCredits(userId);

        if (credits.holds >= this.MAX_HOLDS_PER_USER) {
            return { allowed: false, reason: 'TOO_MANY_HOLDS', message: `You have ${credits.holds} pending requests.`, credits: credits.credits, required: this.COSTS.NUMBER_REQUEST };
        }

        if (credits.dailyUsed < credits.dailyLimit) {
            return { allowed: true, reason: 'DAILY_FREE', credits: credits.credits, required: 0, remainingAfter: credits.credits, freeRemaining: credits.dailyLimit - credits.dailyUsed - 1, usingCredits: false };
        }

        const requiredWithHolds = this.COSTS.NUMBER_REQUEST * (credits.holds + 1);
        if (credits.credits >= requiredWithHolds) {
            return { allowed: true, reason: 'CREDITS_SUFFICIENT', credits: credits.credits, required: this.COSTS.NUMBER_REQUEST, remainingAfter: credits.credits - requiredWithHolds, freeRemaining: 0, usingCredits: true };
        }

        return { allowed: false, reason: 'INSUFFICIENT_CREDITS', message: `Need ${this.COSTS.NUMBER_REQUEST} credits. You have ${credits.credits}.`, credits: credits.credits, required: this.COSTS.NUMBER_REQUEST, shortfall: requiredWithHolds - credits.credits, freeRemaining: 0 };
    }

    async holdCredits(userId) {
        const check = await this.canRequestNumber(userId);
        if (!check.allowed) {
            const error = new Error(check.reason);
            error.code = check.reason;
            error.creditInfo = check;
            throw error;
        }

        const holdId = `hold_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const isFree = !check.usingCredits;
        const cost = isFree ? 0 : this.COSTS.NUMBER_REQUEST;

        if (!isFree) {
            const result = await User.findOneAndUpdate(
                { userId: String(userId), adCredits: { $gte: cost } },
                { $inc: { adCredits: -cost } },
                { new: true }
            );
            if (!result) throw new Error('CREDIT_RACE_CONDITION');
        }

        const holdData = { holdId, userId: String(userId), cost, isFree, createdAt: Date.now(), expiresAt: Date.now() + this.HOLD_EXPIRY_MS, status: 'HELD', committed: false, released: false };
        this.activeHolds.set(holdId, holdData);
        this._trackUserHold(userId, holdId);

        await this._logTransaction({ userId: String(userId), type: 'HOLD', amount: -cost, holdId, balanceAfter: isFree ? check.credits : check.credits - cost, reason: isFree ? 'FREE_NUMBER_HOLD' : 'CREDIT_NUMBER_HOLD' });

        return holdId;
    }

    async releaseHold(holdId) {
        const hold = this.activeHolds.get(holdId);
        if (!hold) return { success: false, error: 'HOLD_NOT_FOUND' };
        if (hold.released || hold.committed) return { success: false, error: 'HOLD_ALREADY_FINALIZED' };

        if (!hold.isFree && hold.cost > 0) {
            await User.updateOne({ userId: hold.userId }, { $inc: { adCredits: hold.cost } });
        }
        if (hold.isFree) {
            await User.updateOne({ userId: hold.userId }, { $inc: { freeUsedToday: -1 } });
        }

        hold.status = 'RELEASED'; hold.released = true; hold.releasedAt = Date.now();
        this.activeHolds.set(holdId, hold);

        await this._logTransaction({ userId: hold.userId, type: 'RELEASE', amount: hold.cost, holdId, reason: hold.isFree ? 'FREE_NUMBER_RELEASED' : 'CREDIT_NUMBER_RELEASED' });
        return { success: true, refunded: hold.cost, isFree: hold.isFree };
    }

    async commitHold(holdId) {
        const hold = this.activeHolds.get(holdId);
        if (!hold) return { success: false, error: 'HOLD_NOT_FOUND' };
        if (hold.released || hold.committed) return { success: false, error: 'HOLD_ALREADY_FINALIZED' };

        if (hold.isFree) {
            await User.updateOne({ userId: hold.userId }, { $inc: { freeUsedToday: 1 } });
        }

        hold.status = 'COMMITTED'; hold.committed = true; hold.committedAt = Date.now();
        this.activeHolds.set(holdId, hold);

        await this._logTransaction({ userId: hold.userId, type: 'COMMIT', amount: -hold.cost, holdId, reason: hold.isFree ? 'FREE_NUMBER_ASSIGNED' : 'CREDIT_NUMBER_ASSIGNED' });
        return { success: true, cost: hold.cost, isFree: hold.isFree };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    async _logTransaction({ userId, type, amount, holdId = null, balanceAfter = null, reason, metadata = {} }) {
        try {
            await CreditTransaction.create({ userId: String(userId), type, amount, holdId, balanceAfter, reason, metadata: { ...metadata, timestamp: new Date() } });
        } catch (error) {
            logger.error('Credit transaction log failed', { userId, type, error: error.message });
        }
    }

    async _countActiveHolds(userId) {
        const holdIds = this.userHoldHistory.get(userId);
        if (!holdIds) return 0;
        let count = 0;
        for (const holdId of holdIds) {
            const hold = this.activeHolds.get(holdId);
            if (hold && !hold.released && !hold.committed && hold.expiresAt > Date.now()) count++;
        }
        return count;
    }

    _trackUserHold(userId, holdId) {
        if (!this.userHoldHistory.has(userId)) this.userHoldHistory.set(userId, new Set());
        this.userHoldHistory.get(userId).add(holdId);
    }

    _cleanupExpiredHolds() {
        const now = Date.now();
        let cleaned = 0;
        for (const [holdId, hold] of this.activeHolds) {
            if (hold.expiresAt < now && !hold.released && !hold.committed) {
                this.releaseHold(holdId).catch(() => {});
                cleaned++;
            }
        }
        return cleaned;
    }

    _recordClaim(userId) {
        if (!this.userClaimHistory.has(userId)) this.userClaimHistory.set(userId, []);
        const history = this.userClaimHistory.get(userId);
        history.push(Date.now());
        if (history.length > this.MAX_CLAIM_HISTORY_PER_USER) history.shift();
    }

    _getLastClaimTime(userId) {
        const history = this.userClaimHistory.get(userId);
        return history?.length > 0 ? history[history.length - 1] : null;
    }

    _getRecentClaimsCount(userId, windowMs) {
        const history = this.userClaimHistory.get(userId);
        return history ? history.filter(t => t > Date.now() - windowMs).length : 0;
    }

    _recordAdGeneration(userId) {
        if (!this.userClaimHistory.has(userId)) this.userClaimHistory.set(userId, []);
        this.userClaimHistory.get(userId).push(-Date.now());
    }

    _getRecentAdGenerations(userId, windowMs) {
        const history = this.userClaimHistory.get(userId);
        return history ? history.filter(t => t < 0 && Math.abs(t) > Date.now() - windowMs).length : 0;
    }

    _startCleanupInterval() {
        setInterval(() => {
            const holdsCleaned = this._cleanupExpiredHolds();
            if (holdsCleaned > 0) logger.debug('Cleanup completed', { holdsCleaned });
        }, 300000);
    }

    getAvailableNetworks() {
        return [
            { id: 'primary', name: 'Watch Ad', creditValue: 2, configured: !!this.PRIMARY_URL, minWatchTime: Math.floor(this.MIN_WATCH_TIME / 1000) },
            { id: 'fallback', name: 'Watch Ad (Alt)', creditValue: 2, configured: !!this.FALLBACK_URL, minWatchTime: Math.floor(this.MIN_WATCH_TIME / 1000) }
        ].filter(n => n.configured);
    }

    _maskUrl(url) {
        if (!url) return 'none';
        try { const u = new URL(url); return `${u.protocol}//${u.hostname}/...`; } catch { return 'invalid'; }
    }
}

export default AdCreditSystem;
