import mongoose from 'mongoose';

const referralSchema = new mongoose.Schema({
    // ─── Primary ID ───
    referralId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    
    // ─── Referrer (who invited) ───
    referrerId: {
        type: String,
        required: true,
        index: true
    },
    
    // ─── Referred (who joined) ───
    referredId: {
        type: String,
        required: true,
        unique: true    // ← Auto-creates unique index. NO separate schema.index() for this!
    },
    
    // ─── Status ───
    status: {
        type: String,
        enum: ['PENDING', 'DEPOSITED', 'REWARDED', 'REJECTED'],
        default: 'PENDING',
        index: true
    },
    
    // ─── Deposit tracking ───
    firstDepositAmount: {
        type: Number,
        default: 0
    },
    firstDepositDate: {
        type: Date,
        default: null
    },
    
    // ─── Reward ───
    rewardAmount: {
        type: Number,
        default: 0
    },
    rewardPercentage: {
        type: Number,
        default: 0
    },
    rewardTxId: {
        type: String,
        default: null
    },
    rewardedAt: {
        type: Date,
        default: null
    },
    
    // ─── Admin approval ───
    approvedBy: {
        type: String,
        default: null
    },
    approvedAt: {
        type: Date,
        default: null
    },
    
    // ─── Metadata ───
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: true
});

// ═══════════════════════════════════════════════════════════
//  COMPOUND INDEXES ONLY — Single-field indexes use inline
// ═══════════════════════════════════════════════════════════

// For admin queries: find all referrals by a referrer, filtered by status
referralSchema.index({ referrerId: 1, status: 1, createdAt: -1 });

// For finding pending referrals across all referrers (admin dashboard)
referralSchema.index({ status: 1, createdAt: -1 });

// For reward processing: find referrals awaiting reward after deposit
referralSchema.index({ status: 1, firstDepositDate: 1 });

// ═══════════════════════════════════════════════════════════
//  STATICS
// ═══════════════════════════════════════════════════════════

/**
 * Get pending referrals for admin review
 */
referralSchema.statics.getPending = async function(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [referrals, total] = await Promise.all([
        this.find({ status: 'PENDING' })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        this.countDocuments({ status: 'PENDING' })
    ]);
    return { referrals, total, page, pages: Math.ceil(total / limit) };
};

/**
 * Mark referral as deposited (triggered by deposit scanner)
 */
referralSchema.statics.markDeposited = async function(referredId, amount) {
    return this.findOneAndUpdate(
        { referredId, status: 'PENDING' },
        {
            $set: {
                status: 'DEPOSITED',
                firstDepositAmount: amount,
                firstDepositDate: new Date()
            }
        },
        { new: true }
    );
};

/**
 * Approve and reward a referral
 */
referralSchema.statics.approveReward = async function(referralId, adminId, txId) {
    const referral = await this.findOne({ referralId, status: 'DEPOSITED' });
    if (!referral) throw new Error('REFERRAL_NOT_FOUND_OR_NOT_DEPOSITED');

    referral.status = 'REWARDED';
    referral.rewardTxId = txId;
    referral.rewardedAt = new Date();
    referral.approvedBy = adminId;
    referral.approvedAt = new Date();
    
    await referral.save();
    return referral;
};

/**
 * Reject a referral
 */
referralSchema.statics.rejectReferral = async function(referralId, adminId) {
    return this.findOneAndUpdate(
        { referralId, status: { $in: ['PENDING', 'DEPOSITED'] } },
        {
            $set: {
                status: 'REJECTED',
                approvedBy: adminId,
                approvedAt: new Date()
            }
        },
        { new: true }
    );
};

/**
 * Get referral stats for a user
 */
referralSchema.statics.getStats = async function(referrerId) {
    const [total, pending, deposited, rewarded, rejected, totalEarnings] = await Promise.all([
        this.countDocuments({ referrerId }),
        this.countDocuments({ referrerId, status: 'PENDING' }),
        this.countDocuments({ referrerId, status: 'DEPOSITED' }),
        this.countDocuments({ referrerId, status: 'REWARDED' }),
        this.countDocuments({ referrerId, status: 'REJECTED' }),
        this.aggregate([
            { $match: { referrerId, status: 'REWARDED' } },
            { $group: { _id: null, total: { $sum: '$rewardAmount' } } }
        ])
    ]);

    return {
        total,
        pending,
        deposited,
        rewarded,
        rejected,
        totalEarnings: totalEarnings[0]?.total || 0
    };
};

// ═══════════════════════════════════════════════════════════
//  INSTANCE METHODS
// ═══════════════════════════════════════════════════════════

referralSchema.methods.isRewardable = function() {
    return this.status === 'DEPOSITED' && this.firstDepositAmount > 0;
};

referralSchema.methods.canBeRejected = function() {
    return ['PENDING', 'DEPOSITED'].includes(this.status);
};

const Referral = mongoose.model('Referral', referralSchema);

export default Referral;
