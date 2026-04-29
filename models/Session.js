
import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: String,
        required: true,
        index: true
    },

    mode: {
        type: String,
        enum: ['FREE', 'CHEAP', 'VIP', 'BUNDLE'],
        required: true,
        index: true
    },
    
    service: {
        type: String,
        required: true,
        index: true
    },
    country: {
        type: String,
        default: 'US',
        index: true
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
    providerNumberId: {
        type: String,
        default: null,
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

// Provider number ID lookup (for pool manager)
sessionSchema.index({ providerNumberId: 1, status: 1 });

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
        { $set: { status: 'CANCELLED', cancelledAt: new Date(), endTime: new Date() } }
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

/**
 * Create session with provider validation
 */
sessionSchema.statics.createFromProvider = async function(userId, mode, service, country, providerResponse, options = {}) {
    // Validate provider response
    const phone = providerResponse?.phone;
    const isInvalid = !phone || phone === '0201' || phone.length < 5;
    
    if (isInvalid) {
        const err = new Error('INVALID_PROVIDER_RESPONSE');
        err.code = 'INVALID_PROVIDER_RESPONSE';
        err.providerResponse = providerResponse;
        throw err;
    }

    const {
        cost = 0,
        timeoutAt,
        provider,
        providerNumberId = null,
        lockTxId = null,
        maxRetries = 0,
        ipAddress = null,
        userAgent = null,
        webhookUrl = null
    } = options;

    if (!timeoutAt || !(timeoutAt instanceof Date)) {
        throw new Error('timeoutAt is required and must be a Date');
    }

    if (!provider) {
        throw new Error('provider is required');
    }

    const sessionId = `${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    return this.create({
        sessionId,
        userId,
        mode,
        service,
        country: country || 'US',
        number: phone,
        provider,
        providerNumberId,
        otpCode: null,
        maskedOtp: null,
        status: 'WAITING',
        startTime: new Date(),
        endTime: null,
        timeoutAt,
        cancelledAt: null,
        cost,
        lockTxId,
        retryCount: 0,
        maxRetries,
        ipAddress,
        userAgent,
        webhookUrl,
        webhookDelivered: false,
        webhookAttempts: 0
    });
};

/**
 * Mark session as received with OTP
 */
sessionSchema.statics.markReceived = async function(sessionId, otpCode, maskedOtp = null) {
    return this.findOneAndUpdate(
        { sessionId, status: { $in: ['WAITING', 'CHECKING'] } },
        {
            $set: {
                status: 'RECEIVED',
                otpCode,
                maskedOtp: maskedOtp || otpCode.replace(/\d(?=\d{2})/g, '*'),
                endTime: new Date()
            }
        },
        { new: true }
    );
};

/**
 * Mark session as failed
 */
sessionSchema.statics.markFailed = async function(sessionId, reason = null) {
    return this.findOneAndUpdate(
        { sessionId, status: { $in: ['WAITING', 'CHECKING'] } },
        {
            $set: {
                status: 'FAILED',
                endTime: new Date()
            }
        },
        { new: true }
    );
};

/**
 * Mark session as timeout
 */
sessionSchema.statics.markTimeout = async function(sessionId) {
    return this.findOneAndUpdate(
        { sessionId, status: { $in: ['WAITING', 'CHECKING'] } },
        {
            $set: {
                status: 'TIMEOUT',
                endTime: new Date()
            }
        },
        { new: true }
    );
};

/**
 * Mark session as cancelled
 */
sessionSchema.statics.markCancelled = async function(sessionId) {
    return this.findOneAndUpdate(
        { sessionId, status: { $in: ['WAITING', 'CHECKING'] } },
        {
            $set: {
                status: 'CANCELLED',
                cancelledAt: new Date(),
                endTime: new Date()
            }
        },
        { new: true }
    );
};

/**
 * Increment retry count
 */
sessionSchema.statics.incrementRetry = async function(sessionId) {
    return this.findOneAndUpdate(
        { sessionId },
        { $inc: { retryCount: 1 } },
        { new: true }
    );
};

/**
 * Record webhook delivery attempt
 */
sessionSchema.statics.recordWebhookAttempt = async function(sessionId, delivered = false) {
    return this.findOneAndUpdate(
        { sessionId },
        {
            $inc: { webhookAttempts: 1 },
            $set: { webhookDelivered: delivered }
        },
        { new: true }
    );
};

/**
 * Get session by ID with lean
 */
sessionSchema.statics.getById = async function(sessionId) {
    return this.findOne({ sessionId }).lean();
};

/**
 * Check if user has active sessions
 */
sessionSchema.statics.hasActive = async function(userId) {
    const count = await this.countDocuments({
        userId,
        status: { $in: ['WAITING', 'CHECKING'] }
    });
    return count > 0;
};

const Session = mongoose.model('Session', sessionSchema);

export default Session;
                                  
