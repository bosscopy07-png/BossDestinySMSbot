// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager.js — Session lifecycle management
// ═══════════════════════════════════════════════════════════════════════════════

import { Session, User, Transaction } from '../../models/index.js';
import { generateId } from '../../utils/helpers.js';
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
        this.activeSessions = new Map();
        this.sessionTimeouts = new Map();
        this.pollTimers = new Map();

        // Configuration
        this.config = {
            pollIntervals: {
                FREE: 10000,
                CHEAP: 5000,
                BUNDLE: 5000,
                VIP: 1000
            },
            timeouts: {
                FREE: 120,
                CHEAP: 180,
                BUNDLE: 180,
                VIP: 60
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

    async createSession(userId, mode, service, country = 'US') {
        return this._createSessionInternal(userId, mode, service, country);
    }

    /**
     * Create session with pre-assigned number
     * FIXED: Now accepts providerNumberId and cost as separate params
     */
    async createSessionWithNumber(userId, mode, service, country, phoneNumber, provider, providerNumberId = null, cost = 0) {
        const numberData = {
            phoneNumber,
            provider,
            providerNumberId: providerNumberId,
            providerInstance: null,
            cost: parseFloat(cost) || 0
        };
        return this._createSessionInternal(userId, mode, service, country, numberData);
    }

// ═══════════════════════════════════════════════════════════
//  PUBLIC API - Session Queries
// ═══════════════════════════════════════════════════════════

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
                    await this.deliverOTP(session, providerResult.otp);
                    return {
                        status: 'RECEIVED',
                        otpCode: providerResult.otp,
                        sessionId: session.sessionId,
                        number: session.number,
                        service: session.service
                    };
                }

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
     * FIXED:
     * - Only releases funds if lockTx is still PENDING
     * - Prevents double-refund by checking tx status first
     * - Returns detailed cancel result
     */
    async cancelSession(sessionId, userId) {
        const session = await Session.findOne({ sessionId, userId });
        if (!session) {
            throw new Error('SESSION_NOT_FOUND');
        }

        if (!['WAITING', 'CHECKING'].includes(session.status)) {
            throw new Error('SESSION_NOT_CANCELLABLE');
        }

        let releasedAmount = 0;
        let providerReleased = false;

        try {
            await this._releaseProviderNumber(session, 'USER_CANCELLED');
            providerReleased = true;
        } catch (providerError) {
            logger.warn('Provider release failed during cancel', {
                sessionId,
                error: providerError.message
            });
        }

        try {
            await this._restoreCredits(session);
        } catch (creditError) {
            logger.error('Credit restoration failed during cancel', {
                sessionId,
                error: creditError.message
            });
        }

        if (session.lockTxId) {
            try {
                const lockTx = await Transaction.findOne({
                    txId: session.lockTxId,
                    userId
                });

                if (!lockTx) {
                    logger.warn('Lock transaction not found during cancel', {
                        sessionId,
                        lockTxId: session.lockTxId
                    });
                } else if (lockTx.status !== 'PENDING') {
                    logger.warn('Lock transaction already processed, skipping release', {
                        sessionId,
                        lockTxId: session.lockTxId,
                        lockTxStatus: lockTx.status
                    });
                } else {
                    const releaseResult = await this.walletService.releaseFunds(
                        session.lockTxId,
                        userId,
                        'USER_CANCELLED'
                    );

                    if (releaseResult.success) {
                        releasedAmount = releaseResult.releasedAmount || session.cost || 0;
                    }
                }
            } catch (releaseError) {
                logger.error('Fund release failed during cancel', {
                    sessionId,
                    lockTxId: session.lockTxId,
                    error: releaseError.message
                });
            }
        }

        try {
            await Session.markCancelled(sessionId);
        } catch (dbError) {
            logger.error('Failed to mark session cancelled', {
                sessionId,
                error: dbError.message
            });
            throw new Error('SESSION_CANCEL_DB_FAILED');
        }

        this._cleanupSession(sessionId);

        logger.info('Session cancelled by user', {
            sessionId,
            userId,
            mode: session.mode,
            releasedAmount,
            providerReleased,
            lockTxId: session.lockTxId
        });

        return {
            success: true,
            sessionId,
            mode: session.mode,
            releasedAmount,
            restoredCredits: !!CreditRestoreConfig[session.mode],
            providerReleased
        };
    }

    /**
     * Deliver OTP to session
     * FIXED:
     * - Removes duplicate totalSpent increment
     * - Calls finishNumber on 5SIM after OTP delivery
     * - Uses generateId() for transaction txId
     */
    async deliverOTP(session, otp) {
        const sessionId = session.sessionId || session;

        if (typeof session === 'string') {
            session = await Session.findOne({ sessionId }).lean();
            if (!session) {
                logger.error('deliverOTP: Session not found', { sessionId });
                throw new Error('SESSION_NOT_FOUND');
            }
        }

        if (session.status === 'RECEIVED') {
            logger.warn('OTP already delivered', { sessionId });
            return session;
        }

        const maskedOtp = this.maskOTP(otp);

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
            } catch (captureError) {
                logger.error('Fund capture failed', { sessionId, error: captureError.message });
            }
        }

        // FIXED: Call finishNumber on 5SIM to mark activation as complete
        if (session.mode === 'CHEAP' && session.providerNumberId && this.providerManager) {
            try {
                const finishResult = await this.providerManager.finishNumber(
                    session.provider,
                    session.providerNumberId
                );
                logger.info('5SIM activation finished', {
                    sessionId,
                    activationId: session.providerNumberId,
                    result: finishResult
                });
            } catch (finishError) {
                logger.warn('5SIM finish failed (non-critical)', {
                    sessionId,
                    activationId: session.providerNumberId,
                    error: finishError.message
                });
            }
        }

        // Create transaction record for paid modes
        if (session.cost > 0 && session.mode === 'CHEAP') {
            try {
                await Transaction.create({
                    txId: generateId(),
                    userId: session.userId,
                    type: 'OTP_PURCHASE',
                    amount: -session.cost,
                    currency: 'USD',
                    status: 'COMPLETED',
                    metadata: {
                        sessionId,
                        service: session.service,
                        mode: session.mode,
                        number: session.number,
                        provider: session.provider,
                        providerNumberId: session.providerNumberId,
                        otpDeliveredAt: new Date()
                    }
                });
            } catch (txError) {
                logger.error('Transaction record failed', { sessionId, error: txError.message });
            }
        }

        this._cleanupSession(sessionId);

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
            duration: this._getDuration(session.startTime),
            mode: session.mode,
            cost: session.cost
        });

        return updated;
    }

    /**
     * Handle session timeout
     * FIXED: Now properly cancels on 5SIM using activation ID before refund
     */
    async handleTimeout(session) {
        const sessionId = session.sessionId || session;

        if (typeof session === 'string') {
            session = await Session.findOne({ sessionId }).lean();
            if (!session) return null;
        }

        if (!['WAITING', 'CHECKING'].includes(session.status)) {
            return null;
        }

        // FIXED: Cancel on 5SIM FIRST before releasing funds
        // This prevents 5SIM from keeping the number reserved for 10min
        if (session.mode === 'CHEAP' && session.providerNumberId && this.providerManager) {
            try {
                await this.providerManager.cancelCheapNumber(session.providerNumberId);
                logger.info('5SIM cancelled on timeout', {
                    sessionId,
                    activationId: session.providerNumberId
                });
            } catch (cancelError) {
                logger.warn('5SIM cancel on timeout failed (non-critical)', {
                    sessionId,
                    activationId: session.providerNumberId,
                    error: cancelError.message
                });
            }
        }

        // Release provider number
        await this._releaseProviderNumber(session, 'TIMEOUT');

        // Restore credits
        await this._restoreCredits(session);

        // Release locked funds — SINGLE SOURCE OF TRUTH for CHEAP refunds
        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                session.userId,
                'OTP_TIMEOUT'
            );
        }

        await Session.markTimeout(sessionId);
        this._cleanupSession(sessionId);

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
            duration: this._getDuration(session.startTime)
        });

        return { retried: false };
    }

    async handleProviderFailure(session, providerStatus) {
        const sessionId = session.sessionId || session;

        if (typeof session === 'string') {
            session = await Session.findOne({ sessionId }).lean();
            if (!session) return null;
        }

        const finalStatus = ProviderStatusMap[providerStatus] || 'FAILED';

        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                session.userId,
                `PROVIDER_${providerStatus}`
            );
        }

        await this._restoreCredits(session);

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
        const existing = await Session.findOne({
            userId,
     
