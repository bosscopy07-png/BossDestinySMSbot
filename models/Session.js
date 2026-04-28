import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true    // ← Auto-creates unique index
    },
    userId: {
        type: String,
        required: true,
        index: true
    },

    mode: {
        type: String,
        enum: ['FREE', 'CHEAP', 'VIP', 'BUNDLE'],  // ← FIXED: added 'BUNDLE'
        required: true,
        index: true
    },
    
    service: {
        type: String,
        required: true,
        index: true     // ← For service stats aggregation
    },
    country: {
        type: String,
        default: 'US',
        index: true     // ← For country stats
    },
    
    // Number & Provider
    number: {
        type: String,
        required: true
    },
    provider: {
        type: String,
        required: true,
        index: true
    },
    
    // OTP
    otpCode: {
        type: String,
        default: null
    },
    maskedOtp: {
        type: String,
        default: null
    },
    
    // Status
    status: {
        type: String,
        enum: ['WAITING', 'CHECKING', 'RECEIVED', 'TIMEOUT', 'CANCELLED', 'FAILED'],
        default: 'WAITING',
        index: true
    },
    
    // Timing
    startTime: {
        type: Date,
        default: Date.now,
        index: true
    },
    endTime: {
        type: Date,
        default: null
    },
    timeoutAt: {
        type: Date,
        required: true
    },
    cancelledAt: {
        type: Date,
        default: null
    },
    
    // Financial
    cost: {
        type: Number,
        default: 0
    },
    lockTxId: {
        type: String,
        default: null
    },
    
    // Retry
    retryCount: {
        type: Number,
        default: 0
    },
    maxRetries: {
        type: Number,
        default: 0
    },
    
    // Metadata
    ipAddress: {
        type: String,
        default: null
    },
    userAgent: {
        type: String,
        default: null
    },
    webhookUrl: {
        type: String,
        default: null
    },
    webhookDelivered: {
        type: Boolean,
        default: false
    },
    webhookAttempts: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

// ═══════════════════════════════════════════════════════════
//  COMPOUND INDEXES
// ═══════════════════════════════════════════════════════════

// Active sessions for a user (for /cancel command)
sessionSchema.index({ userId: 1, status: 1, startTime: -1 });

// Timeout scanner: find sessions about to expire
sessionSchema.index({ status: 1, timeoutAt: 1 });

// Admin dashboard: OTP stats by date
sessionSchema.index({ startTime: 1, status: 1 });

// Service stats: by service and date
sessionSchema.index({ service: 1, startTime: -1, status: 1 });

// Country stats
sessionSchema.index({ country: 1, startTime: -1 });

// Provider performance
sessionSchema.index({ provider: 1, status: 1, startTime: -1 });

// ═══════════════════════════════════════════════════════════
//  STATICS
// ═══════════════════════════════════════════════════════════

/**
 * Get active sessions for a user
 */
sessionSchema.statics.getActiveByUser = async function(userId) {
    return this.find({
        userId,
        status: { $in: ['WAITING', 'CHECKING'] }
    }).sort({ startTime: -1 }).lean();
};

/**
 * Cancel all active sessions for a user
 */
sessionSchema.statics.cancelActive = async function(userId) {
    return this.updateMany(
        { userId, status: { $in: ['WAITING', 'CHECKING'] } },
        { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
    );
};

/**
 * Get sessions about to timeout (for cron job)
 */
sessionSchema.statics.getExpiringSoon = async function(withinMinutes = 5) {
    const cutoff = new Date(Date.now() + withinMinutes * 60 * 1000);
    return this.find({
        status: { $in: ['WAITING', 'CHECKING'] },
        timeoutAt: { $lte: cutoff }
    }).lean();
};

/**
 * Get dashboard stats for a time range
 */
sessionSchema.statics.getStats = async function(since) {
    return this.aggregate([
        { $match: { startTime: { $gte: since } } },
        {
            $group: {
                _id: null,
                total: { $sum: 1 },
                received: { $sum: { $cond: [{ $eq: ['$status', 'RECEIVED'] }, 1, 0] } },
                timeout: { $sum: { $cond: [{ $eq: ['$status', 'TIMEOUT'] }, 1, 0] } },
                cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
                avgDuration: { $avg: { $subtract: ['$endTime', '$startTime'] } }
            }
        }
    ]);
};

/**
 * Get top services
 */
sessionSchema.statics.getTopServices = async function(since, limit = 5) {
    return this.aggregate([
        { $match: { startTime: { $gte: since } } },
        { $group: { _id: '$service', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit }
    ]);
};

const Session = mongoose.model('Session', sessionSchema);

export default Session;
