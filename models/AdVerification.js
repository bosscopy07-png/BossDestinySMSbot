// 
import mongoose from 'mongoose';

const adVerificationSchema = new mongoose.Schema({
    verificationId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    credits: { type: Number, default: 2 },
    startTime: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now, expires: 3600 }, // Auto-delete after 1 hour
    status: { type: String, enum: ['PENDING', 'STARTED', 'COMPLETED'], default: 'PENDING' },
    urlType: { type: String, enum: ['omg10', 'profitablecpm'], default: 'omg10' },
    claimedAt: { type: Date, default: null },
    watchDuration: { type: Number, default: 0 }
});

export default mongoose.model('AdVerification', adVerificationSchema);
