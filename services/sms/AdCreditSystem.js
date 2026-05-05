// ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — Part 1/2: Core Engine, Credit Management, Ad URL Generation
// ═══════════════════════════════════════════════════════════════════════════════

import { User, AdView } from '../../models/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';
import axios from 'axios';

/**
 * AdCreditSystem — Manages ad views → credit conversion with REAL ad networks
 *
 * Architecture:
 * - Shorte.st: URL shortening API (token required)
 * - CPAGrip/OGAds: Content locker via direct link + postback
 * - All networks use SERVER-SIDE postback for verification (not client-side)
 */
class AdCreditSystem {
    constructor() {
        // Network configs with real API endpoints
        this.AD_NETWORKS = {
            shorte_st: {
                name: 'Shorte.st',
                type: 'link',
                creditValue: 1,
                apiUrl: 'https://api.shorte.st/v1/data/url',
                // Requires SHORTE_ST_API_TOKEN env var
            },
            cpagrip: {
                name: 'CPAGrip',
                type: 'locker',
                creditValue: 2,
                // Requires CPAGRIP_LOCKER_URL env var (direct link from dashboard)
            },
            ogads: {
                name: 'OGAds',
                type: 'locker',
                creditValue: 2,
                // Requires OGADS_OFFERWALL_URL env var
                // Postback: BASE_URL/webhook/ad/ogads
            },
            admaven: {
                name: 'AdMaven',
                type: 'push',
                creditValue: 1,
                // Requires ADMAVEN_DIRECT_LINK env var
            },
            propeller: {
                name: 'PropellerAds',
                type: 'push',
                creditValue: 1,
                // Requires PROPELLER_DIRECT_LINK env var
            }
        };

        this.COSTS = {
            NUMBER_REQUEST: config.adSystem?.creditsPerRequest || 2,
            DAILY_FREE_LIMIT: config.limits?.freeDaily || 3
        };

        // Pending verifications: verificationId -> { userId, network, credits, status }
        this.activeVerifications = new Map();

        logger.info('AdCreditSystem initialized', {
            networks: Object.keys(this.AD_NETWORKS).length,
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
            lastReset.getUTCMonth() !== now.getUTCMonth();

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
    //  AD VIEW GENERATION — Create monetized links for user
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Generate ad view URL for user
     * Returns { verificationId, adUrl, network, type, creditValue }
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
            credits: networkConfig.creditValue,
            createdAt: Date.now(),
            status: 'PENDING'
        });

        // Generate actual ad URL based on network type
        let adUrl;
        try {
            adUrl = await this._buildRealAdUrl(network, verificationId, userId);
        } catch (error) {
            this.activeVerifications.delete(verificationId);
            throw new Error(`AD_URL_FAILED: ${error.message}`);
        }

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
     * Build REAL ad URLs using network APIs
     */
    async _buildRealAdUrl(network, verificationId, userId) {
        const baseUrl = process.env.BASE_URL;
        const callbackUrl = `${baseUrl}/webhook/ad/${verificationId}`;

        switch (network) {
            case 'shorte_st': {
                // Shorte.st API: shorten the callback URL
                const token = process.env.SHORTE_ST_API_TOKEN;
                if (!token) {
                    // Fallback: manual short link format
                    return `https://sh.st/stub/${verificationId}?callback=${encodeURIComponent(callbackUrl)}`;
                }

                try {
                    const response = await axios.put(
                        'https://api.shorte.st/v1/data/url',
                        { urlToShorten: callbackUrl },
                        {
                            headers: {
                                'public-api-token': token,
                                'Content-Type': 'application/json'
                            },
                            timeout: 10000
                        }
                    );
                    return response.data.shortenedUrl || response.data.shortUrl;
                } catch (apiError) {
                    logger.warn('Shorte.st API failed, using fallback', { error: apiError.message });
                    return `https://sh.st/stub/${verificationId}?fallback=${encodeURIComponent(callbackUrl)}`;
                }
            }

            case 'cpagrip': {
                // CPAGrip: Use direct locker URL with subId for tracking
                const lockerUrl = process.env.CPAGRIP_LOCKER_URL;
                if (!lockerUrl) {
                    throw new Error('CPAGRIP_LOCKER_URL not configured');
                }
                // Append tracking parameters
                const separator = lockerUrl.includes('?') ? '&' : '?';
                return `${lockerUrl}${separator}subId=${verificationId}&userId=${userId}&callback=${encodeURIComponent(callbackUrl)}`;
            }

            case 'ogads': {
                // OGAds: Use offerwall API URL
                const apiKey = process.env.OGADS_API_KEY;
                const wallId = process.env.OGADS_WALL_ID;
                if (!apiKey || !wallId) {
                    throw new Error('OGADS_API_KEY or OGADS_WALL_ID not configured');
                }

                // OGAds offerwall URL with postback
                const postbackUrl = encodeURIComponent(`${baseUrl}/webhook/ad/ogads?verify=${verificationId}`);
                return `https://ogads.com/api/offerwall?key=${apiKey}&wall=${wallId}&user=${userId}&sub=${verificationId}&postback=${postbackUrl}`;
            }

            case 'admaven': {
                const directLink = process.env.ADMAVEN_DIRECT_LINK;
                if (!directLink) {
                    throw new Error('ADMAVEN_DIRECT_LINK not configured');
                }
                return `${directLink}?sub=${verificationId}&user=${userId}&cb=${encodeURIComponent(callbackUrl)}`;
            }

            case 'propeller': {
                const directLink = process.env.PROPELLER_DIRECT_LINK;
                if (!directLink) {
                    throw new Error('PROPELLER_DIRECT_LINK not configured');
                }
                return `${directLink}?sub=${verificationId}&user=${userId}&cb=${encodeURIComponent(callbackUrl)}`;
            }

            default:
                throw new Error(`Unknown network: ${network}`);
        }
            }
                    // ═══════════════════════════════════════════════════════════════════════════════
// AdCreditSystem.js — Part 2/2: Postback Webhook Handlers, Validation & Cleanup
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  POSTBACK WEBHOOK HANDLERS — Called by ad networks when user completes offer
    //  These are the REAL verification methods — client "I watched it" is fake
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Main webhook handler — ad networks ping this when offer completes
     * Route: POST /webhook/ad/:network or /webhook/ad/:verificationId
     */
    async handlePostback(network, payload, query = {}) {
        logger.info('Ad postback received', { network, payload: !!payload, query });

        // OGAds/CPAGrip style: network-specific postback
        if (network === 'ogads' || network === 'cpagrip') {
            return this._handleNetworkPostback(network, query);
        }

        // Generic verificationId-based postback (Shorte.st, AdMaven, etc.)
        const { verify, sub, subId, status, conversion } = query;

        if (!verify && !sub && !subId) {
            return { success: false, error: 'MISSING_VERIFICATION_ID' };
        }

        const verificationId = verify || sub || subId;
        return this._processVerification(verificationId, { network, status, conversion, query });
    }

    /**
     * Handle network-specific postback format
     */
    async _handleNetworkPostback(network, query) {
        const {
            subId,          // Our tracking ID
            payout,         // Revenue in USD
            status,         // 'approved', 'pending', 'rejected'
            offer_id,       // Completed offer ID
            ip              // User IP
        } = query;

        if (!subId) {
            return { success: false, error: 'MISSING_SUBID' };
        }

        // Validate status
        if (status && status !== 'approved' && status !== 'completed') {
            logger.info('Postback rejected — non-approved status', { subId, status });
            return { success: false, error: 'STATUS_NOT_APPROVED', status };
        }

        return this._processVerification(subId, {
            network,
            payout,
            offerId: offer_id,
            ip,
            query
        });
    }

    /**
     * Process a verified completion — award credits to user
     */
    async _processVerification(verificationId, metadata = {}) {
        const verification = this.activeVerifications.get(verificationId);

        if (!verification) {
            // Might be a duplicate postback or expired
            logger.warn('Verification not found or expired', { verificationId });
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        if (verification.status === 'COMPLETED') {
            return { success: false, error: 'ALREADY_COMPLETED' };
        }

        // Award credits
        const { userId, network, credits } = verification;
        const networkConfig = this.AD_NETWORKS[network];

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
                network,
                creditsEarned: credits,
                status: 'COMPLETED',
                completedAt: new Date(),
                metadata: {
                    ...metadata,
                    userAgent: metadata.userAgent,
                    ip: metadata.ip
                }
            });

            // Mark as completed
            verification.status = 'COMPLETED';
            verification.completedAt = Date.now();
            this.activeVerifications.set(verificationId, verification);

            logger.info('Ad credit awarded via postback', {
                userId,
                verificationId,
                network,
                credits,
                payout: metadata.payout
            });

            return {
                success: true,
                creditsAdded: credits,
                totalCredits: await this.getCredits(userId)
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
     * LEGACY: Client-side "I watched it" verification
     * DEPRECATED: Use server-side postbacks instead. Kept for fallback only.
     */
    async handleClientVerification(verificationId, payload) {
        logger.warn('Client-side verification used — should migrate to postback', { verificationId });

        const verification = this.activeVerifications.get(verificationId);
        if (!verification) {
            return { success: false, error: 'VERIFICATION_NOT_FOUND' };
        }

        if (verification.status === 'COMPLETED') {
            return { success: false, error: 'ALREADY_COMPLETED' };
        }

        // Basic client-side validation (easily faked — not recommended)
        const isValid = payload && (
            payload.completed === true ||
            payload.status === 'completed' ||
            payload.verified === true
        );

        if (!isValid) {
            verification.status = 'FAILED';
            this.activeVerifications.set(verificationId, verification);
            return { success: false, error: 'VALIDATION_FAILED' };
        }

        // Award credits (but log warning about client-side)
        return this._processVerification(verificationId, {
            source: 'client_side',
            payload
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  UTILITY METHODS
    // ═══════════════════════════════════════════════════════════════════════

    getAvailableNetworks() {
        return Object.entries(this.AD_NETWORKS).map(([id, config]) => ({
            id,
            ...config,
            configured: this._isNetworkConfigured(id)
        }));
    }

    _isNetworkConfigured(network) {
        switch (network) {
            case 'shorte_st': return !!process.env.SHORTE_ST_API_TOKEN || true; // Has fallback
            case 'cpagrip': return !!process.env.CPAGRIP_LOCKER_URL;
            case 'ogads': return !!process.env.OGADS_API_KEY && !!process.env.OGADS_WALL_ID;
            case 'admaven': return !!process.env.ADMAVEN_DIRECT_LINK;
            case 'propeller': return !!process.env.PROPELLER_DIRECT_LINK;
            default: return false;
        }
    }

    getPendingVerifications() {
        const now = Date.now();
        const pending = [];
        for (const [id, v] of this.activeVerifications) {
            if (v.status === 'PENDING' && now - v.createdAt < 3600000) {
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
