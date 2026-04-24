import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
    txId: {
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
    
    // Transaction Details
    type: {
        type: String,
        enum: [
            'DEPOSIT',
            'DEPOSIT_CONFIRMING',
            'CHEAP_OTP',
            'BUNDLE_PURCHASE',
            'VIP_SUBSCRIPTION',
            'REFERRAL_REWARD',
            'REFUND',
            'ADMIN_ADJUSTMENT',
            'WITHDRAWAL'
        ],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    currency: {
        type: String,
        default: 'USD'
    },
    
    // Status
    status: {
        type: String,
        enum: ['PENDING', 'CONFIRMING', 'COMPLETED', 'FAILED', 'CANCELLED'],
        default: 'PENDING'
    },
    
    // Blockchain (for deposits)
    blockchain: {
        txHash: { type: String, default: null },
        blockNumber: { type: Number, default: null },
        confirmations: { type: Number, default: 0 },
        fromAddress: { type: String, default: null },
        toAddress: { type: String, default: null },
        token: { type: String, default: null },
        amountCrypto: { type: String, default: null }
    },
    
    // Metadata
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    
    // Admin
    processedBy: {
        type: String,
        default: null
    },
    approvedBy: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, type: 1 });
transactionSchema.index({ 'blockchain.txHash': 1 }, { sparse: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

export default Transaction;
 
