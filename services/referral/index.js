
import { User, Referral, Transaction } from '../../models/index.js';
import { generateId } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class ReferralService {
    constructor(walletService = null, notificationService = null) {
        this.walletService = walletService;
        this.notificationService = notificationService;
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL: Send notification to referrer
    // ═══════════════════════════════════════════════════════════

    async _notifyReferrer(referrerId, type, payload) {
        if (!this.notificationService) {
            logger.warn('NotificationService not available, referrer will not be alerted', { referrerId, type });
            return;
        }

        try {
            await this.notificationService.send(referrerId, {
                type,
                ...payload,
                telegramChatId: referrerId, // Telegram chat ID = userId for bot DMs
                timestamp: new Date()
            });
        } catch (notifyError) {
            logger.error('Failed to send referral notification', {
                referrerId,
                type,
                error: notifyError.message
            });
            // Non-blocking: don't throw, just log
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL: Send deposit notification
    // ═══════════════════════════════════════════════════════════

    async _notifyDeposit(referrerId, referredId, depositAmount, status) {
        const messages = {
            PENDING: `🎉 Great news! A new user joined with your referral code. They haven't deposited yet.`,
            DEPOSITED: `💰 Your referral made their first deposit of $${depositAmount.toFixed(2)}! Reward is pending admin approval.`,
            BELOW_MINIMUM: `📉 Your referral deposited $${depositAmount.toFixed(2)}, but it's below the $${config.referral?.minDeposit ?? 5} minimum required for reward.`
        };

        await this._notifyReferrer(referrerId, 'REFERRAL_DEPOSITED', {
            title: 'Referral Update',
            message: messages[status] || 'Referral status updated.',
            referredId,
            depositAmount,
            status
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  TRACK REFERRAL — Called when user joins with referral code
    // ═══════════════════════════════════════════════════════════

    async trackReferral(referredId, referralCode) {
        try {
            if (!referralCode) return null;

            const cleanCode = referralCode.toUpperCase().trim();

            // Find referrer
            const referrer = await User.findOne({ referralCode: cleanCode });
            if (!referrer) {
                logger.warn('Invalid referral code used', { code: cleanCode, referredId });
                return null;
            }

            // Prevent self-referral
            if (referrer.userId === referredId) {
                logger.warn('Self-referral attempt blocked', { userId: referredId });
                return null;
            }

            // Atomic check-and-create to prevent race conditions
            let referral;
            try {
                referral = await Referral.create({
                    referralId: generateId(),
                    referrerId: referrer.userId,
                    referredId,
                    status: 'PENDING',
                    rewardPercentage: config.referral?.percentage ?? 0.05,
                    metadata: {
                        referrerCode: cleanCode,
                        joinedAt: new Date()
                    }
                });
            } catch (createError) {
                // Duplicate key error — referral already exists
                if (createError.code === 11000) {
                    referral = await Referral.findOne({ referredId });
                    logger.info('User already has referral record (race condition handled)', {
                        referredId,
                        status: referral?.status
                    });
                    return referral;
                }
                throw createError;
            }

            // Increment referrer's referral count
            await User.updateOne(
                { userId: referrer.userId },
                { $inc: { referralCount: 1 } }
            );

            // 🔔 NOTIFY REFERRER: New signup
            await this._notifyReferrer(referrer.userId, 'REFERRAL_JOINED', {
                title: '🎉 New Referral!',
                message: `A new user just joined using your referral code! You'll earn ${(referral.rewardPercentage * 100).toFixed(0)}% of their first deposit.`,
                referredId,
                referralId: referral.referralId,
                rewardPercentage: referral.rewardPercentage
            });

            logger.info('Referral tracked', {
                referralId: referral.referralId,
                referrerId: referrer.userId,
                referredId,
                code: cleanCode
            });

            return referral;

        } catch (error) {
            logger.error('Referral tracking failed', { referredId, error: error.message });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  PROCESS DEPOSIT — Called by WalletService when deposit detected
    // ═══════════════════════════════════════════════════════════

    async processDeposit(userId, depositAmount) {
        try {
            // Find pending referral record for this user
            const referral = await Referral.findOne({
                referredId: userId,
                status: 'PENDING'
            });

            if (!referral) {
                // Check if already processed
                const existing = await Referral.findOne({
                    referredId: userId,
                    status: { $in: ['DEPOSITED', 'REWARDED'] }
                });
                if (existing) {
                    logger.debug('Referral already processed', { userId, status: existing.status });
                } else {
                    logger.debug('No referral record found for user', { userId });
                }
                return null;
            }

            const minDeposit = config.referral?.minDeposit ?? 5;

            // Check minimum deposit
            if (depositAmount < minDeposit) {
                logger.info('Deposit below referral minimum', {
                    userId,
                    amount: depositAmount,
                    minimum: minDeposit,
                    referralId: referral.referralId
                });

                // 🔔 NOTIFY: Deposit too small
                await this._notifyDeposit(
                    referral.referrerId,
                    userId,
                    depositAmount,
                    'BELOW_MINIMUM'
                );

                // Still mark as deposited but note it didn't qualify
                await Referral.updateOne(
                    { referralId: referral.referralId },
                    {
                        $set: {
                            status: 'DEPOSITED_INELIGIBLE',
                            firstDepositAmount: depositAmount,
                            firstDepositDate: new Date(),
                            ineligibleReason: `Below minimum deposit: $${depositAmount} < $${minDeposit}`
                        }
                    }
                );

                return null;
            }

            // Prevent duplicate reward
            const existingReward = await Transaction.findOne({
                'metadata.referralId': referral.referralId,
                type: 'REFERRAL_REWARD'
            });

            if (existingReward) {
                logger.warn('Referral reward already exists', {
                    referralId: referral.referralId,
                    existingTxId: existingReward.txId
                });
                return null;
            }

            const rewardAmount = depositAmount * (referral.rewardPercentage || config.referral?.percentage || 0.05);

            // Update referral record
            await Referral.updateOne(
                { referralId: referral.referralId },
                {
                    $set: {
                        status: 'DEPOSITED',
                        firstDepositAmount: depositAmount,
                        firstDepositDate: new Date(),
                        rewardAmount,
                        rewardPercentage: referral.rewardPercentage || config.referral?.percentage || 0.05
                    }
                }
            );

            // Create pending reward transaction
            const rewardTx = await Transaction.create({
                txId: generateId(),
                userId: referral.referrerId,
                type: 'REFERRAL_REWARD',
                amount: rewardAmount,
                currency: 'USD',
                status: 'PENDING',
                metadata: {
                    referralId: referral.referralId,
                    referredUserId: userId,
                    depositAmount,
                    percentage: referral.rewardPercentage || config.referral?.percentage || 0.05,
                    requiresApproval: true,
                    createdAt: new Date()
                }
            });

            // Update referrer pending earnings
            await User.updateOne(
                { userId: referral.referrerId },
                {
                    $inc: { referralRewardsPending: rewardAmount }
                }
            );

            // 🔔 NOTIFY REFERRER: Deposit made, reward pending
            await this._notifyDeposit(
                referral.referrerId,
                userId,
                depositAmount,
                'DEPOSITED'
            );

            logger.info('Referral reward pending approval', {
                referralId: referral.referralId,
                referrerId: referral.referrerId,
                referredId: userId,
                depositAmount,
                rewardAmount,
                rewardTxId: rewardTx.txId
            });

            return {
                referralId: referral.referralId,
                rewardAmount,
                rewardTxId: rewardTx.txId,
                status: 'PENDING_APPROVAL'
            };

        } catch (error) {
            logger.error('Referral deposit processing failed', { userId, depositAmount, error: error.message });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  ADMIN: APPROVE REWARD
    // ═══════════════════════════════════════════════════════════

    async approveReward(txId, adminId) {
        try {
            const tx = await Transaction.findOne({
                txId,
                type: 'REFERRAL_REWARD',
                status: 'PENDING'
            });

            if (!tx) {
                throw new Error('TRANSACTION_NOT_FOUND_OR_ALREADY_PROCESSED');
            }

            const { referralId } = tx.metadata;

            // Credit referrer balance
            await User.updateOne(
                { userId: tx.userId },
                {
                    $inc: {
                        balance: tx.amount,
                        referralEarnings: tx.amount,
                        referralRewardsPending: -tx.amount
                    }
                }
            );

            // Update transaction
            await Transaction.updateOne(
                { txId },
                {
                    $set: {
                        status: 'COMPLETED',
                        approvedBy: adminId,
                        approvedAt: new Date(),
                        'metadata.approved': true
                    }
                }
            );

            // Update referral record
            await Referral.updateOne(
                { referralId },
                {
                    $set: {
                        status: 'REWARDED',
                        rewardedAt: new Date(),
                        rewardTxId: txId
                    }
                }
            );

            // 🔔 NOTIFY REFERRER: Reward approved
            await this._notifyReferrer(tx.userId, 'REFERRAL_REWARDED', {
                title: '✅ Referral Reward Approved!',
                message: `$${tx.amount.toFixed(2)} has been credited to your balance.`,
                amount: tx.amount,
                referralId,
                txId
            });

            logger.info('Referral reward approved', {
                txId,
                referrerId: tx.userId,
                amount: tx.amount,
                adminId
            });

            return {
                success: true,
                referrerId: tx.userId,
                amount: tx.amount,
                status: 'COMPLETED'
            };

        } catch (error) {
            logger.error('Referral approval failed', { txId, error: error.message });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  ADMIN: REJECT REWARD
    // ═══════════════════════════════════════════════════════════

    async rejectReward(txId, adminId, reason) {
        try {
            const tx = await Transaction.findOne({
                txId,
                type: 'REFERRAL_REWARD',
                status: 'PENDING'
            });

            if (!tx) {
                throw new Error('TRANSACTION_NOT_FOUND');
            }

            // Update transaction
            await Transaction.updateOne(
                { txId },
                {
                    $set: {
                        status: 'CANCELLED',
                        approvedBy: adminId,
                        approvedAt: new Date(),
                        'metadata.rejected': true,
                        'metadata.rejectionReason': reason
                    }
                }
            );

            // Remove from referrer pending
            await User.updateOne(
                { userId: tx.userId },
                {
                    $inc: { referralRewardsPending: -tx.amount }
                }
            );

            // Update referral record
            await Referral.updateOne(
                { referralId: tx.metadata.referralId },
                {
                    $set: {
                        status: 'REJECTED',
                        rejectedAt: new Date(),
                        rejectionReason: reason
                    }
                }
            );

            // 🔔 NOTIFY REFERRER: Reward rejected
            await this._notifyReferrer(tx.userId, 'REFERRAL_REJECTED', {
                title: '❌ Referral Reward Rejected',
                message: `Your referral reward of $${tx.amount.toFixed(2)} was rejected. Reason: ${reason}`,
                amount: tx.amount,
                reason,
                txId
            });

            logger.info('Referral reward rejected', {
                txId,
                referrerId: tx.userId,
                reason,
                adminId
            });

            return { success: true, status: 'REJECTED' };

        } catch (error) {
            logger.error('Referral rejection failed', { txId, error: error.message });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  ADMIN: GET PENDING REWARDS
    // ═══════════════════════════════════════════════════════════

    async getPendingRewards(page = 1, limit = 20) {
        try {
            const skip = (page - 1) * limit;

            const [rewards, total] = await Promise.all([
                Transaction.find({
                    type: 'REFERRAL_REWARD',
                    status: 'PENDING'
                })
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .lean(),

                Transaction.countDocuments({
                    type: 'REFERRAL_REWARD',
                    status: 'PENDING'
                })
            ]);

            // Enrich with user data
            const enrichedRewards = await Promise.all(
                rewards.map(async (tx) => {
                    const [referrer, referred] = await Promise.all([
                        User.findOne({ userId: tx.userId }).select('username firstName'),
                        User.findOne({ userId: tx.metadata?.referredUserId }).select('username firstName')
                    ]);

                    return {
                        ...tx,
                        referrer: {
                            userId: tx.userId,
                            username: referrer?.username,
                            name: referrer?.firstName
                        },
                        referred: {
                            userId: tx.metadata?.referredUserId,
                            username: referred?.username,
                            name: referred?.firstName
                        }
                    };
                })
            );

            return {
                rewards: enrichedRewards,
                pagination: {
                    page,
                    limit,
                    total,
                    pages: Math.ceil(total / limit)
                }
            };

        } catch (error) {
            logger.error('Failed to get pending rewards', { error: error.message });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GET USER REFERRAL STATS
    // ═══════════════════════════════════════════════════════════

    async getUserReferralStats(userId) {
        try {
            const [referrer, referrals, earnings] = await Promise.all([
                User.findOne({ userId }).select('referralCode referralCount referralEarnings referralRewardsPending'),
                Referral.find({ referrerId: userId }).sort({ createdAt: -1 }).lean(),
                Transaction.find({
                    userId,
                    type: 'REFERRAL_REWARD',
                    status: 'COMPLETED'
                }).lean()
            ]);

            if (!referrer) {
                throw new Error('USER_NOT_FOUND');
            }

            const totalEarned = earnings.reduce((sum, tx) => sum + (tx.amount || 0), 0);

            return {
                referralCode: referrer.referralCode,
                totalReferrals: referrer.referralCount || 0,
                successfulReferrals: referrals.filter(r => r.status === 'REWARDED').length,
                pendingReferrals: referrals.filter(r => r.status === 'DEPOSITED').length,
                ineligibleReferrals: referrals.filter(r => r.status === 'DEPOSITED_INELIGIBLE').length,
                totalEarned,
                pendingApproval: referrer.referralRewardsPending || 0,
                recentReferrals: referrals.slice(0, 10).map(r => ({
                    referredId: r.referredId,
                    status: r.status,
                    depositAmount: r.firstDepositAmount,
                    rewardAmount: r.rewardAmount,
                    ineligibleReason: r.ineligibleReason,
                    date: r.createdAt
                }))
            };

        } catch (error) {
            logger.error('Failed to get user referral stats', { userId, error: error.message });
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GENERATE REFERRAL LINK
    // ═══════════════════════════════════════════════════════════

    generateReferralLink(botUsername, referralCode) {
        if (!botUsername || !referralCode) {
            throw new Error('BOT_USERNAME_AND_REFERRAL_CODE_REQUIRED');
        }
        return `https://t.me/${botUsername}?start=${referralCode}`;
    }
}

export default ReferralService;

