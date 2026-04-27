import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
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
        sparse: true    // ← This auto-creates the index with unique + sparse
    },
    referredBy: {
        type: String,
        default: null,
        index: true      // ← Inline index, no separate userSchema.index() needed
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
        default: Date.now,
        index: true       // ← Inline index
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
    
    // ========== DEPOSIT FIELDS ==========
    depositAddress: {
        type: String,
        default: null
    },
    depositTrackingAmount: {
        type: Number,
        default: null
    },
    depositPending: {
        type: Boolean,
        default: false
    },
    depositRequestedAt: {
        type: Date,
        default: null
    },
    registeredWallet: {
        type: String,
        default: null
    },
    lastDepositAt: {
        type: Date,
        default: null
    }
    // ====================================

}, {
    timestamps: true
});

// ═══════════════════════════════════════════════════════════
//  INDEXES — Only compound/background indexes here.
//  Single-field indexes should use `index: true` inline above.
// ═══════════════════════════════════════════════════════════

// Compound index for admin queries: blacklisted users sorted by last active
userSchema.index({ isBlacklisted: 1, lastActive: -1 });

// Compound index for deposit tracking
userSchema.index({ depositPending: 1, depositTrackingAmount: 1 });

// Compound index for referral lookups
userSchema.index({ referredBy: 1, referralCount: -1 });

// ═══════════════════════════════════════════════════════════
//  METHODS
// ═══════════════════════════════════════════════════════════

userSchema.methods.isVipActive = function() {
    return this.vipExpiry && this.vipExpiry > new Date();
};

userSchema.methods.getAvailableBalance = function() {
    return (this.balance || 0) - (this.lockedBalance || 0);
};

// ═══════════════════════════════════════════════════════════
//  STATICS
// ═══════════════════════════════════════════════════════════

userSchema.statics.generateReferralCode = function() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// ═══════════════════════════════════════════════════════════
//  PRE-SAVE HOOKS
// ═══════════════════════════════════════════════════════════

userSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    }
    next();
});

const User = mongoose.model('User', userSchema);

export default User;
        
