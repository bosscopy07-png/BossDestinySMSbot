import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
    prices: {
        cheapOtp: { type: Number, default: 0.50 },
        vipOtp: { type: Number, default: 0.30 },
        vipSubscription: { type: Number, default: 5.00 },
        vipDuration: { type: Number, default: 30 }
    },
    limits: {
        freeDaily: { type: Number, default: 3 },
        freePerNumber: { type: Number, default: 1 }
    },
    providers: {
        twilio: { type: Boolean, default: true },
        telnyx: { type: Boolean, default: true },
        cheapPanel: { type: Boolean, default: true },
        freePublic: { type: Boolean, default: true }
    },
    maintenance: { type: Boolean, default: false }
}, { timestamps: true, minimize: false });

// Singleton — only one settings document
settingsSchema.pre('save', async function(next) {
    const count = await mongoose.model('Settings').countDocuments();
    if (count > 0 && this.isNew) {
        return next(new Error('Only one settings document allowed'));
    }
    next();
});

export default mongoose.model('Settings', settingsSchema);
                   
