import mongoose from 'mongoose';

const apiKeySchema = new mongoose.Schema({
    keyId: {
        type: String,
        required: true,
        unique: true    // ← Auto-creates unique index
    },
    userId: {
        type: String,
        required: true,
        index: true
    },
    apiKey: {
        type: String,
        required: true,
        unique: true    // ← Auto-creates unique index
    },
    name: {
        type: String,
        required: true
    },
    
    // Permissions
    permissions: [{
        type: String,
        enum: ['read', 'request_otp', 'webhook', 'balance']
    }],
    
    // Rate limiting
    rateLimit: {
        type: Number,
        default: 60
    },
    usageCount: {
        type: Number,
        default: 0
    },
    lastUsed: {
        type: Date,
        default: null,
        index: true
    },
    
    // Status
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    
    // Webhook
    webhookUrl: {
        type: String,
        default: null
    },
    webhookSecret: {
        type: String,
        default: null
    },
    webhookEvents: [{
        type: String,
        enum: ['otp.received', 'otp.timeout', 'deposit.confirmed']
    }],
    
    // Timing
    expiresAt: {
        type: Date,
        default: null,
        index: true     // ← For expiry cleanup
    }
}, {
    timestamps: true
});

// ═══════════════════════════════════════════════════════════
//  COMPOUND INDEXES
// ═══════════════════════════════════════════════════════════

// Active keys for a user
apiKeySchema.index({ userId: 1, isActive: 1 });

// API key lookup (apiKey is unique, but compound for status check)
apiKeySchema.index({ apiKey: 1, isActive: 1 });

// Expiry cleanup
apiKeySchema.index({ isActive: 1, expiresAt: 1 });

// ═══════════════════════════════════════════════════════════
//  STATICS
// ═══════════════════════════════════════════════════════════

/**
 * Validate and get key by apiKey string
 */
apiKeySchema.statics.validateKey = async function(apiKeyString) {
    const key = await this.findOne({ apiKey: apiKeyString, isActive: true }).lean();
    if (!key) return null;
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) return null;
    return key;
};

/**
 * Increment usage counter
 */
apiKeySchema.statics.recordUsage = async function(keyId) {
    return this.findOneAndUpdate(
        { keyId },
        { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } },
        { new: true }
    );
};

/**
 * Get user's API keys
 */
apiKeySchema.statics.getUserKeys = async function(userId) {
    return this.find({ userId }).sort({ createdAt: -1 }).lean();
};

/**
 * Revoke all keys for a user
 */
apiKeySchema.statics.revokeAll = async function(userId) {
    return this.updateMany(
        { userId, isActive: true },
        { $set: { isActive: false } }
    );
};

/**
 * Get expired keys for cleanup
 */
apiKeySchema.statics.getExpired = async function() {
    return this.find({
        isActive: true,
        expiresAt: { $lte: new Date() }
    }).lean();
};

const ApiKey = mongoose.model('ApiKey', apiKeySchema);

export default ApiKey;
