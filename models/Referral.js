import mongoose from 'mongoose';

const referralSchema = new mongoose.Schema({
    referralId: {
        type: String,
        required: true,
        unique: true
    },
    
    // Referrer (who invited)
    referrerId: {
        type: String,
        required: true,
        index: true
    },
    
    // Referred (who joined)
    referredId: {
        type: String,
        required: true,
        unique: true
    },
    
    // Status
    status: {
        type: String,
        enum: ['PENDING', 'DEPOSITED', 'REWARDED', 'REJECTED'],
        default: 'PENDING'
    },
    
    // Deposit tracking
    firstDepositAmount: {
        type: Number,
        default: 0
    },
    firstDepositDate: {
        type: Date,
        default: null
    },
    
    // Reward
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
    
    // Admin approval
    approvedBy: {
        type: String,
        default: null
    },
    approvedAt: {
        type: Date,
        default: null
    },
    
    // Metadata
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: true
});

referralSchema.index({ referrerId: 1, status: 1 });
referralSchema.index({ referredId: 1 });

const Referral = mongoose.model('Referral', referralSchema);

export default Referral;
