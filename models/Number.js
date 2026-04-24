import mongoose from 'mongoose';

const numberSchema = new mongoose.Schema({
    numberId: {
        type: String,
        required: true,
        unique: true
    },
    phoneNumber: {
        type: String,
        required: true,
        unique: true
    },
    country: {
        type: String,
        required: true
    },
    countryCode: {
        type: String,
        required: true
    },
    
    // Provider
    provider: {
        type: String,
        required: true
    },
    providerNumberId: {
        type: String,
        default: null
    },
    
    // Tier
    tier: {
        type: String,
        enum: ['FREE', 'CHEAP', 'VIP'],
        required: true
    },
    
    // Status
    status: {
        type: String,
        enum: ['ACTIVE', 'BUSY', 'EXPIRED', 'BLOCKED', 'ERROR'],
        default: 'ACTIVE'
    },
    
    // Assignment
    assignedTo: {
        type: String,
        default: null
    },
    sessionId: {
        type: String,
        default: null
    },
    
    // Timing
    purchasedAt: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        default: null
    },
    lastUsed: {
        type: Date,
        default: null
    },
    
    // Stats
    totalOTPs: {
        type: Number,
        default: 0
    },
    successCount: {
        type: Number,
        default: 0
    },
    failCount: {
        type: Number,
        default: 0
    },
    successRate: {
        type: Number,
        default: 100
    },
    
    // Cost tracking
    monthlyCost: {
        type: Number,
        default: 0
    },
    smsCost: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

numberSchema.index({ tier: 1, country: 1, status: 1 });
numberSchema.index({ status: 1, lastUsed: 1 });

const Number = mongoose.model('Number', numberSchema);

export default Number;
