// ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — Server-side anti-abuse with correct enum values
// ═══════════════════════════════════════════════════════════════════════════════

import { User, AdView } from '../../models/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class AdCreditSystem {
    constructor() {
        // FIXED: Validate URLs on init — reject known dead endpoints
        this.PRIMARY_URL = this._validateAdUrl(
            config.adSystem?.primaryUrl || process.env.AD_PRIMARY_URL,
            null
        );
        this.FALLBACK_URL = this._validateAdUrl(
            config.adSystem?.fallbackUrl || process.env.AD_FALLBACK_URL,
            null
        );

        this.COSTS = {
            NUMBER_REQUEST: config.adSystem?.creditsPerRequest || 2,
            DAILY_FREE_LIMIT: config.limits?.freeDaily || 3
        };

        this.MIN_WATCH_TIME = 30000;
        this.CLAIM_COOLDOWN = 60000;
        this.MAX_CLAIMS_PER_HOUR = 10;
        this.SESSION_DEDUP_WINDOW = 300000;

        this.activeVerifications = new Map();
        this.userClaimHistory = new Map();
        this._processedPostbacks = new Set(); // NEW: Idempotency guard

        this._startCleanupInterval();

        logger.info('AdCreditSystem initialized', {
            primaryUrl: this.PRIMARY_URL ? this.PRIMARY_URL.substring(0, 30) + '...' : 'NOT_CONFIGURED',
            fallbackUrl: this.FALLBACK_URL ? this.FALLBACK_URL.substring(0, 30) + '...' : 'NOT_CONFIGURED',
            minWatchTime: `${this.MIN_WATCH_TIME}ms`,
            claimCooldown: `${this.CLAIM_COOLDOWN}ms`,
            maxClaimsPerHour: this.MAX_CLAIMS_PER_HOUR
        });
    }

    /**
     * Validates ad URL format and warns if using known dead endpoints
     */
    _validateAdUrl(url, defaultUrl) {
        if (!url || typeof url !== 'string') {
            logger.warn('Ad URL not configured');
            return defaultUrl;
        }

        // Block known dead/problematic domains
        const blockedDomains = ['omg10.com', 'profitablecpmratenetwork.com'];
        try {
            const urlObj = new URL(url);
            if (blockedDomains.some(domain => urlObj.hostname.includes(domain))) {
                logger.error(`Blocked dead ad domain: ${urlObj.hostname}`);
                return defaultUrl;
            }
        } catch {
            logger.warn('Invalid ad URL format', { url });
            return defaultUrl;
        }

        return url;
    }

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

    async generateAdView(userId, networkType = 'primary') {
        // FIXED: Check if URLs are configured
        if (!this.PRIMARY_URL && !this.FALLBACK_URL) {
            logger.error('No ad URLs configured');
            return {
                success: false,
                error: 'AD_NETWORK_NOT_CONFIGURED',
                message: 'Ad system is temporarily unavailable. Please try again later.'
            };
        }

        const verificationId = `ad_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const isPrimary = networkType === 'primary';
        
        // FIXED: Fallback to available URL if primary is not configured
        let baseUrl = isPrimary ? this.PRIMARY_URL : this.FALLBACK_URL;
        if (!baseUrl) {
            baseUrl = this.PRIMARY_URL || this.FALLBACK_URL;
            logger.warn('Requested network not available, using fallback', { requested: networkType });
        }

        // FIXED: Use URL constructor for safe parameter appending
        let adUrl;
        try {
            const urlObj = new URL(baseUrl);
            urlObj.searchParams.set('subId', verificationId);
            urlObj.searchParams.set('userId', userId);
            adUrl = urlObj.toString();
        } catch {
            // Fallback to string concatenation if URL parsing fails
            const separator = baseUrl.includes('?') ? '&' : '?';
            adUrl = `${baseUrl}${separator}subId=${verificationId}&userId=${userId}`;
        }

        const networkEnum = isPrimary ? 'omg10' : 'profitablecpm';

        this.activeVerifications.set(verificationId, {
            userId,
            credits: 2,
            startTime: null,
            createdAt: Date.now(),
            status: 'PENDING',
            urlType: networkEnum
        });

        logger.info('Ad view generated', { userId, verificationId, network: networkEnum });

        return {
            success: true,
            verificationId,
            adUrl,
            network: networkEnum,
            type: 'redirect',
            estimatedTime: '30 sec',
            creditValue: 2,
            minWatchTime: this.MIN_WATCH_TIME
        };
    }

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

    async claimCredits(verificationId, userMetadata = {}) {
        const verification = this.activeVerifications.get(verificationId);

        if (!verification) {
            return {
                success: false,
                error: 'VERIFICATION_NOT_FOUND',
                message: 'Ad session expired. Please watch a new ad.'
            };
        }

        const { userId } = verification;

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

        const lastClaim = this._getLastClaimTime(userId);
        if (lastClaim && (Date.now() - lastClaim) < this.CLAIM_COOLDOWN) {
            const waitSec = Math.ceil((this.CLAIM_COOLDOWN - (Date.now() - lastClaim)) / 1000);
            return {
                success: false,
                error: 'CLAIM_COOLDOWN',
                message: `Please wait ${waitSec} seconds before your next ad.`,
                waitSeconds: waitSec
            };
        }

        const recentClaims = this._getRecentClaimsCount(userId, 3600000);
        if (recentClaims >= this.MAX_CLAIMS_PER_HOUR) {
            return {
                success: false,
                error: 'HOURLY_LIMIT_REACHED',
                message: `Ad limit reached: ${this.MAX_CLAIMS_PER_HOUR} per hour. Try again later.`,
                limit: this.MAX_CLAIMS_PER_HOUR,
                resetIn: this._getHourlyResetTime(userId)
            };
        }

        return this._awardCredits(verificationId, verification, {
            elapsed,
            userMetadata,
            claimedAt: Date.now()
        });
    }

    async _awardCredits(verificationId, verification, metadata = {}) {
        const { userId, credits, urlType } = verification;

        try {
            await User.updateOne(
                { userId },
                { $inc: { adCredits: credits } }
            );

            await AdView.create({
                viewId: verificationId,
                userId,
                network: urlType,
                creditsEarned: credits,
                status: 'COMPLETED',
                completedAt: new Date(),
                watchDuration: metadata.elapsed,
                metadata: {
                    ...metadata,
                    userAgent: metadata.userMetadata?.userAgent,
                    source: metadata.source || 'time_based_claim'
                }
            });

            verification.status = 'COMPLETED';
            verification.claimedAt = Date.now();
            this.activeVerifications.set(verificationId, verification);

            this._recordClaim(userId);

            const totalCredits = await this.getCredits(userId);

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

    _recordClaim(userId) {
        if (!this.userClaimHistory.has(userId)) {
            this.userClaimHistory.set(userId, []);
        }
        this.userClaimHistory.get(userId).push(Date.now());
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

    // FIXED: Corrected signature to accept (network, query) matching webhook call
    async handlePostback(network, query = {}) {
        const { verify, subId, status } = query;
        const verificationId = verify || subId;

        if (!verificationId) {
            return { success: false, error: 'MISSING_VERIFICATION_ID' };
        }

        // NEW: Idempotency check — prevent double-credit
        if (this._processedPostbacks.has(verificationId)) {
            logger.warn('Duplicate postback ignored', { verificationId, network });
            return { success: false, error: 'ALREADY_PROCESSED' };
        }

        const verification = this.activeVerifications.get(verificationId);
        if (!verification) {
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        // NEW: Validate network matches verification
        const expectedNetwork = verification.urlType;
        const incomingNetwork = network === 'primary' ? 'omg10' : 
                               network === 'fallback' ? 'profitablecpm' : network;
        
        if (incomingNetwork !== expectedNetwork) {
            logger.warn('Network mismatch in postback', {
                verificationId,
                expected: expectedNetwork,
                received: incomingNetwork
            });
            return { success: false, error: 'NETWORK_MISMATCH' };
        }

        if (status === 'completed' || status === 'approved') {
            if (verification.status === 'COMPLETED') {
                return { success: false, error: 'ALREADY_COMPLETED' };
            }

            this._processedPostbacks.add(verificationId);
            return this._awardCredits(verificationId, verification, { 
                source: 'postback',
                network: incomingNetwork 
            });
        }

        return { success: false, error: 'STATUS_NOT_COMPLETED' };
    }

    getAvailableNetworks() {
        const networks = [];
        
        if (this.PRIMARY_URL) {
            networks.push({
                id: 'primary',
                name: 'Watch Ad',
                creditValue: 2,
                configured: true,
                minWatchTime: Math.floor(this.MIN_WATCH_TIME / 1000)
            });
        }
        
        if (this.FALLBACK_URL) {
            networks.push({
                id: 'fallback',
                name: 'Watch Ad (Alt)',
                creditValue: 2,
                configured: true,
                minWatchTime: Math.floor(this.MIN_WATCH_TIME / 1000)
            });
        }
        
        return networks;
    }

    _startCleanupInterval() {
        setInterval(() => {
            const verCleaned = this.cleanupOldVerifications();
            const claimCleaned = this._cleanupOldClaims();
            const postbackCleaned = this._cleanupOldPostbacks();
            if (verCleaned > 0 || claimCleaned > 0 || postbackCleaned > 0) {
                logger.debug('Cleanup completed', { verCleaned, claimCleaned, postbackCleaned });
            }
        }, 300000);
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
            const filtered = history.filter(t => now - t < maxAge);
            if (filtered.length === 0) {
                this.userClaimHistory.delete(userId);
            } else {
                this.userClaimHistory.set(userId, filtered);
            }
            cleaned += history.length - filtered.length;
        }
        return cleaned;
    }

    // NEW: Clean up old processed postback IDs to prevent memory leak
    _cleanupOldPostbacks() {
        const maxSize = 10000;
        if (this._processedPostbacks.size > maxSize) {
            const toDelete = this._processedPostbacks.size - maxSize;
            const iter = this._processedPostbacks.values();
            for (let i = 0; i < toDelete; i++) {
                const val = iter.next().value;
                this._processedPostbacks.delete(val);
            }
            return toDelete;
        }
        return 0;
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
            
