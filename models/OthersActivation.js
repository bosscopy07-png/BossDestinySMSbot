// models/OthersActivation.js — generic (OTHERS) number activations. New collection; touches no existing data.
import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    text: String, sender: { type: String, default: null }, code: { type: String, default: null }, receivedAt: Date
}, { _id: false });

const schema = new mongoose.Schema({
    activationId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    kind: { type: String, default: 'OTHERS' },
    provider: { type: String, default: '5SIM' },
    providerId: { type: String, default: null, index: true },
    product: { type: String, default: 'other' },

    country: { type: String, required: true, index: true },   // provider country slug (e.g. "usa")
    countryName: { type: String, default: null },
    operator: { type: String, default: 'any' },
    phone: { type: String, default: null },

    priceUsd: { type: Number, required: true },               // what the user pays
    providerCost: { type: Number, default: null },            // what the provider charged us
    lockTxId: { type: String, default: null, index: true },

    status: { type: String, enum: ['PURCHASING', 'ACTIVE', 'RECEIVED', 'EXPIRED', 'CANCELLED', 'FAILED'], default: 'PURCHASING', index: true },
    failureReason: { type: String, default: null },
    ambiguous: { type: Boolean, default: false },             // provider may have allocated a number we could not confirm

    messages: { type: [messageSchema], default: [] },
    otpCode: { type: String, default: null },
    receivedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },

    capture: { status: { type: String, default: null }, at: Date, error: String },
    refund: { status: { type: String, default: null }, at: Date, amount: Number, reason: String, txId: String, error: String },

    requestKey: { type: String, default: undefined },          // idempotency key (unique when present)
    rebuyOf: { type: String, default: null, index: true },     // previous activationId when created via Buy Again
    rebuyClaimedBy: { type: String, default: null },           // new activationId created from this one

    nextPollAt: { type: Date, default: null },
    pollLockUntil: { type: Date, default: null },
    errorCount: { type: Number, default: 0 },
    lastProviderStatus: { type: String, default: null }
}, { timestamps: true });

schema.index({ requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } });
schema.index({ userId: 1, createdAt: -1 });
schema.index({ status: 1, nextPollAt: 1 });

export default mongoose.models.OthersActivation || mongoose.model('OthersActivation', schema);
  
