// ═══════════════════════════════════════════════════════════════════════════════
// models/OrphanSMS.js — Stores SMS that arrived without matching active session
// ═══════════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const orphanSMSSchema = new mongoose.Schema({
    // Which provider received this SMS
    provider: { 
        type: String, 
        required: true,
        enum: ['TWILIO', 'TELNYX', 'CHEAP_PANEL', 'FREE_PUBLIC', 'UNKNOWN'],
        index: true 
    },

    // Sender phone number
    from: { 
        type: String, 
        default: null 
    },

    // Destination phone number (your purchased number)
    to: { 
        type: String, 
        required: true,
        index: true 
    },

    // Full SMS body
    body: { 
        type: String, 
        default: null 
    },

    // Provider-specific message ID
    messageSid: { 
        type: String, 
        default: null,
        index: true 
    },

    // Extracted OTP (if any)
    extractedOtp: { 
        type: String, 
        default: null 
    },

    // When SMS was received
    receivedAt: { 
        type: Date, 
        default: Date.now,
        index: true 
    },

    // Manual review status
    reviewed: { 
        type: Boolean, 
        default: false 
    },

    reviewedAt: { 
        type: Date, 
        default: null 
    },

    reviewedBy: { 
        type: String, 
        default: null 
    },

    // If later matched to a session
    matchedSession: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Session',
        default: null 
    },

    matchedAt: { 
        type: Date, 
        default: null 
    },

    // Raw webhook payload for debugging
    rawPayload: { 
        type: mongoose.Schema.Types.Mixed, 
        default: null 
    },

    // IP that sent the webhook (for security audit)
    sourceIp: { 
        type: String, 
        default: null 
    }

}, { 
    timestamps: true,
    collection: 'orphan_sms'
});

// Compound index for common queries
orphanSMSSchema.index({ to: 1, receivedAt: -1 });
orphanSMSSchema.index({ reviewed: 1, receivedAt: -1 });
orphanSMSSchema.index({ provider: 1, receivedAt: -1 });

// Static method to find recent orphans for a number
orphanSMSSchema.statics.findRecentForNumber = function(phoneNumber, hoursBack = 24) {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    return this.find({
        to: phoneNumber,
        receivedAt: { $gte: since }
    }).sort({ receivedAt: -1 }).limit(10);
};

// Static method to get unreviewed count
orphanSMSSchema.statics.getUnreviewedCount = function() {
    return this.countDocuments({ reviewed: false });
};

export const OrphanSMS = mongoose.model('OrphanSMS', orphanSMSSchema);
