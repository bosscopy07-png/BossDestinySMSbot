import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════
//  TRANSACTION TYPE CONSTANTS — Single source of truth
// ═══════════════════════════════════════════════════════════

/**
 * All valid transaction types
 */
export const TRANSACTION_TYPES = Object.freeze({
    DEPOSIT: 'DEPOSIT',
    DEPOSIT_CONFIRMING: 'DEPOSIT_CONFIRMING',
    LOCK: 'LOCK',                    // ← NEW: Fund lock reservation
    CAPTURE: 'CAPTURE',              // ← NEW: Fund capture (actual deduction)
    OTP_PURCHASE: 'OTP_PURCHASE',    // ← NEW: Generic OTP purchase (replaces CHEAP_OTP)
    CHEAP_OTP: 'CHEAP_OTP',          // ← KEEP: Backward compatibility
    BUNDLE_PURCHASE: 'BUNDLE_PURCHASE',
    VIP_SUBSCRIPTION: 'VIP_SUBSCRIPTION',
    REFERRAL_REWARD: 'REFERRAL_REWARD',
    REFUND: 'REFUND',
    ADMIN_ADD: 'ADMIN_ADD',
    ADMIN_DEDUCT: 'ADMIN_DEDUCT',
    WITHDRAWAL: 'WITHDRAWAL',
    POOL_PURCHASE: 'POOL_PURCHASE',
    NUMBER_ASSIGN: 'NUMBER_ASSIGN',
    NUMBER_RELEASE: 'NUMBER_RELEASE',
    NUMBER_RETIRE: 'NUMBER_RETIRE'
});

/**
 * Types that generate revenue (used in reporting)
 */
export const REVENUE_TYPES = Object.freeze([
    TRANSACTION_TYPES.OTP_PURCHASE,
    TRANSACTION_TYPES.CHEAP_OTP,      // ← Backward compat
    TRANSACTION_TYPES.BUNDLE_PURCHASE,
    TRANSACTION_TYPES.VIP_SUBSCRIPTION,
    TRANSACTION_TYPES.POOL_PURCHASE
]);

/**
 * Types that represent a purchase/lock by user
 */
export const PURCHASE_TYPES = Object.freeze([
    TRANSACTION_TYPES.OTP_PURCHASE,
    TRANSACTION_TYPES.CHEAP_OTP,      // ← Backward compat
    TRANSACTION_TYPES.BUNDLE_PURCHASE,
    TRANSACTION_TYPES.VIP_SUBSCRIPTION
]);

/**
 * Types that are admin operations
 */
export const ADMIN_TYPES = Object.freeze([
    TRANSACTION_TYPES.ADMIN_ADD,
    TRANSACTION_TYPES.ADMIN_DEDUCT
]);

/**
 * Types that affect user balance positively
 */
export const CREDIT_TYPES = Object.freeze([
    TRANSACTION_TYPES.DEPOSIT,
    TRANSACTION_TYPES.ADMIN_ADD,
    TRANSACTION_TYPES.REFERRAL_REWARD
]);

/**
 * Types that affect user balance negatively (or lock it)
 */
export const DEBIT_TYPES = Object.freeze([
    TRANSACTION_TYPES.LOCK,
    TRANSACTION_TYPES.CAPTURE,
    TRANSACTION_TYPES.OTP_PURCHASE,
    TRANSACTION_TYPES.CHEAP_OTP,
    TRANSACTION_TYPES.BUNDLE_PURCHASE,
    TRANSACTION_TYPES.VIP_SUBSCRIPTION,
    TRANSACTION_TYPES.WITHDRAWAL,
    TRANSACTION_TYPES.ADMIN_DEDUCT
]);

// ═══════════════════════════════════════════════════════════
//  SCHEMA DEFINITION
// ═══════════════════════════════════════════════════════════

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
        enum: Object.values(TRANSACTION_TYPES),  // ← Uses constant for consistency
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
            default: null,
            index: true  // ← Added: Fast lookup by txHash
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

