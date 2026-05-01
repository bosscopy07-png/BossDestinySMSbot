import { Session, User, Transaction } from '../../models/index.js';
import { generateId, getDuration } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * Session lifecycle states for internal tracking
 */
const SessionState = Object.freeze({
    CREATED: 'CREATED',
    MONITORING: 'MONITORING',
    OTP_RECEIVED: 'OTP_RECEIVED',
    TIMEOUT: 'TIMEOUT',
    CANCELLED: 'CANCELLED',
    FAILED: 'FAILED',
    CLEANED: 'CLEANED'
});

/**
 * Provider status mapping
 */
const ProviderStatusMap = Object.freeze({
    CANCELLED: 'CANCELLED',
    TIMEOUT: 'TIMEOUT',
    EXPIRED: 'TIMEOUT',
    ERROR: 'FAILED',
    BANNED: 'FAILED'
});

/**
 * Credit restoration config by mode
 */
const CreditRestoreConfig = Object.freeze({
    FREE: { field: 'freeUsedToday', amount: -1 },
    BUNDLE: { field: 'bundleRemaining', amount: 1 },
    VIP: { field: 'vipDailyUsed', amount: -1 }
});

class SessionManager {
    constructor(providerManager, retryEngine, walletService, notificationService = null, numberPoolManager = null) {
        this.providerManager = providerManager;
        this.retryEngine = retryEngine;
        this.walletService = walletService;
        this.notificationService = notificationService;
        this.numberPoolManager = numberPoolManager;

        // In-memory session tracking
        this.activeSessions = new Map();      // sessionId -> sessionData
        this.sessionTimeouts = new Map();     // sessionId -> timeoutTimer
        this.pollTimers = new Map();          // sessionId -> pollTimer

        // Configuration
        this.config = {
            pollIntervals: {
                FREE: 10000,      // 10s
                CHEAP: 5000,      // 5s
                BUNDLE: 5000,     // 5s
                VIP: 1000         // 1s
            },
            timeouts: {
                FREE: 120,        // 2 minutes
                CHEAP: 180,       // 3 minutes
                BUNDLE: 180,      // 3 minutes
                VIP: 60           // 1 minute
            },
            maxRetries: {
                FREE: 0,
                CHEAP: 2,
                BUNDLE: 1,
                VIP: 0
            },
            services: config.services || [
                'WhatsApp', 'Telegram', 'Facebook', 'Instagram', 'Twitter',
                'TikTok', 'Binance', 'Coinbase', 'Gmail', 'Outlook',
                'Netflix', 'Amazon', 'PayPal', 'Snapchat', 'Discord'
            ]
        };

        // Graceful shutdown handler
        this._shutdownHandler = this._gracefulShutdown.bind(this);
        process.on('SIGINT', this._shutdownHandler);
        process.on('SIGTERM', this._shutdownHandler);
    }

    // ═══════════════════════════════════════════════════════════
    //  PUBLIC API - Session Creation
    // ═══════════════════════════════════════════════════════════

    /**
     * Create a new OTP session (standard flow)
     */
    async createSession(userId, mode, service, country = 'US') {
        return this._createSessionInternal(userId, mode, service, country);
    }

    /**
     * Create session with pre-assigned number (VIP/CHEAP/FREE flow)
     * 
     * FIXED: Now accepts providerNumberId and cost as separate params
     * Previously: (userId, mode, service, country, phoneNumber, provider) — providerNumberId was LOST
     * Now: (userId, mode, service, country, phoneNumber, provider, providerNumberId, cost)
     */
    async createSessionWithNumber(userId, mode, service, country, phoneNumber, provider, providerNumberId = null, cost = 0) {
        const numberData = {
            phoneNumber,
            provider,
            providerNumberId: providerNumberId,  // FIXED: Now properly captured
            providerInstance: null,
            cost: parseFloat(cost) || 0  // FIXED: Pass actual cost from 5SIM
        };
        return this._createSessionInternal(userId, mode, service, country, numberData);
    }

    // ═══════════════════════════════════════════════════════════
    //  PUBLIC API - Session Queries
    // ═══════════════════════════════════════════════════════════

