import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },


telegramChatId: {
    type: String,
    index: true,
    sparse: true
},
    
adCredits: {
    type: Number,
    default: 0,
    min: 0
},
adCreditReset: {
    type: Date,
    default: null
},
freeUsedToday: {
    type: Number,
    default: 0,
    min: 0
},
    
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    balance: { type: Number, default: 0 },
    lockedBalance: { type: Number, default: 0 },
    totalDeposited: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    bundleRemaining: { type: Number, default: 0 },
    vipExpiry: { type: Date, default: null },
    vipDailyUsed: { type: Number, default: 0 },
    vipDailyReset: { type: Date, default: null },
    freeUsedToday: { type: Number, default: 0 },
    freeResetDate: { type: Date, default: null },
    mode: {
        type: String,
        enum: ['FREE', 'CHEAP', 'VIP', 'BUNDLE'],
        default: 'FREE'
    },
    isBlacklisted: { type: Boolean, default: false },
    blacklistReason: { type: String, default: null },
    blacklistDate: { type: Date, default: null },
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: String, default: null, index: true },
    referralCount: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    referralRewardsPending: { type: Number, default: 0 },
    referralBonusReceived: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now, index: true },
    privacyEnabled: { type: Boolean, default: true },
    notificationsEnabled: { type: Boolean, default: true },
    preferredCountry: { type: String, default: 'US' },
    
    // ========== DEPOSIT FIELDS ==========
    depositAddress: { type: String, default: null },
    depositTrackingAmount: { type: Number, default: null },
    depositRequestedAmount: { type: Number, default: null },  // ← FIXED: was missing
    depositPending: { type: Boolean, default: false },
    depositRequestedAt: { type: Date, default: null },
    registeredWallet: { type: String, default: null },
    lastDepositAt: { type: Date, default: null }
    // ====================================

}, { timestamps: true });

// ═══════════════════════════════════════════════════════════
//  INDEXES
// ═══════════════════════════════════════════════════════════

userSchema.index({ isBlacklisted: 1, lastActive: -1 });
userSchema.index({ depositPending: 1, depositTrackingAmount: 1 });
userSchema.index({ referredBy: 1, referralCount: -1 });

// ═══════════════════════════════════════════════════════════
//  INSTANCE METHODS — These work on Mongoose documents
// ═══════════════════════════════════════════════════════════

userSchema.methods.isVipActive = function() {
    return this.vipExpiry && this.vipExpiry > new Date();
};

userSchema.methods.canUseVip = function() {
    if (!this.isVipActive()) return false;
    const limit = 50; // config.limits?.vipDaily || 50
    return (this.vipDailyUsed || 0) < limit;
};

userSchema.methods.canUseFree = function() {
    if (this.isBlacklisted) return false;
    const limit = 3; // config.limits?.freeDaily || 3
    return (this.freeUsedToday || 0) < limit;
};

userSchema.methods.getAvailableBalance = function() {
    return (this.balance || 0) - (this.lockedBalance || 0);
};

// ═══════════════════════════════════════════════════════════
//  STATICS — These work on the model (User.canUseFree(userObj))
// ═══════════════════════════════════════════════════════════

userSchema.statics.canUseFree = function(user) {
    if (user.isBlacklisted) return false;
    const limit = 3;
    return (user.freeUsedToday || 0) < limit;
};

userSchema.statics.canUseVip = function(user) {
    if (!user.vipExpiry || new Date(user.vipExpiry) <= new Date()) return false;
    const limit = 50;
    return (user.vipDailyUsed || 0) < limit;
};

userSchema.statics.isVipActive = function(user) {
    return user.vipExpiry && new Date(user.vipExpiry) > new Date();
};

userSchema.statics.getAvailableBalance = function(user) {
    return (user.balance || 0) - (user.lockedBalance || 0);
};

userSchema.statics.generateReferralCode = function() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// ═══════════════════════════════════════════════════════════
//  PRE-SAVE
// ═══════════════════════════════════════════════════════════

userSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    }
    next();
});

const User = mongoose.model('User', userSchema);

export default User;
    