// NEW: Lock transactions by user (for debugging fund locks)
transactionSchema.index({ userId: 1, type: 1, status: 1 }, { name: 'userId_type_status' });

// NEW: Pending transactions (for cron jobs)
transactionSchema.index({ status: 1, type: 1 }, { name: 'status_type_pending' });

// ═══════════════════════════════════════════════════════════
//  STATICS — User History & Pagination
// ═══════════════════════════════════════════════════════════

/**
 * Get paginated transaction history for a user
 */
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

/**
 * Get all transactions for a user (no pagination)
 */
transactionSchema.statics.getAllByUser = async function(userId, options = {}) {
    const query = { userId };
    if (options.types) query.type = { $in: options.types };
    if (options.status) query.status = options.status;
    if (options.since) query.createdAt = { $gte: options.since };
    
    return this.find(query).sort({ createdAt: -1 }).lean();
};

// ═══════════════════════════════════════════════════════════
//  STATICS — Revenue & Financial Reporting (FIXED)
// ═══════════════════════════════════════════════════════════

/**
 * FIXED: Calculate total revenue for given types and date range
 * Uses REVENUE_TYPES constant for consistency
 */
transactionSchema.statics.calculateRevenue = async function(since, types = REVENUE_TYPES) {
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
                total: { $sum: { $abs: '$amount' } },
                count: { $sum: 1 }
            }
        }
    ]);
    return {
        total: Math.abs(result[0]?.total || 0),
        count: result[0]?.count || 0
    };
};

/**
 * FIXED: Get revenue broken down by type
 */
