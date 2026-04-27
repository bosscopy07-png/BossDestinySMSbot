import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
   txId: {
       type: String,
       required: true,
       unique: true
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
           'ADMIN_ADD',
           'ADMIN_DEDUCT',
           'WITHDRAWAL'
       ],
       required: true,
       index: true
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
       default: 'PENDING',
       index: true
   },
   
   // Blockchain (for deposits)
   blockchain: {
       txHash: { 
           type: String, 
           default: null
       },
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
   },
   rejectedBy: {
       type: String,
       default: null
   },
   rejectedAt: {
       type: Date,
       default: null
   },
   rejectionReason: {
       type: String,
       default: null
   }
}, {
   timestamps: true
});

// ═══════════════════════════════════════════════════════════
//  COMPOUND INDEXES — Named explicitly to prevent collisions
// ═══════════════════════════════════════════════════════════

// User transaction history (most recent first)
transactionSchema.index({ userId: 1, createdAt: -1 }, { name: 'userId_createdAt_desc' });

// Admin dashboard: filter by status + type
transactionSchema.index({ status: 1, type: 1, createdAt: -1 }, { name: 'status_type_createdAt_desc' });

// Revenue calculations: completed transactions by type within date range
transactionSchema.index({ type: 1, status: 1, createdAt: 1 }, { name: 'type_status_createdAt_asc' });

// Deposit tracking by txHash
transactionSchema.index({ 'blockchain.txHash': 1 }, { 
   name: 'blockchain_txHash_sparse', 
   sparse: true 
});

// Deposit tracking by txHash + status
transactionSchema.index({ 'blockchain.txHash': 1, status: 1 }, { 
   name: 'blockchain_txHash_status' 
});

// Admin log: transactions processed by admin
transactionSchema.index({ processedBy: 1, createdAt: -1 }, { name: 'processedBy_createdAt_desc' });

// ═══════════════════════════════════════════════════════════
//  STATICS
// ═══════════════════════════════════════════════════════════

transactionSchema.statics.getUserHistory = async function(userId, page = 1, limit = 20) {
   const skip = (page - 1) * limit;
   const [transactions, total] = await Promise.all([
       this.find({ userId })
           .sort({ createdAt: -1 })
           .skip(skip)
           .limit(limit)
           .lean(),
       this.countDocuments({ userId })
   ]);
   return { transactions, total, page, pages: Math.ceil(total / limit) };
};

transactionSchema.statics.calculateRevenue = async function(since, types = ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION']) {
   const result = await this.aggregate([
       {
           $match: {
               type: { $in: types },
               status: 'COMPLETED',
               createdAt: { $gte: since }
           }
       },
       {
           $group: {
               _id: null,
               total: { $sum: { $abs: '$amount' } }
           }
       }
   ]);
   return Math.abs(result[0]?.total || 0);
};

transactionSchema.statics.findByTxHash = async function(txHash) {
   return this.findOne({ 'blockchain.txHash': txHash }).lean();
};

transactionSchema.statics.getPendingDepositsCount = async function() {
   return this.countDocuments({ type: 'DEPOSIT', status: 'PENDING' });
};

const Transaction = mongoose.model('Transaction', transactionSchema);

export default Transaction;
       