    /**
     * Check session status by ID (for Check OTP button)
     */
    async checkSessionStatus(sessionId) {
        const session = await Session.findOne({ sessionId }).lean();
        if (!session) {
            throw new Error('SESSION_NOT_FOUND');
        }

        // If still waiting, poll provider for latest status
        if (['WAITING', 'CHECKING'].includes(session.status)) {
            try {
                const providerResult = await this.providerManager.checkSMS(
                    session.provider,
                    session.providerNumberId || session.number
                );

                if (providerResult.success && providerResult.otp) {
                    // OTP found! Auto-deliver
                    await this.deliverOTP(session, providerResult.otp);
                    return {
                        status: 'RECEIVED',
                        otpCode: providerResult.otp,
                        sessionId: session.sessionId,
                        number: session.number,
                        service: session.service
                    };
                }

                // Update CHECKING status if we haven't yet
                if (session.status === 'WAITING') {
                    await Session.updateOne(
                        { sessionId },
                        { $set: { status: 'CHECKING' } }
                    );
                }

            } catch (pollError) {
                logger.warn('Manual poll failed', { sessionId, error: pollError.message });
            }
        }

        // Return current status
        return {
            sessionId: session.sessionId,
            status: session.status,
            service: session.service,
            number: session.number,
            startTime: session.startTime,
            timeoutAt: session.timeoutAt,
            cost: session.cost,
            otpCode: session.status === 'RECEIVED' ? session.otpCode : null,
            maskedOtp: session.status === 'RECEIVED' ? session.maskedOtp : null,
            timeLeft: Math.max(0, Math.floor((new Date(session.timeoutAt) - new Date()) / 1000))
        };
    }

    /**
     * Check session status by user (for manual polling)
     */
    async checkSessionByUser(userId) {
        const session = await Session.findOne({
            userId,
            status: { $in: ['WAITING', 'CHECKING'] }
        }).sort({ startTime: -1 }).lean();

        if (!session) {
            return { hasActive: false };
        }

        return this.checkSessionStatus(session.sessionId);
    }

