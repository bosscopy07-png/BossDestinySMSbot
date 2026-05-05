// ═══════════════════════════════════════════════════════════════════════════════
// models/AdView.js — Ad View Transaction Record
// ═══════════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const adViewSchema = new mongoose.Schema({
    viewId: {
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
    network: {
        type: String,
        required: true,
        enum: [
            'shorte_st', 
            'adfly', 
            'cpagrip', 
            'ogads', 
            'admaven', 
            'propeller', 
            'aads',
            'omg10',           // ← NEW: Your primary network
            'profitablecpm'    // ← NEW: Your fallback network
        ]
    },
    creditsEarned: {
        type: Number,
        required: true,
        min: 0
    },
    status: {
        type: String,
        enum: ['PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'],
        default: 'PENDING'
    },
    completedAt: {
        type: Date,
        default: null
    },
    watchDuration: {       // ← NEW: Track actual watch time (ms)
        type: Number,
        default: null
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: true
});

// Index for quick lookups
adViewSchema.index({ userId: 1, createdAt: -1 });
adViewSchema.index({ status: 1, createdAt: -1 });
adViewSchema.index({ network: 1, createdAt: -1 });  // ← NEW: Network analytics

const AdView = mongoose.model('AdView', adViewSchema);

export default AdView;
