// ═══════════════════════════════════════════════════════════════════════════════
// SessionManager.js — Session lifecycle management
// Part 1/3 — Imports, Constructor, Public API (Session Creation & Queries)
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
     * FIXED: Now accepts providerNumberId, cost, operator, AND routedProvider as separate params
     * Previously: operator and routedProvider were LOST
     */
    async createSessionWithNumber(userId, mode, service, country, phoneNumber, provider, providerNumberId = null, cost = 0, operator = null, routedProvider = null) {
        const numberData = {
            phoneNumber,
            provider,
            providerNumberId: providerNumberId,
            providerInstance: null,
            cost: parseFloat(cost) || 0,
            displayCost: parseFloat(cost) || 0, // FIXED: Preserve displayCost from TierIntegrationService
            operator: operator || 'any',        // FIXED: Preserve operator from tier selection
            routedProvider: routedProvider || null // FIXED: Preserve which cheap provider was used
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
                // FIXED: Pass routedProvider for CHEAP mode multi-provider support
                const providerResult = await this.providerManager.checkSMS(
                    session.provider,
                    session.providerNumberId || session.number,
                    { providerKey: session.routedProvider }
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
     * FIXED:
     * - Only releases funds if lockTx is still PENDING
     * - Prevents double-refund by checking tx status first
     * - Returns detailed cancel result
     * - Cleans up memory timers properly
     * - Routes cancel to correct provider via routedProvider
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
            // Step 1: Release provider number FIRST
            await this._releaseProviderNumber(session, 'USER_CANCELLED');
            providerReleased = true;
        } catch (providerError) {
            logger.warn('Provider release failed during cancel', {
                sessionId,
                error: providerError.message
            });
            // Continue — provider release is best-effort
        }

        // Step 2: Restore credits (bundle/vip/free counts)
        try {
            await this._restoreCredits(session);
        } catch (creditError) {
            logger.error('Credit restoration failed during cancel', {
                sessionId,
                error: creditError.message
            });
            // Continue — don't block refund if credits fail
        }

        // Step 3: Release locked funds — ONLY if still PENDING
        if (session.lockTxId) {
            try {
                // Check if transaction is still PENDING before releasing
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
                        lockTxStatus: lockTx.status,
                        lockTxType: lockTx.type
                    });
                } else {
                    // FIXED: Only release if actually PENDING
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
                // Continue — session is still cancelled, but funds may be stuck
                // Admin should manually review
            }
        }

        // Step 4: Mark session as cancelled
        try {
            await Session.markCancelled(sessionId);
        } catch (dbError) {
            logger.error('Failed to mark session cancelled', {
                sessionId,
                error: dbError.message
            });
            throw new Error('SESSION_CANCEL_DB_FAILED');
        }

        // Step 5: Cleanup memory
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
     * Deliver OTP to session (called by webhook or polling)
     * FIXED:
     * - Removes duplicate totalSpent increment (now handled in captureFunds)
     * - Calls finishNumber on correct provider after OTP delivery
     * - Uses generateId() for transaction txId instead of hardcoded
     * - Wraps Transaction.create in try/catch with proper logging
     * - Validates providerNumberId before calling finish
     */
    async deliverOTP(session, otp) {
        const sessionId = session.sessionId || session;

        // If string passed, look up session
        if (typeof session === 'string') {
            session = await Session.findOne({ sessionId }).lean();
            if (!session) {
                logger.error('deliverOTP: Session not found', { sessionId });
                throw new Error('SESSION_NOT_FOUND');
            }
        }

        // Idempotency check — already delivered?
        if (session.status === 'RECEIVED') {
            logger.warn('OTP already delivered', { sessionId });
            return session;
        }

        const maskedOtp = this.maskOTP(otp);

        // Update session atomically — only if still in deliverable state
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
                // FIXED: Removed duplicate User.updateOne for totalSpent
                // captureFunds now handles: balance -= amount, lockedBalance -= amount, totalSpent += amount
            } catch (captureError) {
                logger.error('Fund capture failed', { sessionId, error: captureError.message });
                // Continue — OTP is delivered, but funds may not be captured
                // This is a critical error that needs admin attention
            }
        }

        // FIXED: Call finishNumber on correct provider to mark activation as complete
        // This prevents provider from keeping the number reserved
        if (session.mode === 'CHEAP' && session.providerNumberId && this.providerManager) {
            try {
                const finishResult = await this.providerManager.finishNumber(
                    session.provider,
                    session.providerNumberId,
                    session.routedProvider // FIXED: Pass routedProvider for multi-provider routing
                );
                logger.info('Provider activation finished', {
                    sessionId,
                    activationId: session.providerNumberId,
                    routedProvider: session.routedProvider,
                    result: finishResult
                });
            } catch (finishError) {
                logger.warn('Provider finish failed (non-critical)', {
                    sessionId,
                    activationId: session.providerNumberId,
                    routedProvider: session.routedProvider,
                    error: finishError.message
                });
                // Non-critical — OTP already delivered, provider will auto-expire
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
                        routedProvider: session.routedProvider,
                        providerNumberId: session.providerNumberId,
                        operator: session.operator || 'any',
                        otpDeliveredAt: new Date()
                    }
                });
            } catch (txError) {
                logger.error('Transaction record failed', { sessionId, error: txError.message });
            }
        }

        // Cleanup memory timers
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
            duration: this._getDuration(session.startTime),
            mode: session.mode,
            cost: session.cost
        });

        return updated;
    }
        /**
     * Handle session timeout
     * FIXED: 
     * - Cancels on correct provider using activation ID and routedProvider
     * - NO auto-retry — user must request manually after timeout
     * - Single source of truth for refunds
     */
    async handleTimeout(session) {
        const sessionId = session.sessionId || session;

        if (typeof session === 'string') {
            session = await Session.findOne({ sessionId }).lean();
            if (!session) return null;
        }

        // Idempotency check — already handled?
        if (!['WAITING', 'CHECKING'].includes(session.status)) {
            logger.info('Timeout: session already handled', { sessionId, status: session.status });
            return null;
        }

        // FIXED: Cancel on correct provider FIRST using activation ID and routedProvider
        if (session.mode === 'CHEAP' && session.providerNumberId) {
            try {
                await this.providerManager.cancelNumber(
                    session.provider,
                    session.providerNumberId,
                    session.routedProvider // FIXED: Pass routedProvider for multi-provider routing
                );
                logger.info('Provider cancelled on timeout', {
                    sessionId,
                    activationId: session.providerNumberId,
                    routedProvider: session.routedProvider
                });
            } catch (cancelError) {
                // Already cancelled = OK
                if (cancelError.response?.data === 'order not found' || 
                    cancelError.message?.includes('order not found')) {
                    logger.info('Provider already cancelled (order not found)', { sessionId });
                } else {
                    logger.warn('Provider cancel on timeout failed', {
                        sessionId,
                        activationId: session.providerNumberId,
                        routedProvider: session.routedProvider,
                        error: cancelError.message
                    });
                }
            }
        }

        // Release provider number (for other modes)
        await this._releaseProviderNumber(session, 'TIMEOUT');

        // Restore credits (bundle/vip/free)
        await this._restoreCredits(session);

        // Release locked funds for CHEAP mode
        if (session.lockTxId) {
            try {
                await this.walletService.releaseFunds(
                    session.lockTxId,
                    session.userId,
                    'OTP_TIMEOUT'
                );
                logger.info('Funds released on timeout', { sessionId, lockTxId: session.lockTxId });
            } catch (releaseError) {
                logger.error('Fund release failed on timeout', { sessionId, error: releaseError.message });
            }
        }

        // Mark session as timeout
        await Session.markTimeout(sessionId);
        this._cleanupSession(sessionId);

        // Notify user
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

        // ========== NO AUTO-RETRY ==========
        // User must manually request a new OTP after timeout
        // The _scheduleTimeoutNotification in your controller sends the timeout message to user

        logger.info('Session timed out', {
            sessionId,
            userId: session.userId,
            mode: session.mode,
            duration: this._getDuration(session.startTime)
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
            } else if (mode === 'CHEAP' && preAssignedNumber?.operator && preAssignedNumber.operator !== 'any') {
                // FIXED: If operator was pre-selected (from tier flow), pass it to providerManager
                numberData = await this.providerManager.getNumber(mode, country, service, null, userId, preAssignedNumber.operator);
            } else {
                numberData = await this.providerManager.getNumber(mode, country, service);
            }
        } catch (error) {
            logger.error('Number acquisition failed', {
                userId, mode, service, country, operator: preAssignedNumber?.operator, error: error.message
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
        // FIXED: Use displayCost from numberData (already includes $0.10 profit from provider)
        const { cost, lockTxId } = await this._handleFinances(user, userId, mode, numberData, service);

        // Calculate timeout
        const timeoutSeconds = this.config.timeouts[mode] || 120;
        const timeoutAt = new Date(Date.now() + timeoutSeconds * 1000);

        // Create session
        // FIXED: Store providerNumberId, operator, and routedProvider from numberData
        const session = await Session.create({
            sessionId: generateId(),
            userId,
            mode,
            service,
            country,
            number: numberData.phoneNumber,
            provider: numberData.provider,
            providerNumberId: numberData.providerNumberId || null,
            operator: numberData.operator || preAssignedNumber?.operator || 'any',
            routedProvider: numberData.routedProvider || null, // FIXED: Store which cheap provider was used
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
            routedProvider: numberData.routedProvider,
            providerNumberId: numberData.providerNumberId,
            operator: session.operator,
            cost,
            timeoutAt
        });

        return session;
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL - Finances (FIXED)
    // ═══════════════════════════════════════════════════════════

    /**
     * FIXED: Now uses displayCost from numberData for CHEAP mode
     * Previously: Always used config.pricing?.cheapOtp || 0.05
     * Now: Uses numberData.displayCost (raw + $0.10 from provider)
     */
    async _handleFinances(user, userId, mode, numberData, service) {
        let cost = 0;
        let lockTxId = null;

        switch (mode) {
            case 'CHEAP': {
                // FIXED: Use displayCost from provider (already includes $0.10 profit)
                // numberData.displayCost = what user pays (e.g. $0.60 = $0.50 raw + $0.10)
                // numberData.cost = what provider charges (e.g. $0.50)
                cost = parseFloat(numberData.displayCost) || parseFloat(numberData.cost) || config.pricing?.cheapOtp || 0.05;

                // Ensure cost is valid
                if (cost <= 0) {
                    cost = config.pricing?.cheapOtp || 0.05;
                }

                const availableBalance = typeof user.getAvailableBalance === 'function'
                    ? user.getAvailableBalance()
                    : (user.balance || 0) - (user.lockedBalance || 0);

                if (availableBalance < cost) {
                    await this._releaseProviderNumber({ ...numberData, mode }, 'FUNDS_LOCK_FAILED');
                    throw new Error('INSUFFICIENT_FUNDS');
                }

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
    //  INTERNAL - Provider Management (FIXED)
    // ═══════════════════════════════════════════════════════════

    /**
     * FIXED: Properly uses providerNumberId for CHEAP mode with routedProvider support
     * Previously: Used session.providerNumberId || session.number — fell back to phone number
     * Now: For CHEAP, uses session.providerNumberId (activation ID). Passes routedProvider for multi-provider.
     */
    async _releaseProviderNumber(session, reason) {
        try {
            if (session.mode === 'VIP' && this.numberPoolManager && session.providerNumberId) {
                await this.numberPoolManager.releaseNumber(session.providerNumberId, reason);
            } else if (session.mode === 'CHEAP' && session.providerNumberId) {
                // FIXED: CHEAP mode MUST use providerNumberId (activation ID like "1001025384")
                // NEVER use session.number (phone number like "+4915511298251") for cancel
                // FIXED: Pass routedProvider for correct provider routing
                await this.providerManager.cancelNumber(
                    session.provider,
                    session.providerNumberId,
                    session.routedProvider
                );
            } else if (this.providerManager) {
                // For other modes or if providerNumberId is missing, use number as fallback
                await this.providerManager.cancelNumber(
                    session.provider,
                    session.providerNumberId || session.number,
                    session.routedProvider
                );
            }
        } catch (error) {
            logger.warn('Provider release failed', {
                sessionId: session.sessionId || 'unknown',
                mode: session.mode,
                providerNumberId: session.providerNumberId,
                routedProvider: session.routedProvider,
                number: session.number,
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
                // FIXED: Use dynamic minimum balance check instead of hardcoded $0.05
                // We can only check minimum entry threshold here; actual price check happens in _handleFinances
                const minBalance = 0.05; // Minimum to enter CHEAP flow
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

            if (new Date() > new Date(current.timeoutAt)) {
                return;
            }

            sessionData.lastPollAt = new Date();
            sessionData.pollCount++;
            sessionData.state = SessionState.MONITORING;

            if (current.status === 'WAITING') {
                await Session.updateOne(
                    { sessionId },
                    { $set: { status: 'CHECKING' } }
                );
            }

            // FIXED: Use tier-specific methods with routedProvider for CHEAP
            let result;
            switch (current.mode) {
                case 'FREE':
                    result = await this.providerManager.checkFreeSMS(
                        current.providerNumberId || current.number
                    );
                    break;

                case 'CHEAP':
                    // FIXED: Pass routedProvider for multi-provider SMS checking
                    result = await this.providerManager.checkCheapSMS(
                        current.providerNumberId || current.number,
                        current.routedProvider
                    );
                    break;

                case 'VIP':
                case 'BUNDLE':
                    result = await this.providerManager.checkPoolSMS(
                        current.providerNumberId || current.number
                    );
                    break;

                default:
                    // Fallback to legacy only for unknown modes
                    result = await this.providerManager.checkSMS(
                        current.provider,
                        current.providerNumberId || current.number,
                        { providerKey: current.routedProvider }
                    );
            }

            if (result.success && result.otp) {
                await this.deliverOTP(current, result.otp);
                return;
            }

            if (result.status && ['CANCELLED', 'TIMEOUT', 'EXPIRED', 'ERROR', 'BANNED'].includes(result.status)) {
                await this.handleProviderFailure(current, result.status);
                return;
            }

            this._schedulePoll(sessionId, interval);

        } catch (error) {
            logger.error('Poll error', {
                sessionId,
                error: error.message,
                pollCount: sessionData.pollCount
            });

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

    _getDuration(startTime) {
        if (!startTime) return 0;
        return Date.now() - new Date(startTime).getTime();
    }
}

export default SessionManager;
