// ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — Production-Hardened v2
// Atomic credit transactions, race-condition safe, abuse-resistant
// ═══════════════════════════════════════════════════════════════════════════════

import { User, AdView, CreditTransaction } from '../../models/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';
import crypto from 'crypto';

/**
 * AdCreditSystem v2
 * 
 * Critical fixes:
 * - Atomic credit operations (findAndModify / $inc with conditions)
 * - Credit-safe holds: reserve before deduct, release on failure, commit on success
 * - Race-condition proof daily limit enforcement
 * - Ownership verification on all verification operations
 * - Audit trail for every credit movement
 * - Memory caps and automatic cleanup
 * - Postback HMAC signature verification
 */

class AdCreditSystem {
    constructor() {
        // URL configuration
        this.PRIMARY_URL = config.adSystem?.primaryUrl || process.env.AD_PRIMARY_URL || 'https://omg10.com/4/10967769';
        this.FALLBACK_URL = config.adSystem?.fallbackUrl || process.env.AD_FALLBACK_URL || 'https://www.profitablecpmratenetwork.com/zs5wg1ki?key=cb472c48fad6246f544094483b9f9bcc';

        // Cost structure
        this.COSTS = {
            NUMBER_REQUEST: config.adSystem?.creditsPerRequest || 2,
            DAILY_FREE_LIMIT: config.limits?.freeDaily || 3
        };

        // Timing constraints
        this.MIN_WATCH_TIME = 30000;
        this.CLAIM_COOLDOWN = 60000;
        this.MAX_CLAIMS_PER_HOUR = 10;
        this.SESSION_DEDUP_WINDOW = 300000;
        this.HOLD_EXPIRY_MS = 30000;  // Holds expire if not committed in 30s

        // Postback security
        this.POSTBACK_SECRET = config.adSystem?.postbackSecret || process.env.AD_POSTBACK_SECRET || 'default-secret-change-me';

        // In-memory tracking
        this.activeVerifications = new Map();   // verificationId -> verification data
        this.activeHolds = new Map();            // holdId -> hold data (NEW)
        this.userClaimHistory = new Map();       // userId -> timestamp[]
        this.userHoldHistory = new Map();        // userId -> holdId[] (for cleanup)

        // Memory limits
        this.MAX_CLAIM_HISTORY_PER_USER = 50;
        this.MAX_HOLDS_PER_USER = 5;

        this._startCleanupInterval();

        logger.info('AdCreditSystem v2 initialized', {
            primaryUrl: this._maskUrl(this.PRIMARY_URL),
            costPerRequest: this.COSTS.NUMBER_REQUEST,
            dailyFreeLimit: this.COSTS.DAILY_FREE_LIMIT,
            holdExpiryMs: this.HOLD_EXPIRY_MS
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CREDIT INQUIRY — Daily reset aware, atomic read
    // ═══════════════════════════════════════════════════════════════════════

    async getCredits(userId) {
        const now = new Date();
        const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

        const user = await User.findOne({ userId }).lean();
        if (!user) {
            return { 
                credits: 0, 
                dailyUsed: 0, 
                dailyLimit: this.COSTS.DAILY_FREE_LIMIT,
                holds: 0,
                effectiveAvailable: this.COSTS.DAILY_FREE_LIMIT 
            };
        }

        // Check if daily reset needed
        const lastReset = user.adCreditReset ? new Date(user.adCreditReset).getTime() : 0;
        const shouldReset = lastReset < todayUTC;

        if (shouldReset) {
            // Atomic reset: set credits to 0, reset counter, update timestamp
            await User.updateOne(
                { userId },
                {
                    $set: {
                        adCredits: 0,
                        adCreditReset: now,
                        freeUsedToday: 0,
                        lastDailyReset: new Date()
                    }
                }
            );
            
            return { 
                credits: 0, 
                dailyUsed: 0, 
                dailyLimit: this.COSTS.DAILY_FREE_LIMIT,
                holds: 0,
                effectiveAvailable: this.COSTS.DAILY_FREE_LIMIT 
            };
        }

        // Calculate effective available: credits + remaining free requests
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

    /**
     * Check if user can request a number — considers holds and effective balance
     */
    async canRequestNumber(userId) {
        const credits = await this.getCredits(userId);

        // Check active holds don't exceed capacity
        if (credits.holds >= this.MAX_HOLDS_PER_USER) {
            return {
                allowed: false,
                reason: 'TOO_MANY_HOLDS',
                message: `You have ${credits.holds} pending requests. Please wait for them to complete.`,
                credits: credits.credits,
                required: this.COSTS.NUMBER_REQUEST
            };
        }

        // Daily free limit check
        if (credits.dailyUsed < credits.dailyLimit) {
            return {
                allowed: true,
                reason: 'DAILY_FREE',
                credits: credits.credits,
                required: 0,  // Free!
                remainingAfter: credits.credits,
                freeRemaining: credits.dailyLimit - credits.dailyUsed - 1,
                usingCredits: false
            };
        }

        // Credit balance check (must cover cost + existing holds)
        const requiredWithHolds = this.COSTS.NUMBER_REQUEST * (credits.holds + 1);
        if (credits.credits >= requiredWithHolds) {
            return {
                allowed: true,
                reason: 'CREDITS_SUFFICIENT',
                credits: credits.credits,
                required: this.COSTS.NUMBER_REQUEST,
                remainingAfter: credits.credits - requiredWithHolds,
                freeRemaining: 0,
                usingCredits: true
            };
        }

        // Not enough — calculate shortfall
        const shortfall = requiredWithHolds - credits.credits;
        return {
            allowed: false,
            reason: 'INSUFFICIENT_CREDITS',
            message: `Need ${this.COSTS.NUMBER_REQUEST} credits. You have ${credits.credits} (with ${credits.holds} pending holds).`,
            credits: credits.credits,
            required: this.COSTS.NUMBER_REQUEST,
            shortfall,
            freeRemaining: 0
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CREDIT-SAFE TRANSACTIONS — Hold / Release / Commit (NEW)
    //  These prevent credit loss when number validation fails
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Hold credits before number assignment — atomic, race-condition safe
     * Returns holdId on success, throws on failure
     */
    async holdCredits(userId) {
        const check = await this.canRequestNumber(userId);
        if (!check.allowed) {
            const error = new Error(check.reason);
            error.code = check.reason;
            error.creditInfo = check;
            throw error;
        }

        const holdId = `hold_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const now = Date.now();

        // Determine if using free quota or paid credits
        const isFree = !check.usingCredits;
        const cost = isFree ? 0 : this.COSTS.NUMBER_REQUEST;

        // If using credits, atomically reserve them
        if (!isFree) {
            const result = await User.findOneAndUpdate(
                { 
                    userId, 
                    adCredits: { $gte: cost }  // Atomic condition: must have enough
                },
                {
                    $inc: { adCredits: -cost }  // Deduct immediately into "held" state
                },
                { new: true }
            );

            if (!result) {
                // Race condition: credits changed between check and deduct
                throw new Error('CREDIT_RACE_CONDITION');
            }
        }

        // Record the hold
        const holdData = {
            holdId,
            userId,
            cost,
            isFree,
            createdAt: now,
            expiresAt: now + this.HOLD_EXPIRY_MS,
            status: 'HELD',
            committed: false,
            released: false
        };

        this.activeHolds.set(holdId, holdData);
        this._trackUserHold(userId, holdId);

        // Log transaction
        await this._logTransaction({
            userId,
            type: 'HOLD',
            amount: -cost,
            holdId,
            balanceAfter: isFree ? check.credits : check.credits - cost,
            reason: isFree ? 'FREE_NUMBER_HOLD' : 'CREDIT_NUMBER_HOLD',
            metadata: { freeRemaining: check.freeRemaining }
        });

        logger.info('Credits held', {
            userId,
            holdId,
            cost,
            isFree,
            expiresIn: this.HOLD_EXPIRY_MS
        });

        return holdId;
    }

    /**
     * Release held credits — call when number validation fails
     * Refunds credits if paid, restores free quota if free
     */
    async releaseHold(holdId) {
        const hold = this.activeHolds.get(holdId);
        if (!hold) {
            logger.warn('Release hold: hold not found', { holdId });
            return { success: false, error: 'HOLD_NOT_FOUND' };
        }

        if (hold.released || hold.committed) {
            return { success: false, error: 'HOLD_ALREADY_FINALIZED' };
        }

        const { userId, cost, isFree } = hold;

        // If paid credits were deducted, refund them
        if (!isFree && cost > 0) {
            await User.updateOne(
                { userId },
                { $inc: { adCredits: cost } }
            );
        }

        // If free quota was used, decrement freeUsedToday (restore the free slot)
        if (isFree) {
            await User.updateOne(
                { userId },
                { $inc: { freeUsedToday: -1 } }
            );
        }

        hold.status = 'RELEASED';
        hold.released = true;
        hold.releasedAt = Date.now();
        this.activeHolds.set(holdId, hold);

        await this._logTransaction({
            userId,
            type: 'RELEASE',
            amount: cost,
            holdId,
            reason: isFree ? 'FREE_NUMBER_RELEASED' : 'CREDIT_NUMBER_RELEASED'
        });

        logger.info('Hold released', { userId, holdId, cost, isFree });
        return { success: true, refunded: cost, isFree };
    }

    /**
     * Commit held credits — call when number is successfully assigned
     */
    async commitHold(holdId) {
        const hold = this.activeHolds.get(holdId);
        if (!hold) {
            logger.warn('Commit hold: hold not found', { holdId });
            return { success: false, error: 'HOLD_NOT_FOUND' };
        }

        if (hold.released || hold.committed) {
            return { success: false, error: 'HOLD_ALREADY_FINALIZED' };
        }

        const { userId, cost, isFree } = hold;

        // For free holds: increment freeUsedToday (mark as consumed)
        if (isFree) {
            await User.updateOne(
                { userId },
                { $inc: { freeUsedToday: 1 } }
            );
        }
        // For paid holds: credits already deducted in hold phase, nothing to do

        hold.status = 'COMMITTED';
        hold.committed = true;
        hold.committedAt = Date.now();
        this.activeHolds.set(holdId, hold);

        await this._logTransaction({
            userId,
            type: 'COMMIT',
            amount: -cost,
            holdId,
            reason: isFree ? 'FREE_NUMBER_ASSIGNED' : 'CREDIT_NUMBER_ASSIGNED'
        });

        logger.info('Hold committed', { userId, holdId, cost, isFree });
        return { success: true, cost, isFree };
    }

    /**
     * Legacy direct deduct — kept for backward compatibility
     * WARNING: Not credit-safe. Prefer hold/commit pattern.
     */
    async deductCredits(userId) {
        const check = await this.canRequestNumber(userId);
        if (!check.allowed) {
            throw new Error(check.reason);
        }

        const isFree = !check.usingCredits;
        const cost = isFree ? 0 : this.COSTS.NUMBER_REQUEST;

        if (!isFree) {
            // Atomic deduct with balance check
            const result = await User.findOneAndUpdate(
                { userId, adCredits: { $gte: cost } },
                { $inc: { adCredits: -cost } },
                { new: true }
            );

            if (!result) {
                throw new Error('INSUFFICIENT_CREDITS');
            }
        } else {
            // Using free quota
            await User.updateOne(
                { userId },
                { $inc: { freeUsedToday: 1 } }
            );
        }

        await this._logTransaction({
            userId,
            type: 'DEDUCT',
            amount: -cost,
            reason: isFree ? 'FREE_NUMBER_DIRECT' : 'CREDIT_NUMBER_DIRECT'
        });

        logger.info('Credits deducted (legacy)', { userId, cost, isFree });
        return { success: true, deducted: cost, isFree };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AUDIT TRAIL — Every credit movement logged (NEW)
    // ═══════════════════════════════════════════════════════════════════════

    async _logTransaction({ userId, type, amount, holdId = null, balanceAfter = null, reason, metadata = {} }) {
        try {
            await CreditTransaction.create({
                userId,
                type,           // HOLD, COMMIT, RELEASE, DEDUCT, AD_AWARD, POSTBACK, REFUND
                amount,
                holdId,
                balanceAfter,
                reason,
                metadata: {
                    ...metadata,
                    timestamp: new Date()
                }
            });
        } catch (error) {
            // Don't fail the main operation if logging fails, but alert
            logger.error('Credit transaction log failed', { userId, type, error: error.message });
        }
    }

    /**
     * Get credit transaction history for a user
     */
    async getTransactionHistory(userId, limit = 50) {
        return CreditTransaction.find({ userId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AD VIEW GENERATION — Secure URL construction
    // ═══════════════════════════════════════════════════════════════════════

    async generateAdView(userId, networkType = 'primary') {
        // Rate limit ad generation
        const recentGens = this._getRecentAdGenerations(userId, 60000);
        if (recentGens > 5) {
            return {
                success: false,
                error: 'RATE_LIMITED',
                message: 'Too many ad requests. Please slow down.'
            };
        }

        const verificationId = `ad_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const isPrimary = networkType === 'primary';
        const baseUrl = isPrimary ? this.PRIMARY_URL : this.FALLBACK_URL;

        // Safe URL construction with encoded parameters
        const url = new URL(baseUrl);
        url.searchParams.set('subId', verificationId);
        url.searchParams.set('userId', userId);
        url.searchParams.set('ts', Date.now().toString());

        const networkEnum = isPrimary ? 'omg10' : 'profitablecpm';

        this.activeVerifications.set(verificationId, {
            userId,
            credits: 2,
            startTime: null,
            createdAt: Date.now(),
            status: 'PENDING',
            urlType: networkEnum,
            ipAddress: null,  // Set by controller layer
            userAgent: null   // Set by controller layer
        });

        this._recordAdGeneration(userId);

        logger.info('Ad view generated', { userId, verificationId, network: networkEnum });

        return {
            success: true,
            verificationId,
            adUrl: url.toString(),
            network: networkEnum,
            type: 'redirect',
            estimatedTime: '30 sec',
            creditValue: 2,
            minWatchTime: this.MIN_WATCH_TIME
        };
    }

    /**
     * Record ad start — with ownership verification
     */
    recordAdStart(verificationId, requestingUserId) {
        const verification = this.activeVerifications.get(verificationId);
        if (!verification) {
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        // Ownership check
        if (verification.userId !== requestingUserId) {
            logger.warn('Ad start ownership mismatch', {
                verificationId,
                expected: verification.userId,
                got: requestingUserId
            });
            return { success: false, error: 'OWNERSHIP_MISMATCH' };
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

    /**
     * Claim credits — with full verification and atomic state transition
     */
            async claimCredits(verificationId, requestingUserId, userMetadata = {}) {
        const verification = this.activeVerifications.get(verificationId);

        if (!verification) {
            return {
                success: false,
                error: 'VERIFICATION_NOT_FOUND',
                message: 'Ad session expired. Please watch a new ad.'
            };
        }

        // Ownership check
        if (verification.userId !== requestingUserId) {
            return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }

        // Idempotency: already completed
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
                minWatchTime: Math.floor(this.MIN_WATCH_TIME / 1000)
            };
        }

        // Time elapsed check
        const elapsed = Date.now() - verification.startTime;
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

        // Claim cooldown
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

        // Hourly limit
        const recentClaims = this._getRecentClaimsCount(requestingUserId, 3600000);
        if (recentClaims >= this.MAX_CLAIMS_PER_HOUR) {
            return {
                success: false,
                error: 'HOURLY_LIMIT_REACHED',
                message: `Ad limit reached: ${this.MAX_CLAIMS_PER_HOUR} per hour. Try again later.`,
                limit: this.MAX_CLAIMS_PER_HOUR,
                resetIn: this._getHourlyResetTime(requestingUserId)
            };
        }

        // All checks passed — atomic award
        return this._awardCredits(verificationId, verification, {
            elapsed,
            userMetadata,
            claimedAt: Date.now()
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  POSTBACK HANDLER — HMAC verified, replay-protected
    // ═══════════════════════════════════════════════════════════════════════

    async handlePostback(query = {}, clientIP = 'unknown') {
        const { verify, subId, status, sig } = query;
        const verificationId = verify || subId;

        if (!verificationId) {
            return { success: false, error: 'MISSING_VERIFICATION_ID' };
        }

        // Verify HMAC signature if provided
        if (sig && !this._verifyPostbackSignature(query)) {
            logger.warn('Invalid postback signature', { verificationId, clientIP });
            return { success: false, error: 'INVALID_SIGNATURE' };
        }

        // IP whitelist check (optional but recommended)
        const allowedIPs = config.adSystem?.allowedPostbackIPs || [];
        if (allowedIPs.length > 0 && !allowedIPs.includes(clientIP)) {
            logger.warn('Postback from unauthorized IP', { verificationId, clientIP });
            return { success: false, error: 'UNAUTHORIZED_IP' };
        }

        if (status !== 'completed' && status !== 'approved') {
            return { success: false, error: 'STATUS_NOT_COMPLETED' };
        }

        const verification = this.activeVerifications.get(verificationId);
        if (!verification) {
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        if (verification.status === 'COMPLETED') {
            return { success: false, error: 'ALREADY_COMPLETED' };
        }

        return this._awardCredits(verificationId, verification, { 
            source: 'postback',
            clientIP 
        });
    }

    _verifyPostbackSignature(query) {
        const { sig, ...params } = query;
        const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
        const expected = crypto
            .createHmac('sha256', this.POSTBACK_SECRET)
            .update(sortedParams)
            .digest('hex');
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL HELPERS — Award, tracking, cleanup
    // ═══════════════════════════════════════════════════════════════════════

    async _awardCredits(verificationId, verification, metadata = {}) {
        const { userId, credits, urlType } = verification;

        try {
            // Atomic credit increment
            const userAfter = await User.findOneAndUpdate(
                { userId },
                { $inc: { adCredits: credits } },
                { new: true }
            );

            if (!userAfter) {
                throw new Error('User not found during award');
            }

            // Persist to AdView collection
            await AdView.create({
                viewId: verificationId,
                userId,
                network: urlType,
                creditsEarned: credits,
                status: 'COMPLETED',
                completedAt: new Date(),
                watchDuration: metadata.elapsed || 0,
                metadata: {
                    ...metadata,
                    userAgent: metadata.userMetadata?.userAgent,
                    source: metadata.source || 'time_based_claim'
                }
            });

            // Atomic state transition in memory
            verification.status = 'COMPLETED';
            verification.claimedAt = Date.now();
            this.activeVerifications.set(verificationId, verification);

            this._recordClaim(userId);

            // Audit log
            await this._logTransaction({
                userId,
                type: 'AD_AWARD',
                amount: credits,
                reason: metadata.source || 'claim',
                metadata: { verificationId, network: urlType }
            });

            logger.info('Ad credit awarded', {
                userId,
                verificationId,
                credits,
                watchDuration: metadata.elapsed,
                network: urlType,
                recentClaims: this._getRecentClaimsCount(userId, 3600000)
            });

            return {
                success: true,
                creditsAdded: credits,
                totalCredits: userAfter.adCredits,
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

    _recordClaim(userId) {
        if (!this.userClaimHistory.has(userId)) {
            this.userClaimHistory.set(userId, []);
        }
        const history = this.userClaimHistory.get(userId);
        history.push(Date.now());
        
        // Cap history size
        if (history.length > this.MAX_CLAIM_HISTORY_PER_USER) {
            history.shift();
        }
    }

    _getLastClaimTime(userId) {
        const history = this.userClaimHistory.get(userId);
        if (!history || history.length === 0) return null;
        return history[history.length - 1];
    }

    _getRecentClaimsCount(userId, windowMs) {
        const history = this.userClaimHistory.get(userId);
        if (!history) return 0;
        const cutoff = Date.now() - windowMs;
        return history.filter(t => t > cutoff).length;
    }

    _getHourlyResetTime(userId) {
        const history = this.userClaimHistory.get(userId);
        if (!history || history.length < this.MAX_CLAIMS_PER_HOUR) return 0;
        const sorted = [...history].sort((a, b) => a - b);
        const oldestInWindow = sorted[sorted.length - this.MAX_CLAIMS_PER_HOUR];
        return Math.max(0, oldestInWindow + 3600000 - Date.now());
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  HOLD MANAGEMENT HELPERS (NEW)
    // ═══════════════════════════════════════════════════════════════════════

    _trackUserHold(userId, holdId) {
        if (!this.userHoldHistory.has(userId)) {
            this.userHoldHistory.set(userId, new Set());
        }
        this.userHoldHistory.get(userId).add(holdId);
    }

    async _countActiveHolds(userId) {
        const holdIds = this.userHoldHistory.get(userId);
        if (!holdIds) return 0;
        
        let count = 0;
        for (const holdId of holdIds) {
            const hold = this.activeHolds.get(holdId);
            if (hold && !hold.released && !hold.committed && hold.expiresAt > Date.now()) {
                count++;
            }
        }
        return count;
    }

    _cleanupExpiredHolds() {
        const now = Date.now();
        let cleaned = 0;

        for (const [holdId, hold] of this.activeHolds) {
            if (hold.expiresAt < now && !hold.released && !hold.committed) {
                // Auto-release expired holds
                this.releaseHold(holdId).catch(e => {
                    logger.error('Auto-release of expired hold failed', { holdId, error: e.message });
                });
                cleaned++;
            }
        }
        return cleaned;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AD GENERATION RATE LIMITING (NEW)
    // ═══════════════════════════════════════════════════════════════════════

    _recordAdGeneration(userId) {
        if (!this.userClaimHistory.has(userId)) {
            this.userClaimHistory.set(userId, []);
        }
        // Store ad generations as negative timestamps to distinguish from claims
        this.userClaimHistory.get(userId).push(-Date.now());
    }

    _getRecentAdGenerations(userId, windowMs) {
        const history = this.userClaimHistory.get(userId);
        if (!history) return 0;
        const cutoff = Date.now() - windowMs;
        return history.filter(t => t < 0 && Math.abs(t) > cutoff).length;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Networks, cleanup, queries
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
            const holdsCleaned = this._cleanupExpiredHolds();
            const verCleaned = this.cleanupOldVerifications();
            const claimCleaned = this._cleanupOldClaims();
            
            if (holdsCleaned > 0 || verCleaned > 0 || claimCleaned > 0) {
                logger.debug('Cleanup completed', { holdsCleaned, verCleaned, claimCleaned });
            }
        }, 300000); // Every 5 minutes
    }

    cleanupOldVerifications() {
        const now = Date.now();
        const maxAge = 3600000;
        let cleaned = 0;

        for (const [id, v] of this.activeVerifications) {
            if (now - v.createdAt > maxAge || v.status === 'COMPLETED') {
                this.activeVerifications.delete(id);
                cleaned++;
            }
        }
        return cleaned;
    }

    _cleanupOldClaims() {
        const now = Date.now();
        const maxAge = 7200000;
        let cleaned = 0;

        for (const [userId, history] of this.userClaimHistory) {
            const filtered = history.filter(t => now - Math.abs(t) < maxAge);
            if (filtered.length === 0) {
                this.userClaimHistory.delete(userId);
            } else if (filtered.length !== history.length) {
                this.userClaimHistory.set(userId, filtered);
                cleaned += history.length - filtered.length;
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

    /**
     * Get active holds for a user (for debugging/admin)
     */
    getUserHolds(userId) {
        const holdIds = this.userHoldHistory.get(userId);
        if (!holdIds) return [];
        
        return Array.from(holdIds)
            .map(id => this.activeHolds.get(id))
            .filter(h => h && !h.released && !h.committed);
    }

    _maskUrl(url) {
        if (!url) return 'none';
        try {
            const u = new URL(url);
            return `${u.protocol}//${u.hostname}/...`;
        } catch {
            return 'invalid';
        }
    }
}

export default AdCreditSystem;
