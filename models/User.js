import mongoose from 'mongoose';
import { generateReferralCode } from '../utils/helpers.js';

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
    
    // Balance & Credits
    balance: {
        type: Number,
        default: 0,
        min: 0
    },
    lockedBalance: {
        type: Number,
        default: 0,
        min: 0
    },
    bundleRemaining: {
        type: Number,
        default: 0,
        min: 0
    },
    
    // VIP Status
    vipExpiry: {
        type: Date,
        default: null
    },
    vipDailyUsed: {
        type: Number,
        default: 0
    },
    vipDailyReset: {
        type: Date,
        default: null
    },
    
    // Mode & Limits
    mode: {
        type: String,
        enum: ['FREE', 'CHEAP', 'VIP'],
        default: 'FREE'
    },
    freeUsedToday: {
        type: Number,
        default: 0
    },
    freeResetDate: {
        type: Date,
        default: null
    },
    
    // Blockchain
    depositAddress: {
        type: String,
        default: null,
        index: true
    },
    depositIndex: {
        type: Number,
        default: null
    },
    totalDeposited: {
        type: Number,
        default: 0
    },
    totalSpent: {
        type: Number,
        default: 0
    },
    
    // Referral
    referralCode: {
        type: String,
        unique: true,
        sparse: true
    },
    referredBy: {
        type: String,
        default: null,
        index: true
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
    
    // Security
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
    
    // Preferences
    preferredCountry: {
        type: String,
        default: 'US'
    },
    privacyEnabled: {
        type: Boolean,
        default: false
    },
    notificationsEnabled: {
        type: Boolean,
        default: true
    },
    language: {
        type: String,
        default: 'en'
    },
    
    // Metadata
    ipAddress: {
        type: String,
        default: null
    },
    lastActive: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Indexes
userSchema.index({ isBlacklisted: 1, lastActive: -1 });
userSchema.index({ vipExpiry: 1 }, { sparse: true });
userSchema.index({ referredBy: 1 });

// Methods
userSchema.methods.isVipActive = function() {
    return this.vipExpiry && this.vipExpiry > new Date();
};

userSchema.methods.getAvailableBalance = function() {
    return this.balance - this.lockedBalance;
};

userSchema.methods.canUseFree = function() {
    if (isNewDay(this.freeResetDate)) {
        this.freeUsedToday = 0;
        this.freeResetDate = new Date();
    }
    return this.freeUsedToday < 3; // FREE_DAILY_LIMIT from config
};

userSchema.methods.canUseVip = function() {
    if (!this.isVipActive()) return false;
    if (isNewDay(this.vipDailyReset)) {
        this.vipDailyUsed = 0;
        this.vipDailyReset = new Date();
    }
    return this.vipDailyUsed < 50; // VIP_DAILY_LIMIT from config
};

userSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = generateReferralCode(this.userId);
    }
    next();
});

const User = mongoose.model('User', userSchema);

export default User;
