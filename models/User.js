import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    // Existing fields (keep what you already have)
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    username: {
        type: String,
        default: null
    },
    firstName: {
        type: String,
        default: null
    },
    lastName: {
        type: String,
        default: null
    },
    balance: {
        type: Number,
        default: 0
    },
    lockedBalance: {
        type: Number,
        default: 0
    },
    totalDeposited: {
        type: Number,
        default: 0
    },
    totalSpent: {
        type: Number,
        default: 0
    },
    bundleRemaining: {
        type: Number,
        default: 0
    },
    vipExpiry: {
        type: Date,
        default: null
    },
    freeUsedToday: {
        type: Number,
        default: 0
    },
    freeResetDate: {
        type: Date,
        default: null
    },
    mode: {
        type: String,
        enum: ['FREE', 'CHEAP', 'VIP'],
        default: 'FREE'
    },
    isBlacklisted: {
        type: Boolean,
        default: false
    },
    blacklistReason: {
        type: String,
        default: null
    },
    blacklistDate: {
        type: Date,
        default: null
    },
    referralCode: {
        type: String,
        unique: true,
        sparse: true
    },
    referredBy: {
        type: String,
        default: null
    },
    referralCount: {
        type: Number,
        default: 0
    },
    referralEarnings: {
        type: Number,
        default: 0
    },
    referralRewardsPending: {
        type: Number,
        default: 0
    },
    lastActive: {
        type: Date,
        default: Date.now
    },
    privacyEnabled: {
        type: Boolean,
        default: true
    },
    notificationsEnabled: {
        type: Boolean,
        default: true
    },
    preferredCountry: {
        type: String,
        default: 'US'
    },
    
    // ========== NEW DEPOSIT FIELDS ==========
    depositAddress: {
        type: String,
        default: null        // Always master address
    },
    depositTrackingAmount: {
        type: Number,
        default: null        // Unique amount for matching (e.g., 10.001234)
    },
    depositPending: {
        type: Boolean,
        default: false       // Waiting for deposit?
    },
    depositRequestedAt: {
        type: Date,
        default: null
    },
    registeredWallet: {
        type: String,
        default: null        // Wallet address they sent from
    },
    lastDepositAt: {
        type: Date,
        default: null
    }
    // =======================================

}, {
    timestamps: true
});

// Indexes
userSchema.index({ referralCode: 1 });
userSchema.index({ referredBy: 1 });
userSchema.index({ isBlacklisted: 1 });
userSchema.index({ lastActive: -1 });

// Methods
userSchema.methods.isVipActive = function() {
    return this.vipExpiry && this.vipExpiry > new Date();
};

userSchema.methods.getAvailableBalance = function() {
    return (this.balance || 0) - (this.lockedBalance || 0);
};

// Static method to generate referral code
userSchema.statics.generateReferralCode = function() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// Pre-save hook to generate referral code
userSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    }
    next();
});

const User = mongoose.model('User', userSchema);

export default User;
