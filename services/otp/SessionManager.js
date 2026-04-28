import { Session, User, Transaction } from '../../models/index.js';
import { generateId, getDuration } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class SessionManager {
    constructor(providerManager, retryEngine, walletService, numberPoolManager = null) {
        this.providerManager = providerManager;
        this.retryEngine = retryEngine;
        this.walletService = walletService;
        this.numberPoolManager = numberPoolManager;
        this.activeSessions = new Map();
        this.sessionTimeouts = new Map();
    }

    async createSession(userId, mode, service, country = 'US') {
        const existing = await Session.findOne({
            userId,
            status: { $in: ['WAITING', 'CHECKING'] }
        }).lean();

        if (existing) {
            logger.warn('Active session exists', { userId, existingSessionId: existing.sessionId });
            throw new Error('ACTIVE_SESSION_EXISTS');
        }

        const user = await User.findOne({ userId });
        if (!user) throw new Error('USER_NOT_FOUND');
        if (user.isBlacklisted) throw new Error('USER_BLACKLISTED');

        await this.validateModeAccess(user, mode);

        const validServices = config.services || [
            'WhatsApp', 'Telegram', 'Facebook', 'Instagram', 'Twitter',
            'TikTok', 'Binance', 'Coinbase', 'Gmail', 'Outlook',
            'Netflix', 'Amazon', 'PayPal', 'Snapchat', 'Discord'
        ];
        if (!validServices.includes(service)) {
            throw new Error('INVALID_SERVICE');
        }

        let numberData;
        try {
            if (mode === 'VIP' && this.numberPoolManager) {
                numberData = await this.numberPoolManager.acquireNumber(country, service, userId);
            } else {
                numberData = await this.providerManager.getNumber(mode, country, service);
            }
        } catch (error) {
            logger.error('Number acquisition failed', { userId, mode, service, country, error: error.message });
            throw new Error('NUMBER_UNAVAILABLE: ' + error.message);
        }

        if (!numberData.phoneNumber || numberData.phoneNumber.length < 7) {
            logger.error('Invalid phone number received', { userId, phone: numberData.phoneNumber, provider: numberData.provider });
            throw new Error('INVALID_NUMBER_FROM_PROVIDER');
        }

        let cost = 0;
        let lockTxId = null;

        if (mode === 'CHEAP') {
            cost = config.pricing?.cheapOtp || 0.05;
            try {
                lockTxId = await this.walletService.lockFunds(userId, cost, `OTP_${service}`);
            } catch (error) {
                try {
                    await this.releaseNumber(numberData, mode);
                } catch (e) { /* ignore */ }
                throw new Error('INSUFFICIENT_FUNDS');
            }
        }

        if (mode === 'BUNDLE') {
            const bundleRemaining = user.bundleRemaining || 0;
            if (bundleRemaining <= 0) {
                try {
                    await this.releaseNumber(numberData, mode);
                } catch (e) { /* ignore */ }
                throw new Error('BUNDLE_EMPTY');
            }
            await User.updateOne({ userId }, { $inc: { bundleRemaining: -1 } });
        }

        if (mode === 'VIP') {
            await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });
        }

        if (mode === 'FREE') {
            await User.updateOne({ userId }, { $inc: { freeUsedToday: 1 } });
        }

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

        this.activeSessions.set(session.sessionId, {
            session,
            providerInstance: numberData.providerInstance,
            pollTimer: null,
            lastPollAt: null
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

    async releaseNumber(numberData, mode) {
        if (mode === 'VIP' && this.numberPoolManager) {
            await this.numberPoolManager.releaseNumber(numberData.providerNumberId, 'FUNDS_LOCK_FAILED');
        } else {
            await this.providerManager.cancelNumber(numberData.provider, numberData.providerNumberId || numberData.phoneNumber);
        }
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

        const timeoutAt = new Date(session.timeoutAt);

        this.sessionTimeouts.set(session.sessionId, setTimeout(async () => {
            try {
                const current = await Session.findOne({ sessionId: session.sessionId }).lean();
                if (current && ['WAITING', 'CHECKING'].includes(current.status)) {
                    await this.handleTimeout(current);
                }
            } catch (e) {
                logger.error('Timeout handler error', { sessionId: session.sessionId, error: e.message });
            }
        }, timeoutAt - Date.now()));

        const checkOTP = async () => {
            try {
                const current = await Session.findOne({
                    sessionId: session.sessionId
                }).lean();

                if (!current || !['WAITING', 'CHECKING'].includes(current.status)) {
                    this.cleanupSession(session.sessionId);
                    return;
                }

                if (new Date() > new Date(current.timeoutAt)) {
                    return;
                }

                sessionData.lastPollAt = new Date();

                const result = await this.providerManager.checkSMS(
                    current.provider,
                    current.providerNumberId || current.number
                );

                if (result.success && result.otp) {
                    await this.deliverOTP(current, result.otp);
                    return;
                }

                if (result.status === 'CANCELLED' || result.status === 'TIMEOUT') {
                    await this.handleProviderFailure(current, result.status);
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

    async handleProviderFailure(session, providerStatus) {
        const statusMap = {
            'CANCELLED': 'CANCELLED',
            'TIMEOUT': 'TIMEOUT'
        };
        const finalStatus = statusMap[providerStatus] || 'FAILED';

        if (session.lockTxId) {
            await this.walletService.releaseFunds(session.lockTxId, session.userId, `PROVIDER_${providerStatus}`);
        }

        if (session.mode === 'BUNDLE') {
            await User.updateOne({ userId: session.userId }, { $inc: { bundleRemaining: 1 } });
        }

        if (session.mode === 'VIP') {
            await User.updateOne({ userId: session.userId }, { $inc: { vipDailyUsed: -1 } });
        }

        if (session.mode === 'FREE') {
            await User.updateOne({ userId: session.userId }, { $inc: { freeUsedToday: -1 } });
        }

        await Session.updateOne(
            { sessionId: session.sessionId },
            {
                $set: {
                    status: finalStatus,
                    endTime: new Date()
                }
            }
        );

        this.cleanupSession(session.sessionId);

        logger.info('Session ended due to provider failure', {
            sessionId: session.sessionId,
            userId: session.userId,
            providerStatus,
            finalStatus
        });
    }

    async handleTimeout(session) {
        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                session.userId,
                'OTP_TIMEOUT'
            );
        }

        if (session.mode === 'BUNDLE') {
            await User.updateOne(
                { userId: session.userId },
                { $inc: { bundleRemaining: 1 } }
            );
        }

        if (session.mode === 'VIP') {
            await User.updateOne(
                { userId: session.userId },
                { $inc: { vipDailyUsed: -1 } }
            );
        }

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

        if (session.mode === 'CHEAP' && session.retryCount < session.maxRetries) {
            logger.info('Retrying CHEAP session', { sessionId: session.sessionId, retryCount: session.retryCount + 1 });
            try {
                await Session.updateOne({ sessionId: session.sessionId }, { $inc: { retryCount: 1 } });
                const newSession = await this.createSession(session.userId, session.mode, session.service, session.country);
                return { retried: true, newSessionId: newSession.sessionId };
            } catch (e) {
                logger.error('Retry failed', { sessionId: session.sessionId, error: e.message });
            }
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

        if (session.lockTxId) {
            await this.walletService.releaseFunds(
                session.lockTxId,
                userId,
                'USER_CANCELLED'
            );
        }

        if (session.mode === 'BUNDLE') {
            await User.updateOne(
                { userId },
                { $inc: { bundleRemaining: 1 } }
            );
        }

        if (session.mode === 'VIP') {
            await User.updateOne(
                { userId },
                { $inc: { vipDailyUsed: -1 } }
            );
        }

        if (session.mode === 'FREE') {
            await User.updateOne(
                { userId },
                { $inc: { freeUsedToday: -1 } }
            );
        }

        try {
            if (session.mode === 'VIP' && this.numberPoolManager) {
                await this.numberPoolManager.releaseNumber(session.providerNumberId, 'USER_CANCELLED');
            } else {
                await this.providerManager.cancelNumber(
                    session.provider,
                    session.providerNumberId || session.numbero
                );
            }
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

        const timeoutTimer = this.sessionTimeouts.get(sessionId);
        if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            this.sessionTimeouts.delete(sessionId);
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
            otpCode: session.status === 'RECEIVED' ? session.maskedOtp : null
        };
    }

    maskPhone(phone) {
        if (!phone || phone.length < 4) return '****';
        return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
    }

    async getActiveCount() {
        return Session.countDocuments({ status: { $in: ['WAITING', 'CHECKING'] } });
    }

    getMemoryStats() {
        return {
            activeSessions: this.activeSessions.size,
            sessionTimeouts: this.sessionTimeouts.size,
            sessionIds: Array.from(this.activeSessions.keys())
        };
    }
}

export default SessionManager;
                
