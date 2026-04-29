// ==================== SESSION MANAGER - FULLY IMPROVED ====================

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
        this.notificationService = notificationService; // ⭐ NEW: For timeout notifications
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
     * Create session with pre-assigned number (VIP flow)
     */
    async createSessionWithNumber(userId, mode, service, country, phoneNumber, provider) {
        const numberData = {
            phoneNumber,
            provider,
            providerNumberId: null,
            providerInstance: null
        };
        return this._createSessionInternal(userId, mode, service, country, numberData);
    }

    /**
     * ⭐ NEW: Check session status by ID (for Check OTP button)
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
     * ⭐ NEW: Check session status by user (for manual polling)
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
     */
    async cancelSession(sessionId, userId) {
        const session = await Session.findOne({ sessionId, userId });
        if (!session) throw new Error('SESSION_NOT_FOUND');
        if (!['WAITING', 'CHECKING'].includes(session.status)) {
            throw new Error('SESSION_NOT_CANCELLABLE');
        }

        // Release provider number
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

        // Release provider number
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

        // ⭐ NEW: Send timeout notification
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
        const { cost, lockTxId } = await this._handleFinances(user, userId, mode, numberData, service);

        // Calculate timeout
        const timeoutSeconds = this.config.timeouts[mode] || 120;
        const timeoutAt = new Date(Date.now() + timeoutSeconds * 1000);

        // Create session
        const session = await Session.create({
            sessionId: generateId(),
            userId,
            mode,
            service,
            country,
            number: numberData.phoneNumber,
            provider: numberData.provider,
            providerNumberId: numberData.providerNumberId || null,
            status: 'WAITING',
            startTime: new Date(),
            timeoutAt,
            cost,
            lockTxId,
            maxRetries: this.config.maxRetries[mode] || 0
        });

        // Start monitoring
        this._startMonitoring(session, numberData.providerInstance);

        logger.info('Session created', {
            sessionId: session.sessionId,
            userId,
            mode,
            service,
            number: this.maskPhone(session.number),
            provider: numberData.provider,
            timeoutAt
        });

        return session;
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL - Finances
    // ═══════════════════════════════════════════════════════════

    
    async _handleFinances(user, userId, mode, numberData, service) {
        let cost = 0;
        let lockTxId = null;

        switch (mode) {
            case 'CHEAP': {
                cost = config.pricing?.cheapOtp || 0.05;
                try {
                    lockTxId = await this.walletService.lockFunds(userId, cost, `OTP_${service}`);
                } catch (error) {
                    await this._releaseProviderNumber({ ...numberData, mode }, 'FUNDS_LOCK_FAILED');
                    throw new Error('INSUFFICIENT_FUNDS');
                }
                break;
            }

            case 'BUNDLE': {
                const bundleRemaining = user.bundleRemaining || 0;
                if (bundleRemaining <= 0) {
                    await this._releaseProviderNumber({ ...numberData, mode }, 'BUNDLE_EMPTY');
                    throw new Error('BUNDLE_EMPTY');
                }
                await User.updateOne({ userId }, { $inc: { bundleRemaining: -1 } });
                break;
            }

            case 'VIP': {
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });
                break;
            }

            case 'FREE': {
                await User.updateOne({ userId }, { $inc: { freeUsedToday: 1 } });
                break;
            }
        }

        return { cost, lockTxId };
    }

    async _restoreCredits(session) {
        const restoreConfig = CreditRestoreConfig[session.mode];
        if (!restoreConfig) return;

        try {
            await User.updateOne(
                { userId: session.userId },
                { $inc: { [restoreConfig.field]: restoreConfig.amount } }
            );
            logger.info('Credits restored', {
                sessionId: session.sessionId,
                mode: session.mode,
                field: restoreConfig.field,
                amount: restoreConfig.amount
            });
        } catch (error) {
            logger.error('Credit restoration failed', {
                sessionId: session.sessionId,
                error: error.message
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL - Provider Management
    // ═══════════════════════════════════════════════════════════

    async _releaseProviderNumber(session, reason) {
        try {
            if (session.mode === 'VIP' && this.numberPoolManager && session.providerNumberId) {
                await this.numberPoolManager.releaseNumber(session.providerNumberId, reason);
            } else if (this.providerManager) {
                await this.providerManager.cancelNumber(
                    session.provider,
                    session.providerNumberId || session.number
                );
            }
        } catch (error) {
            logger.warn('Provider release failed', {
                sessionId: session.sessionId || 'unknown',
                reason,
                error: error.message
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL - Validation
    // ═══════════════════════════════════════════════════════════

    async _validateModeAccess(user, mode) {
        const checks = {
            FREE: () => {
                if (typeof user.canUseFree === 'function' ? !user.canUseFree() : (user.freeUsedToday || 0) >= (config.limits?.freeDaily || 3)) {
                    throw new Error('FREE_LIMIT_REACHED');
                }
            },
            CHEAP: () => {
                const minBalance = config.pricing?.cheapOtp || 0.05;
                const available = typeof user.getAvailableBalance === 'function'
                    ? user.getAvailableBalance()
                    : (user.balance || 0) - (user.lockedBalance || 0);
                if (available < minBalance) {
                    throw new Error('INSUFFICIENT_BALANCE');
                }
            },
            VIP: () => {
                const isActive = typeof user.isVipActive === 'function'
                    ? user.isVipActive()
                    : !!(user.vipExpiry && new Date(user.vipExpiry) > new Date());
                if (!isActive) throw new Error('VIP_EXPIRED');

                const canUse = typeof user.canUseVip === 'function'
                    ? user.canUseVip()
                    : (user.vipDailyUsed || 0) < (config.limits?.vipDaily || 50);
                if (!canUse) throw new Error('VIP_DAILY_LIMIT_REACHED');
            },
            BUNDLE: () => {
                if ((user.bundleRemaining || 0) <= 0) {
                    throw new Error('BUNDLE_EMPTY');
                }
            }
        };

        const check = checks[mode];
        if (!check) throw new Error('INVALID_MODE');

        await check();
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL - Monitoring
    // ═══════════════════════════════════════════════════════════

    _startMonitoring(session, providerInstance) {
        const sessionId = session.sessionId;

        // Store in memory
        this.activeSessions.set(sessionId, {
            session,
            providerInstance,
            state: SessionState.CREATED,
            lastPollAt: null,
            pollCount: 0
        });

        // Schedule timeout
        const timeoutMs = new Date(session.timeoutAt) - Date.now();
        const timeoutTimer = setTimeout(async () => {
            try {
                const current = await Session.findOne({ sessionId }).lean();
                if (current && ['WAITING', 'CHECKING'].includes(current.status)) {
                    await this.handleTimeout(current);
                }
            } catch (error) {
                logger.error('Timeout handler error', { sessionId, error: error.message });
            }
        }, Math.max(timeoutMs, 0));

        this.sessionTimeouts.set(sessionId, timeoutTimer);

        // Start polling
        const pollInterval = this.config.pollIntervals[session.mode] || 5000;
        this._schedulePoll(sessionId, pollInterval);
    }

    _schedulePoll(sessionId, interval) {
        const timer = setTimeout(async () => {
            await this._pollProvider(sessionId, interval);
        }, interval);

        this.pollTimers.set(sessionId, timer);
    }

    async _pollProvider(sessionId, interval) {
        const sessionData = this.activeSessions.get(sessionId);
        if (!sessionData) return;

        try {
            const current = await Session.findOne({ sessionId }).lean();
            if (!current || !['WAITING', 'CHECKING'].includes(current.status)) {
                this._cleanupSession(sessionId);
                return;
            }

            // Check timeout
            if (new Date() > new Date(current.timeoutAt)) {
                return; // Timeout handler will take care of this
            }

            sessionData.lastPollAt = new Date();
            sessionData.pollCount++;
            sessionData.state = SessionState.MONITORING;

            // Update to CHECKING after first poll
            if (current.status === 'WAITING') {
                await Session.updateOne(
                    { sessionId },
                    { $set: { status: 'CHECKING' } }
                );
            }

            // Poll provider
            const result = await this.providerManager.checkSMS(
                current.provider,
                current.providerNumberId || current.number
            );

            if (result.success && result.otp) {
                await this.deliverOTP(current, result.otp);
                return;
            }

            if (result.status && ['CANCELLED', 'TIMEOUT', 'EXPIRED', 'ERROR', 'BANNED'].includes(result.status)) {
                await this.handleProviderFailure(current, result.status);
                return;
            }

            // Schedule next poll
            this._schedulePoll(sessionId, interval);

        } catch (error) {
            logger.error('Poll error', {
                sessionId,
                error: error.message,
                pollCount: sessionData.pollCount
            });

            // Continue polling on error
            this._schedulePoll(sessionId, interval);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL - Cleanup
    // ═══════════════════════════════════════════════════════════

    _cleanupSession(sessionId) {
        // Clear poll timer
        const pollTimer = this.pollTimers.get(sessionId);
        if (pollTimer) {
            clearTimeout(pollTimer);
            this.pollTimers.delete(sessionId);
        }

        // Clear timeout timer
        const timeoutTimer = this.sessionTimeouts.get(sessionId);
        if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            this.sessionTimeouts.delete(sessionId);
        }

        // Remove from active sessions
        const sessionData = this.activeSessions.get(sessionId);
        if (sessionData) {
            sessionData.state = SessionState.CLEANED;
            this.activeSessions.delete(sessionId);
        }

        logger.debug('Session cleaned up', { sessionId });
    }

    async _gracefulShutdown() {
        logger.info('SessionManager shutting down...', {
            activeSessions: this.activeSessions.size
        });

        // Cancel all active sessions
        const promises = [];
        for (const [sessionId, sessionData] of this.activeSessions) {
            promises.push(
                this.handleProviderFailure(sessionData.session, 'CANCELLED').catch(err => {
                    logger.error('Shutdown cleanup error', { sessionId, error: err.message });
                })
            );
        }

        await Promise.allSettled(promises);

        // Clear all timers
        for (const timer of this.pollTimers.values()) clearTimeout(timer);
        for (const timer of this.sessionTimeouts.values()) clearTimeout(timer);

        this.activeSessions.clear();
        this.pollTimers.clear();
        this.sessionTimeouts.clear();

        process.removeListener('SIGINT', this._shutdownHandler);
        process.removeListener('SIGTERM', this._shutdownHandler);

        logger.info('SessionManager shutdown complete');
    }

    // ═══════════════════════════════════════════════════════════
    //  UTILITIES
    // ═══════════════════════════════════════════════════════════

    maskOTP(otp) {
        if (!otp || otp.length <= 3) return '***';
        return '*'.repeat(otp.length - 3) + otp.slice(-3);
    }

    maskPhone(phone) {
        if (!phone || phone.length < 4) return '****';
        return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
    }
}

export default SessionManager;
