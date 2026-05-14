//  — NEW
import mongoose from 'mongoose';

const creditTransactionSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    type: { 
        type: String, 
        required: true,
        enum: ['HOLD', 'COMMIT', 'RELEASE', 'DEDUCT', 'AD_AWARD', 'POSTBACK', 'REFUND', 'RESET']
    },
    amount: { type: Number, required: true },  // Negative for deductions, positive for awards
    holdId: { type: String, index: true },
    balanceAfter: Number,
    reason: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, expires: 2592000 } // Auto-delete after 30 days
});

creditTransactionSchema.index({ userId: 1, createdAt: -1 });
export default mongoose.model('CreditTransaction', creditTransactionSchema);
