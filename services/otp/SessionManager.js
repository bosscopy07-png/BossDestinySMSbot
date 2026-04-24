import { Session, User, Transaction } from '../../models/index.js';
import { generateId, getDuration } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class SessionManager {
    constructor(providerManager, retryEngine, walletService) {
        this.providerManager = providerManager;
        this.retryEngine = retryEngine;
        this.walletService = walletService;
        this.activeSessions = new Map(); // In-memory tracking
    }

    async createSession(userId, mode, service, country = 'US') {
        // Check for existing active session
        const existing = await Session.findOne({
            userId,
            status: { $in: ['WAITING', 'CHECKING'] }
        });

        if (existing) {
            throw new Error('ACTIVE_SESSION_EXISTS');
        }

        // Validate user can use this mode
        const user = await User.findOne({ userId });
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }

        if (user.isBlacklisted) {
            throw new Error('USER_BLACKLISTED');
        }

        // Mode-specific validation
        await this.validateModeAccess(user, mode);

        // Calculate cost and lock funds
        let cost = 0;
        let lockTxId = null;

        if (mode === 'CHEAP') {
            cost = config.pricing.cheapOtp;
            lockTxId = await this.walletService.lockFunds(userId, cost, `OTP_${service}`);
        } else if (mode === 'VIP') {
            if (!user.isVipActive()) {
                throw new Error('VIP_EXPIRED');
            }
            if (!user.canUseVip()) {
                throw new Error('VIP_DAILY_LIMIT_REACHED');
            }
        }

        // Get number from provider
        const numberData = await this.providerManager.getNumber(mode, country, service);

        // Create session
        const timeoutSeconds = mode === 'FREE' ? 120 : mode === 'CHEAP' ? 180 : 60;
        
        const session = await Session.create({
            sessionId: generateId(),
            userId,
            mode,
            service,
            country,
            number: numberData.phoneNumber,
            provider: numberData.provider,
            status: 'WAITING',
            startTime: new Date(),
            timeoutAt: new Date(Date.now() + timeoutSeconds * 1000),
            cost,
            lockTxId,
            maxRetries: mode === 'CHEAP' ? 2 : mode === 'VIP' ? 1 : 0
        });

        // Store in memory for fast access
        this.activeSessions.set(session.sessionId, {
            session,
            providerInstance: numberData.providerInstance,
            pollTimer: null
        });

        // Start monitoring
        this.startMonitoring(session);

        logger.info('Session created', {
            sessionId: session.sessionId,
            userId,
            mode,
            number: session.number.slice(-4)
        });

        return session;
    }

    async validateModeAccess(user, mode) {
        if (mode === 'FREE') {
            if (!user.canUseFree()) {
                throw new Error('FREE_LIMIT_REACHED');
            }
        }

        if (mode === 'CHEAP') {
            const minBalance = 0.50; // Minimum to start
            if (user.getAvailableBalance() < minBalance) {
                throw new Error('INSUFFICIENT_BALANCE');
            }
        }
    }

    startMonitoring(session) {
        const sessionData = this.activeSessions.get(session.sessionId);
        if (!sessionData) return;

        const pollInterval = session.mode === 'VIP' ? 1000 : 
                            session.mode === 'CHEAP' ? 5000 : 10000;

        const checkOTP = async () => {
            try {
                // Check if session still active
                const current = await Session.findOne({ sessionId: session.sessionId });
                if (!current || current.status !== 'WAITING') {
                    this.cleanupSession(session.sessionId);
                    return;
                }

                // Check timeout
                if (new Date() > current.timeoutAt) {
                    await this.handleTimeout(current);
                    return;
                }

                // Poll for OTP
                const result = await this.providerManager.checkSMS(
                    current.provider,
                    current.provider === 'CHEAP_PANEL' 
                        ? current.number // Actually activationId stored differently
                        : current.number
                );

                if (result.success && result.otp) {
                    await this.deliverOTP(current, result.otp);
                    return;
                }

                // Schedule next check
                sessionData.pollTimer = setTimeout(checkOTP, pollInterval);

            } catch (error) {
                logger.error('Monitoring error', {
                    sessionId: session.sessionId,
                    error: error.message
                });
                sessionData.pollTimer = setTimeout(checkOTP, pollInterval);
            }
        };

        // Start first check
        sessionData.pollTimer = setTimeout(checkOTP, pollInterval);
    }

    async deliverOTP(session, otp) {
        const sessionData = this.activeSessions.get(session.sessionId);
        
        // Update session
        session.status = 'RECEIVED';
        session.otpCode = otp;
        session.maskedOtp = this.maskOTP(otp);
        session.endTime = new Date();
        await session.save();

        // Capture funds if paid mode
        if (session.mode === 'CHEAP' && session.lockTxId) {
            await this.walletService.captureFunds(session.lockTxId, session.userId);
        }

        // Update user stats
        await User.updateOne(
            { userId: session.userId },
            {
                $inc: {
                    totalSpent: session.cost,
                    [`${session.mode.toLowerCase()}UsedToday`]: 1
                }
            }
        );

        // Cleanup
        this.cleanupSession(session.sessionId);

        logger.info('OTP delivered', {
            sessionId: session.sessionId,
            userId: session.userId,
            duration: getDuration(session.startTime)
        });

        return session;
    }

    async handleTimeout(session) {
        // Release locked funds
        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                session.userId,
                'OTP_TIMEOUT'
            );
        }

        // Update session
        session.status = 'TIMEOUT';
        session.endTime = new Date();
        await session.save();

        // Retry logic for CHEAP
        if (session.mode === 'CHEAP' && session.retryCount < session.maxRetries) {
            const retryResult = await this.retryEngine.executeWithRetry(
                session,
                async () => {
                    // Try to get new number
                    const newNumber = await this.providerManager.getNumber(
                        session.mode,
                        session.country,
                        session.service
                    );
                    return { success: true, number: newNumber };
                }
            );

            if (retryResult.success) {
                // Create new session with retry
                session.retryCount++;
                session.number = retryResult.result.number.phoneNumber;
                session.provider = retryResult.result.number.provider;
                session.status = 'WAITING';
                session.startTime = new Date();
                session.timeoutAt = new Date(Date.now() + 180 * 1000);
                await session.save();

                // Restart monitoring
                this.startMonitoring(session);
                return;
            }
        }

        // Final timeout
        this.cleanupSession(session.sessionId);

        logger.info('Session timed out', {
            sessionId: session.sessionId,
            userId: session.userId,
            retries: session.retryCount
        });
    }

    async cancelSession(sessionId, userId) {
        const session = await Session.findOne({ sessionId, userId });
        if (!session) {
            throw new Error('SESSION_NOT_FOUND');
        }

        if (!['WAITING', 'CHECKING'].includes(session.status)) {
            throw new Error('SESSION_NOT_CANCELLABLE');
        }

        // Release funds
        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                userId,
                'USER_CANCELLED'
            );
        }

        // Release number
        await this.providerManager.cancelNumber(session.provider, session.number);

        // Update session
        session.status = 'CANCELLED';
        session.endTime = new Date();
        await session.save();

        this.cleanupSession(sessionId);

        logger.info('Session cancelled by user', { sessionId, userId });

        return session;
    }

    cleanupSession(sessionId) {
        const sessionData = this.activeSessions.get(sessionId);
        if (sessionData) {
            if (sessionData.pollTimer) {
                clearTimeout(sessionData.pollTimer);
            }
            this.activeSessions.delete(sessionId);
        }
    }

    maskOTP(otp) {
        if (!otp || otp.length <= 3) return '***';
        return '*'.repeat(otp.length - 3) + otp.slice(-3);
    }

    async getActiveSession(userId) {
        return await Session.findOne({
            userId,
            status: { $in: ['WAITING', 'CHECKING'] }
        });
    }
}

export default SessionManager;

 
