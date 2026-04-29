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
            'WITHDRAWAL',
            'POOL_PURCHASE',
            'NUMBER_ASSIGN',
            'NUMBER_RELEASE',
            'NUMBER_RETIRE'
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

transactionSchema.statics.calculateRevenue = async function(since, types = ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION', 'POOL_PURCHASE']) {
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

// ═══════════════════════════════════════════════════════════
//  User Stats Aggregation (used by AdminCommands)
// ═══════════════════════════════════════════════════════════

transactionSchema.statics.getUserStats = async function(userId) {
    const result = await this.aggregate([
        { $match: { userId, status: 'COMPLETED' } },
        {
            $group: {
                _id: null,
                totalSpent: {
                    $sum: {
                        $cond: [
                            { $in: ['$type', ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION', 'POOL_PURCHASE']] },
                            { $abs: '$amount' },
                            0
                        ]
                    }
                },
                totalDeposited: {
                    $sum: {
                        $cond: [{ $eq: ['$type', 'DEPOSIT'] }, '$amount', 0]
                    }
                },
                totalRefEarnings: {
                    $sum: {
                        $cond: [{ $eq: ['$type', 'REFERRAL_REWARD'] }, '$amount', 0]
                    }
                }
            }
        }
    ]);
    return result[0] || { totalSpent: 0, totalDeposited: 0, totalRefEarnings: 0 };
};

// ═══════════════════════════════════════════════════════════
//  Financial Report Aggregation
// ═══════════════════════════════════════════════════════════

transactionSchema.statics.getFinancialReport = async function(startDate, endDate) {
    const query = {
        createdAt: {
            $gte: startDate ? new Date(startDate) : new Date(0),
            $lte: endDate ? new Date(endDate) : new Date()
        }
    };

    const [revenue, expenses, deposits, withdrawals] = await Promise.all([
        this.aggregate([
            { $match: { ...query, type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION', 'POOL_PURCHASE'] }, status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
        ]),
        this.aggregate([
            { $match: { ...query, type: { $in: ['REFERRAL_REWARD', 'ADMIN_ADD'] }, status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        this.aggregate([
            { $match: { ...query, type: 'DEPOSIT', status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        this.aggregate([
            { $match: { ...query, type: 'WITHDRAWAL', status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } }
        ])
    ]);

    return {
        period: { start: startDate, end: endDate },
        revenue: revenue[0]?.total || 0,
        expenses: expenses[0]?.total || 0,
        netProfit: (revenue[0]?.total || 0) - (expenses[0]?.total || 0),
        deposits: { total: deposits[0]?.total || 0, count: deposits[0]?.count || 0 },
        withdrawals: { total: withdrawals[0]?.total || 0, count: withdrawals[0]?.count || 0 }
    };
};

// ═══════════════════════════════════════════════════════════
//  Revenue by Type Breakdown
// ═══════════════════════════════════════════════════════════

transactionSchema.statics.getRevenueByType = async function(since) {
    const results = await this.aggregate([
        {
            $match: {
                type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION', 'POOL_PURCHASE'] },
                status: 'COMPLETED',
                createdAt: { $gte: since }
            }
        },
        {
            $group: {
                _id: '$type',
                total: { $sum: { $abs: '$amount' } },
                count: { $sum: 1 }
            }
        },
        { $sort: { total: -1 } }
    ]);

    return results.map(r => ({
        type: r._id,
        total: r.total,
        count: r.count
    }));
};

// ═══════════════════════════════════════════════════════════
//  Export Data Helper
// ═══════════════════════════════════════════════════════════

transactionSchema.statics.exportForPeriod = async function(startDate, endDate, format = 'csv') {
    const query = {
        createdAt: {
            $gte: startDate ? new Date(startDate) : new Date(0),
            $lte: endDate ? new Date(endDate) : new Date()
        }
    };

    const transactions = await this.find(query).sort({ createdAt: -1 }).lean();

    if (format === 'json') {
        return JSON.stringify(transactions, null, 2);
    }

    // CSV format
    const headers = ['txId', 'userId', 'type', 'amount', 'status', 'metadata', 'createdAt'];
    const escapeCSV = (value) => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    };

    const rows = transactions.map(t => headers.map(h => {
        if (h === 'metadata') return escapeCSV(JSON.stringify(t[h] || {}));
        return escapeCSV(t[h]);
    }).join(','));

    return [headers.join(','), ...rows].join('\n');
};

const Transaction = mongoose.model('Transaction', transactionSchema);

export default Transaction;
            
