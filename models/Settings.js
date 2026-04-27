// ═══════════════════════════════════════════════════════════
//  models/Settings.js — Singleton App Configuration
// ═══════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
    // ─── Pricing ───
    prices: {
        cheapOtp: { type: Number, default: 0.50, min: 0 },
        vipOtp: { type: Number, default: 0.30, min: 0 },
        vipSubscription: { type: Number, default: 5.00, min: 0 },
        vipDuration: { type: Number, default: 30, min: 1 } // days
    },

    // ─── Usage Limits ───
    limits: {
        freeDaily: { type: Number, default: 3, min: 0 },
        freePerNumber: { type: Number, default: 1, min: 0 },
        maxConcurrentSessions: { type: Number, default: 5, min: 1 }
    },

    // ─── Provider Toggles ───
    providers: {
        twilio: { type: Boolean, default: true },
        telnyx: { type: Boolean, default: true },
        cheapPanel: { type: Boolean, default: true },
        freePublic: { type: Boolean, default: true }
    },

    // ─── System Flags ───
    maintenance: { type: Boolean, default: false },
    registrationOpen: { type: Boolean, default: true },

    // ─── Broadcast Defaults ───
    broadcast: {
        defaultDelay: { type: Number, default: 50 },      // ms between messages
        defaultBatchSize: { type: Number, default: 30 },  // users per batch
        maxMessageLength: { type: Number, default: 4096 } // Telegram limit
    },

    // ─── Referral ───
    referral: {
        rewardAmount: { type: Number, default: 1.00, min: 0 },
        minSpendForReward: { type: Number, default: 5.00, min: 0 },
        autoApprove: { type: Boolean, default: false }
    }

}, {
    timestamps: true,
    minimize: false, // Keep empty objects
    collection: 'settings'
});

// ─── Singleton enforcement ───
settingsSchema.pre('save', async function(next) {
    if (this.isNew) {
        const count = await mongoose.model('Settings').countDocuments();
        if (count > 0) {
            return next(new Error('Settings is a singleton. Use findOneAndUpdate instead of creating new documents.'));
        }
    }
    next();
});

// ─── Static: get or create singleton ───
settingsSchema.statics.getInstance = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

// ─── Static: merge updates (used by AdminCommands._saveSettings) ───
settingsSchema.statics.merge = async function(updates) {
    const flatUpdates = {};
    
    function flatten(obj, prefix = '') {
        for (const [key, val] of Object.entries(obj)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
                flatten(val, path);
            } else {
                flatUpdates[path] = val;
            }
        }
    }
    
    flatten(updates);
    
    return this.findOneAndUpdate(
        {},
        { $set: flatUpdates },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const Settings = mongoose.model('Settings', settingsSchema);

export default Settings;
             
