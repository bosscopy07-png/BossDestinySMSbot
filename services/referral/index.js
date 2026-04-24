import { User, Referral, Transaction } from '../../models/index.js';
import { generateId } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class ReferralService {
    constructor(walletService) {
        this.walletService = walletService;
    }

    // Create referral record when user joins with referral code
    async trackReferral(referredId, referralCode) {
        try {
            if (!referralCode) return null;

            // Find referrer
            const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
            if (!referrer) {
                logger.warn('Invalid referral code used', { code: referralCode, referredId });
                return null;
            }

            // Prevent self-referral
            if (referrer.userId === referredId) {
                logger.warn('Self-referral attempt blocked', { userId: referredId });
                return null;
            }

            // Check if already referred
            const existing = await Referral.findOne({ referredId });
            if (existing) {
                logger.info('User already has referral record', { referredId });
                return existing;
            }

            // Create referral record
            const referral = await Referral.create({
                referralId: generateId(),
                referrerId: referrer.userId,
                referredId,
                status: 'PENDING',
                rewardPercentage: config.referral.percentage,
                metadata: {
                    referrerCode: referralCode,
                    joinedAt: new Date()
                }
            });

            logger.info('Referral tracked', {
                referralId: referral.referralId,
                referrerId: referrer.userId,
                referredId
            });

            return referral;

        } catch (error) {
            logger.error('Referral tracking failed', { referredId, error: error.message });
            throw error;
        }
    }

    // Process deposit and check for referral reward
    async processDeposit(userId, depositAmount) {
        try {
            // Find referral record
            const referral = await Referral.findOne({
                referredId: userId,
                status: 'PENDING'
            });

            if (!referral) return null;

            // Check minimum deposit
            if (depositAmount < config.referral.minDeposit) {
                logger.info('Deposit below referral minimum', {
                    userId,
                    amount: depositAmount,
                    minimum: config.referral.minDeposit
                });
                return null;
            }

            // Calculate reward
            const rewardAmount = depositAmount * referral.rewardPercentage;

            // Update referral record
            await Referral.updateOne(
                { referralId: referral.referralId },
                {
                    $set: {
                        status: 'DEPOSITED',
                        firstDepositAmount: depositAmount,
                        firstDepositDate: new Date(),
                        rewardAmount,
                        rewardPercentage: referral.rewardPercentage
                    }
                }
            );

            // Create pending reward transaction (requires admin approval)
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
                    percentage: referral.rewardPercentage,
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

            logger.info('Referral reward pending approval', {
                referralId: referral.referralId,
                referrerId: referral.referrerId,
                amount: rewardAmount,
                rewardTxId: rewardTx.txId
            });

            return {
                referralId: referral.referralId,
                rewardAmount,
                rewardTxId: rewardTx.txId,
                status: 'PENDING_APPROVAL'
            };

        } catch (error) {
            logger.error('Referral deposit processing failed', { userId, error: error.message });
            throw error;
        }
    }

    // Admin: Approve referral reward
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

            const { referralId, referredUserId } = tx.metadata;

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

    // Admin: Reject referral reward
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

    // Get pending rewards for admin review
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
                        User.findOne({ userId: tx.metadata.referredUserId }).select('username firstName')
                    ]);

                    return {
                        ...tx,
                        referrer: {
                            userId: tx.userId,
                            username: referrer?.username,
                            name: referrer?.firstName
                        },
                        referred: {
                            userId: tx.metadata.referredUserId,
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

    // Get user's referral stats
    async getUserReferralStats(userId) {
        try {
            const [referrer, referrals, earnings] = await Promise.all([
                User.findOne({ userId }).select('referralCode referralCount referralEarnings referralRewardsPending'),
                Referral.find({ referrerId: userId }).sort({ createdAt: -1 }),
                Transaction.find({
                    userId,
                    type: 'REFERRAL_REWARD',
                    status: 'COMPLETED'
                })
            ]);

            const totalEarned = earnings.reduce((sum, tx) => sum + tx.amount, 0);

            return {
                referralCode: referrer.referralCode,
                totalReferrals: referrer.referralCount,
                successfulReferrals: referrals.filter(r => r.status === 'REWARDED').length,
                pendingReferrals: referrals.filter(r => r.status === 'DEPOSITED').length,
                totalEarned,
                pendingApproval: referrer.referralRewardsPending,
                recentReferrals: referrals.slice(0, 10).map(r => ({
                    referredId: r.referredId,
                    status: r.status,
                    depositAmount: r.firstDepositAmount,
                    rewardAmount: r.rewardAmount,
                    date: r.createdAt
                }))
            };

        } catch (error) {
            logger.error('Failed to get user referral stats', { userId, error: error.message });
            throw error;
        }
    }

    // Generate referral link
    generateReferralLink(botUsername, referralCode) {
        return `https://t.me/${botUsername}?start=${referralCode}`;
    }
}

export default ReferralService;

 
