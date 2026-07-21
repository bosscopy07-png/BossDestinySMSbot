import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
    paymentId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    reference: {
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
    provider: {
        type: String,
        required: true,
        enum: ['PAYSTACK', 'FLUTTERWAVE', 'MONNIFY'],
        default: 'PAYSTACK'
    },
    amountNaira: {
        type: Number,
        required: true,
        min: 0
    },
    amountUsd: {
        type: Number,
        required: true,
        min: 0
    },
    exchangeRate: {
        type: Number,
        required: true,
        min: 0
    },
    providerTransactionId: {
        type: String,
        unique: true,
        sparse: true,
        index: true
    },
    status: {
        type: String,
        enum: ['PENDING', 'SUCCESS', 'FAILED', 'EXPIRED'],
        default: 'PENDING',
        index: true
    },
    paidAt: {
        type: Date
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Compound indexes for efficient queries
paymentSchema.index({ userId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ provider: 1, status: 1 });

const Payment = mongoose.model('Payment', paymentSchema);

export default Payment;