transactionSchema.statics.getRevenueByType = async function(since, types = REVENUE_TYPES) {
    const results = await this.aggregate([
        {
            $match: {
                type: { $in: types },
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

/**
 * FIXED: Get comprehensive user stats
 * Includes both OTP_PURCHASE and CHEAP_OTP for backward compatibility
 */
transactionSchema.statics.getUserStats = async function(userId) {
    const result = await this.aggregate([
        { $match: { userId, status: 'COMPLETED' } },
        {
            $group: {
                _id: null,
                totalSpent: {
                    $sum: {
                        $cond: [
                            { $in: ['$type', PURCHASE_TYPES] },
                            { $abs: '$amount' },
                            0
                        ]
                    }
                },
                totalDeposited: {
                    $sum: {
                        $cond: [{ $eq: ['$type', TRANSACTION_TYPES.DEPOSIT] }, '$amount', 0]
                    }
                },
                totalRefEarnings: {
                    $sum: {
                        $cond: [{ $eq: ['$type', TRANSACTION_TYPES.REFERRAL_REWARD] }, '$amount', 0]
                    }
                },
                totalLocked: {
                    $sum: {
                        $cond: [
                            { $and: [
                                { $eq: ['$type', TRANSACTION_TYPES.LOCK] },
                                { $eq: ['$status', 'PENDING'] }
                            ]},
                            { $abs: '$amount' },
                            0
                        ]
                    }
                }
            }
        }
    ]);
    return result[0] || { totalSpent: 0, totalDeposited: 0, totalRefEarnings: 0, totalLocked: 0 };
};

/**
 * FIXED: Full financial report with all revenue types
 */
transactionSchema.statics.getFinancialReport = async function(startDate, endDate) {
    const query = {
        createdAt: {
            $gte: startDate ? new Date(startDate) : new Date(0),
            $lte: endDate ? new Date(endDate) : new Date()
        }
    };

    const [revenue, expenses, deposits, withdrawals, locks] = await Promise.all([
        // Revenue: all purchase types
        this.aggregate([
            { $match: { ...query, type: { $in: REVENUE_TYPES }, status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
        ]),
        // Expenses: referral rewards + admin adds
        this.aggregate([
            { $match: { ...query, type: { $in: [TRANSACTION_TYPES.REFERRAL_REWARD, TRANSACTION_TYPES.ADMIN_ADD] }, status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        // Deposits
        this.aggregate([
            { $match: { ...query, type: TRANSACTION_TYPES.DEPOSIT, status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        // Withdrawals
        this.aggregate([
            { $match: { ...query, type: TRANSACTION_TYPES.WITHDRAWAL, status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } }
        ]),
        // Pending locks (liability)
        this.aggregate([
            { $match: { ...query, type: TRANSACTION_TYPES.LOCK, status: 'PENDING' } },
            { $group: { _id: null, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } }
        ])
    ]);

    const totalRevenue = revenue[0]?.total || 0;
    const totalExpenses = expenses[0]?.total || 0;

    return {
        period: { start: startDate, end: endDate },
        revenue: totalRevenue,
        expenses: totalExpenses,
        netProfit: totalRevenue - totalExpenses,
        pendingLocks: locks[0]?.total || 0,
        deposits: { total: deposits[0]?.total || 0, count: deposits[0]?.count || 0 },
        withdrawals: { total: withdrawals[0]?.total || 0, count: withdrawals[0]?.count || 0 }
    };
};

// ═══════════════════════════════════════════════════════════
//  STATICS — Lock/Capture/Release Tracking (NEW)
// ═══════════════════════════════════════════════════════════

/**
 * NEW: Get pending lock transactions for a user
 * Useful for debugging fund locks
 */
transactionSchema.statics.getPendingLocks = async function(userId) {
    return this.find({
        userId,
        type: TRANSACTION_TYPES.LOCK,
        status: 'PENDING'
    }).sort({ createdAt: -1 }).lean();
};

/**
 * NEW: Get all transactions for a specific lock (by txId)
 * Shows lock → capture → release lifecycle
 */
transactionSchema.statics.getLockLifecycle = async function(lockTxId) {
    const lockTx = await this.findOne({ txId: lockTxId }).lean();
    if (!lockTx) return null;

    const related = await this.find({
        userId: lockTx.userId,
        'metadata.lockTxId': lockTxId
    }).sort({ createdAt: 1 }).lean();

    return {
        lock: lockTx,
        related: related
    };
};

/**
 * NEW: Find lock transaction by purpose (e.g., OTP_Amazon)
 */
transactionSchema.statics.findLockByPurpose = async function(userId, purpose) {
    return this.findOne({
        userId,
        type: TRANSACTION_TYPES.LOCK,
        'metadata.purpose': purpose,
        status: 'PENDING'
    }).sort({ createdAt: -1 }).lean();
};

// ═══════════════════════════════════════════════════════════
//  STATICS — Deposit Tracking
// ═══════════════════════════════════════════════════════════

transactionSchema.statics.findByTxHash = async function(txHash) {
    return this.findOne({ 'blockchain.txHash': txHash }).lean();
};

transactionSchema.statics.getPendingDepositsCount = async function() {
    return this.countDocuments({ type: TRANSACTION_TYPES.DEPOSIT, status: 'PENDING' });
};

transactionSchema.statics.getPendingDeposits = async function(limit = 50) {
    return this.find({ 
        type: TRANSACTION_TYPES.DEPOSIT, 
        status: 'PENDING' 
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// ═══════════════════════════════════════════════════════════
//  STATICS — Export & Data
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

// ═══════════════════════════════════════════════════════════
//  STATICS — Admin Dashboard Helpers
// ═══════════════════════════════════════════════════════════

/**
 * Get transaction counts by status (for admin dashboard)
 */
transactionSchema.statics.getStatusCounts = async function(since) {
    const match = since ? { createdAt: { $gte: since } } : {};
    return this.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
};

/**
 * Get recent transactions with pagination (admin view)
 */
transactionSchema.statics.getRecent = async function(page = 1, limit = 50, filters = {}) {
    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
        this.find(filters)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        this.countDocuments(filters)
    ]);
    return { transactions, total, page, pages: Math.ceil(total / limit) };
};

// ═══════════════════════════════════════════════════════════
//  MODEL EXPORT
// ═══════════════════════════════════════════════════════════

const Transaction = mongoose.model('Transaction', transactionSchema);

export default Transaction;
                    