    /**
     * Cancel an active session
     * FIXED: Now properly cancels on 5SIM using activation ID (not phone number)
     */
    async cancelSession(sessionId, userId) {
        const session = await Session.findOne({ sessionId, userId });
        if (!session) throw new Error('SESSION_NOT_FOUND');
        if (!['WAITING', 'CHECKING'].includes(session.status)) {
            throw new Error('SESSION_NOT_CANCELLABLE');
        }

        // FIXED: Release provider number using correct ID
        // For CHEAP: uses providerNumberId (activation ID like "1001025384")
        // For others: falls back to session.number if providerNumberId is null
        await this._releaseProviderNumber(session, 'USER_CANCELLED');

        // Restore user credits
        await this._restoreCredits(session);

        // Release locked funds
        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                userId,
                'USER_CANCELLED'
            );
        }

        // Update session status
        await Session.markCancelled(sessionId);

        // Cleanup
        this._cleanupSession(sessionId);

        logger.info('Session cancelled by user', { sessionId, userId, mode: session.mode });

        return {
            success: true,
            sessionId,
            restoredCredits: !!CreditRestoreConfig[session.mode],
            refundedAmount: session.mode === 'CHEAP' ? session.cost : 0
        };
    }

    /**
     * Deliver OTP to session (called by webhook or polling)
     */
    async deliverOTP(session, otp) {
        const sessionId = session.sessionId || session;

        // If string passed, look up session
        if (typeof session === 'string') {
            session = await Session.findOne({ sessionId }).lean();
            if (!session) throw new Error('SESSION_NOT_FOUND');
        }

        // Idempotency check
        if (session.status === 'RECEIVED') {
            logger.warn('OTP already delivered', { sessionId });
            return session;
        }

        const maskedOtp = this.maskOTP(otp);

        // Update session
        const updated = await Session.findOneAndUpdate(
            { sessionId, status: { $in: ['WAITING', 'CHECKING'] } },
            {
                $set: {
                    status: 'RECEIVED',
                    otpCode: otp,
                    maskedOtp,
                    endTime: new Date()
                }
            },
            { new: true }
        );

        if (!updated) {
            logger.warn('Session not in deliverable state', { sessionId, status: session.status });
            return null;
        }

        // Capture funds for CHEAP mode
        if (session.mode === 'CHEAP' && session.lockTxId) {
            try {
                await this.walletService.captureFunds(session.lockTxId, session.userId);
                await User.updateOne(
                    { userId: session.userId },
                    { $inc: { totalSpent: session.cost } }
                );
            } catch (captureError) {
                logger.error('Fund capture failed', { sessionId, error: captureError.message });
            }
        }

        // Create transaction record for paid modes
        if (session.cost > 0 && session.mode !== 'BUNDLE') {
            try {
                await Transaction.create({
                    txId: `OTP_${sessionId}`,
                    userId: session.userId,
                    type: 'OTP_PURCHASE',
                    amount: -session.cost,
                    status: 'COMPLETED',
                    metadata: {
                        sessionId,
                        service: session.service,
                        mode: session.mode,
                        number: session.number
                    }
                });
            } catch (txError) {
                logger.error('Transaction record failed', { sessionId, error: txError.message });
            }
        }

        // Cleanup
        this._cleanupSession(sessionId);

        // Notify via notification service if available
        if (this.notificationService) {
            try {
                await this.notificationService.notifyOTPReceived(session.userId, {
                    sessionId,
                    service: session.service,
                    number: session.number,
                    otp: maskedOtp
                });
            } catch (notifyError) {
                logger.error('OTP received notification failed', { sessionId, error: notifyError.message });
            }
        }

        logger.info('OTP delivered', {
            sessionId,
            userId: session.userId,
            duration: getDuration(session.startTime),
            mode: session.mode
        });

        return updated;
    }

    /**
     * Handle session timeout
     * FIXED: Now properly cancels on 5SIM using activation ID
     */
    async handleTimeout(session) {
        const sessionId = session.sessionId || session;

        if (typeof session === 'string') {
            session = await Session.findOne({ sessionId }).lean();
            if (!session) return null;
        }

        // Idempotency check
        if (!['WAITING', 'CHECKING'].includes(session.status)) {
            return null;
        }

        // FIXED: Release provider number using correct activation ID for CHEAP
        await this._releaseProviderNumber(session, 'TIMEOUT');

        // Restore credits
        await this._restoreCredits(session);

        // Release locked funds
        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                session.userId,
                'OTP_TIMEOUT'
            );
        }

        // Update session
        await Session.markTimeout(sessionId);

        // Cleanup
        this._cleanupSession(sessionId);

        // Send timeout notification
        if (this.notificationService) {
            try {
                await this.notificationService.notifyTimeout(session.userId, {
                    sessionId,
                    service: session.service,
                    number: session.number,
                    mode: session.mode,
                    restoredCredits: !!CreditRestoreConfig[session.mode]
                });
            } catch (notifyError) {
                logger.error('Timeout notification failed', { sessionId, error: notifyError.message });
            }
        }

        // Retry logic for CHEAP mode
        if (session.mode === 'CHEAP' && session.retryCount < session.maxRetries) {
            logger.info('Retrying CHEAP session', {
                sessionId,
                retryCount: session.retryCount + 1,
                maxRetries: session.maxRetries
            });

            try {
                const newSession = await this.createSession(
                    session.userId,
                    session.mode,
                    session.service,
                    session.country
                );
                return { retried: true, newSessionId: newSession.sessionId };
            } catch (retryError) {
                logger.error('Retry failed', { sessionId, error: retryError.message });
            }
        }

        logger.info('Session timed out', {
            sessionId,
            userId: session.userId,
            mode: session.mode,
            duration: getDuration(session.startTime)
        });

        return { retried: false };
    }

    /**
     * Handle provider-side failure
     */
    async handleProviderFailure(session, providerStatus) {
        const sessionId = session.sessionId || session;

        if (typeof session === 'string') {
            session = await Session.findOne({ sessionId }).lean();
            if (!session) return null;
        }

        const finalStatus = ProviderStatusMap[providerStatus] || 'FAILED';

        // Release funds
        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                session.userId,
                `PROVIDER_${providerStatus}`
            );
        }

        // Restore credits
        await this._restoreCredits(session);

        // Update session
        await Session.updateOne(
            { sessionId },
            { $set: { status: finalStatus, endTime: new Date() } }
        );

        this._cleanupSession(sessionId);

        logger.info('Session ended - provider failure', {
            sessionId,
            userId: session.userId,
            providerStatus,
            finalStatus
        });

        return finalStatus;
    }

    // ═══════════════════════════════════════════════════════════
    //  PUBLIC API - Queries
    // ═══════════════════════════════════════════════════════════

    async getActiveSession(userId) {
        return Session.findOne({
            userId,
            status: { $in: ['WAITING', 'CHECKING'] }
        }).lean();
    }

    async getSessionStatus(sessionId, userId) {
        const session = await Session.findOne({ sessionId, userId }).lean();
        if (!session) throw new Error('SESSION_NOT_FOUND');

        return {
            sessionId: session.sessionId,
            status: session.status,
            service: session.service,
            number: session.number ? this.maskPhone(session.number) : null,
            startTime: session.startTime,
            timeoutAt: session.timeoutAt,
            cost: session.cost,
            otpCode: session.status === 'RECEIVED' ? session.maskedOtp : null,
            timeLeft: Math.max(0, Math.floor((new Date(session.timeoutAt) - new Date()) / 1000))
        };
    }

    async getActiveCount() {
        return Session.countDocuments({ status: { $in: ['WAITING', 'CHECKING'] } });
    }

    getMemoryStats() {
        return {
            activeSessions: this.activeSessions.size,
            sessionTimeouts: this.sessionTimeouts.size,
            pollTimers: this.pollTimers.size,
            sessionIds: Array.from(this.activeSessions.keys())
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL - Session Creation
    // ═══════════════════════════════════════════════════════════

    async _createSessionInternal(userId, mode, service, country, preAssignedNumber = null) {
        // Check for existing active session
        const existing = await Session.findOne({
            userId,
            status: { $in: ['WAITING', 'CHECKING'] }
        }).lean();

        if (existing) {
            logger.warn('Active session exists', { userId, existingSessionId: existing.sessionId });
            throw new Error('ACTIVE_SESSION_EXISTS');
        }

        // Validate user
        const user = await User.findOne({ userId });
        if (!user) throw new Error('USER_NOT_FOUND');
        if (user.isBlacklisted) throw new Error('USER_BLACKLISTED');

        // Validate mode access
        await this._validateModeAccess(user, mode);

        // Validate service
        if (!this.config.services.includes(service)) {
            throw new Error('INVALID_SERVICE');
        }

        // Acquire number
        let numberData;
        try {
            if (preAssignedNumber) {
                numberData = preAssignedNumber;
            } else if (mode === 'VIP' && this.numberPoolManager) {
                numberData = await this.numberPoolManager.acquireNumber(country, service, userId);
            } else {
                numberData = await this.providerManager.getNumber(mode, country, service);
            }
        } catch (error) {
            logger.error('Number acquisition failed', {
                userId, mode, service, country, error: error.message
            });
            throw new Error('NUMBER_UNAVAILABLE: ' + error.message);
        }

        // Validate number
        if (!numberData.phoneNumber || numberData.phoneNumber.length < 7) {
            logger.error('Invalid phone number', {
                userId,
                phone: numberData.phoneNumber,
                provider: numberData.provider
            });
            await this._releaseProviderNumber({ ...numberData, mode }, 'INVALID_NUMBER');
            throw new Error('INVALID_NUMBER_FROM_PROVIDER');
        }

        // Handle finances
        // FIXED: Pass numberData.cost so CHEAP uses actual 5SIM display price, not hardcoded $0.05
        const { cost, lockTxId } = await this._handleFinances(user, userId, mode, numberData, service);

        // Calculate timeout
        const timeoutSeconds = this.config.timeouts[mode] || 120;
        const timeoutAt = new Date(Date.now() + timeoutSeconds * 1000);

        // Create session
        // FIXED: Store providerNumberId from numberData (activation ID for 5SIM)
        const session = await Session.create({
            sessionId: generateId(),
            userId,
            mode,
            service,
            country,
            number: numberData.phoneNumber,
            provider: numberData.provider,
            providerNumberId: numberData.providerNumberId || null,  // FIXED: Now stores activation ID
            status: 'WAITING',
            startTime: new Date(),
            timeoutAt,
            cost,
                
