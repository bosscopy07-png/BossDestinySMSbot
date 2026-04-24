import mongoose from 'mongoose';

const apiKeySchema = new mongoose.Schema({
    keyId: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: String,
        required: true,
        index: true
    },
    apiKey: {
        type: String,
        required: true,
        unique: true
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
        default: null
    },
    
    // Status
    isActive: {
        type: Boolean,
        default: true
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
    createdAt: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

apiKeySchema.index({ apiKey: 1 });
apiKeySchema.index({ userId: 1, isActive: 1 });

const ApiKey = mongoose.model('ApiKey', apiKeySchema);

export default ApiKey;
