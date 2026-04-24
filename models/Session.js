import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    userId: {
        type: String,
        required: true,
        index: true
    },
    
    // Service Details
    mode: {
        type: String,
        enum: ['FREE', 'CHEAP', 'VIP'],
        required: true
    },
    service: {
        type: String,
        required: true
    },
    country: {
        type: String,
        default: 'US'
    },
    
    // Number & Provider
    number: {
        type: String,
        required: true
    },
    provider: {
        type: String,
        required: true
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
        default: 'WAITING'
    },
    
    // Timing
    startTime: {
        type: Date,
        default: Date.now
    },
    endTime: {
        type: Date,
        default: null
    },
    timeoutAt: {
        type: Date,
        required: true
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
    }
}, {
    timestamps: true
});

sessionSchema.index({ userId: 1, status: 1 });
sessionSchema.index({ status: 1, timeoutAt: 1 });

const Session = mongoose.model('Session', sessionSchema);

export default Session;
 
