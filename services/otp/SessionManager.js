import { Session, User, Transaction } from '../../models/index.js';
import { generateId, getDuration } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class SessionManager {
    constructor(providerManager, retryEngine, walletService) {
        this.providerManager = providerManager;
        this.retryEngine = retryEngine;
        this.walletService = walletService;
        this.activeSessions = new Map();
    }

    async createSession(userId, mode, service, country = 'US') {
        // 1. Check existing active session
        const existing = await Session.findOne({
            userId,
            status: { $in: ['WAITING', 'CHECKING'] }
        }).lean();

        if (existing) {
            throw new Error('ACTIVE_SESSION_EXISTS');
        }

        // 2. Fetch user as Mongoose doc for instance methods
        const user = await User.findOne({ userId });
        if (!user) throw new Error('USER_NOT_FOUND');
        if (user.isBlacklisted) throw new Error('USER_BLACKLISTED');

        // 3. Mode validation
        await this.validateModeAccess(user, mode);

        // 4. Validate service exists
        const validServices = config.services || [
            'WhatsApp', 'Telegram', 'Facebook', 'Instagram', 'Twitter',
            'TikTok', 'Binance', 'Coinbase', 'Gmail', 'Outlook',
            'Netflix', 'Amazon', 'PayPal', 'Snapchat', 'Discord'
        ];
        if (!validServices.includes(service)) {
            throw new Error('INVALID_SERVICE');
        }

        // 5. ACQUIRE NUMBER FIRST (before locking funds)
        let numberData;
        try {
            numberData = await this.providerManager.getNumber(mode, country, service);
        } catch (error) {
            logger.error('Number acquisition failed', { userId, mode, service, country, error: error.message });
            throw new Error('NUMBER_UNAVAILABLE: ' + error.message);
        }

        // 6. VALIDATE number is real (not "0201" or similar fakes)
        if (!numberData.phoneNumber || numberData.phoneNumber.length < 7) {
            logger.error('Invalid phone number received', { userId, phone: numberData.phoneNumber, provider: numberData.provider });
            throw new Error('INVALID_NUMBER_FROM_PROVIDER');
        }

        // 7. Lock funds ONLY for CHEAP mode (AFTER number acquired)
        let cost = 0;
        let lockTxId = null;

        if (mode === 'CHEAP') {
            cost = config.pricing?.cheapOtp || 0.05;
            try {
                lockTxId = await this.walletService.lockFunds(userId, cost, `OTP_${service}`);
            } catch (error) {
                // Release the number since we can't pay
                try {
                    await this.providerManager.cancelNumber(numberData.provider, numberData.providerNumberId || numberData.phoneNumber);
                } catch (e) { /* ignore */ }
                throw new Error('INSUFFICIENT_FUNDS');
            }
        }

        // 8. Deduct bundle credit for BUNDLE mode
        if (mode === 'BUNDLE') {
            const bundleRemaining = user.bundleRemaining || 0;
            if (bundleRemaining <= 0) {
                // Release number
                try {
                    await this.providerManager.cancelNumber(numberData.provider, numberData.providerNumberId || numberData.phoneNumber);
                } catch (e) { /* ignore */ }
                throw new Error('BUNDLE_EMPTY');
            }
            await User.updateOne({ userId }, { $inc: { bundleRemaining: -1 } });
        }

        // 9. Increment VIP usage for VIP mode
        if (mode === 'VIP') {
            await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });
        }

        // 10. Increment FREE usage
        if (mode === 'FREE') {
            await User.updateOne({ userId }, { $inc: { freeUsedToday: 1 } });
        }

        // 11. Create session
        const timeoutSeconds = mode === 'FREE' ? 120 : mode === 'CHEAP' ? 180 : 60;
        
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
            timeoutAt: new Date(Date.now() + timeoutSeconds * 1000),
            cost,
            lockTxId,
            maxRetries: mode === 'CHEAP' ? 2 : 0
        });

        // 12. Store in memory and start monitoring
        this.activeSessions.set(session.sessionId, {
            session,
            providerInstance: numberData.providerInstance,
            pollTimer: null
        });

        this.startMonitoring(session);

        logger.info('Session created', {
            sessionId: session.sessionId,
            userId,
            mode,
            number: session.number.slice(-4),
            provider: numberData.provider
        });

        return session;
    }

    async validateModeAccess(user, mode) {
        if (mode === 'FREE') {
            if (!user.canUseFree || !user.canUseFree()) {
                throw new Error('FREE_LIMIT_REACHED');
            }
        }

        if (mode === 'CHEAP') {
            const minBalance = config.pricing?.cheapOtp || 0.05;
            if (!user.getAvailableBalance || user.getAvailableBalance() < minBalance) {
                throw new Error('INSUFFICIENT_BALANCE');
            }
        }

        if (mode === 'VIP') {
            if (!user.isVipActive || !user.isVipActive()) {
                throw new Error('VIP_EXPIRED');
            }
            if (!user.canUseVip || !user.canUseVip()) {
                throw new Error('VIP_DAILY_LIMIT_REACHED');
            }
        }

        if (mode === 'BUNDLE') {
            if ((user.bundleRemaining || 0) <= 0) {
                throw new Error('BUNDLE_EMPTY');
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
                const current = await Session.findOne({ 
                    sessionId: session.sessionId 
                }).lean();

                if (!current || current.status !== 'WAITING') {
                    this.cleanupSession(session.sessionId);
                    return;
                }

                if (new Date() > new Date(current.timeoutAt)) {
                    await this.handleTimeout(current);
                    return;
                }

                const result = await this.providerManager.checkSMS(
                    current.provider,
                    current.providerNumberId || current.number
                );

                if (result.success && result.otp) {
                    await this.deliverOTP(current, result.otp);
                    return;
                }

                sessionData.pollTimer = setTimeout(checkOTP, pollInterval);

            } catch (error) {
                logger.error('Monitoring error', {
                    sessionId: session.sessionId,
                    error: error.message
                });
                sessionData.pollTimer = setTimeout(checkOTP, pollInterval);
            }
        };

        sessionData.pollTimer = setTimeout(checkOTP, pollInterval);
    }

    async deliverOTP(session, otp) {
        const sessionData = this.activeSessions.get(session.sessionId);
        
        await Session.updateOne(
            { sessionId: session.sessionId },
            {
                $set: {
                    status: 'RECEIVED',
                    otpCode: otp,
                    maskedOtp: this.maskOTP(otp),
                    endTime: new Date()
                }
            }
        );

        if (session.mode === 'CHEAP' && session.lockTxId) {
            await this.walletService.captureFunds(session.lockTxId, session.userId);
        }

        if (session.mode === 'CHEAP') {
            await User.updateOne(
                { userId: session.userId },
                { $inc: { totalSpent: session.cost } }
            );
        }

        this.cleanupSession(session.sessionId);

        logger.info('OTP delivered', {
            sessionId: session.sessionId,
            userId: session.userId,
            duration: getDuration(session.startTime)
        });

        return session;
    }

    async handleTimeout(session) {
        // Release locked funds for CHEAP
        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                session.userId,
                'OTP_TIMEOUT'
            );
        }

        // Restore bundle credit for BUNDLE
        if (session.mode === 'BUNDLE') {
            await User.updateOne(
                { userId: session.userId },
                { $inc: { bundleRemaining: 1 } }
            );
        }

        // Restore VIP usage for VIP (decrement)
        if (session.mode === 'VIP') {
            await User.updateOne(
                { userId: session.userId },
                { $inc: { vipDailyUsed: -1 } }
            );
        }

        // Restore FREE usage
        if (session.mode === 'FREE') {
            await User.updateOne(
                { userId: session.userId },
                { $inc: { freeUsedToday: -1 } }
            );
        }

        await Session.updateOne(
            { sessionId: session.sessionId },
            {
                $set: {
                    status: 'TIMEOUT',
                    endTime: new Date()
                }
            }
        );

        // Retry for CHEAP mode
        if (session.mode === 'CHEAP' && session.retryCount < session.maxRetries) {
            // Retry logic here if needed
        }

        this.cleanupSession(session.sessionId);

        logger.info('Session timed out', {
            sessionId: session.sessionId,
            userId: session.userId
        });
    }

    async cancelSession(sessionId, userId) {
        const session = await Session.findOne({ sessionId, userId });
        if (!session) throw new Error('SESSION_NOT_FOUND');
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

        // Restore bundle credit
        if (session.mode === 'BUNDLE') {
            await User.updateOne(
                { userId },
                { $inc: { bundleRemaining: 1 } }
            );
        }

        // Restore VIP usage
        if (session.mode === 'VIP') {
            await User.updateOne(
                { userId },
                { $inc: { vipDailyUsed: -1 } }
            );
        }

        // Restore FREE usage
        if (session.mode === 'FREE') {
            await User.updateOne(
                { userId },
                { $inc: { freeUsedToday: -1 } }
            );
        }

        // Cancel with provider
        try {
            await this.providerManager.cancelNumber(
                session.provider,
                session.providerNumberId || session.number
            );
        } catch (error) {
            logger.warn('Provider cancel failed', { sessionId, error: error.message });
        }

        await Session.updateOne(
            { sessionId },
            {
                $set: {
                    status: 'CANCELLED',
                    endTime: new Date()
                }
            }
        );

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
        return Session.findOne({
            userId,
            status: { $in: ['WAITING', 'CHECKING'] }
        }).lean();
    }
}

export default SessionManager;
