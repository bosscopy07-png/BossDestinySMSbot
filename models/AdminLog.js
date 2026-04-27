import mongoose from 'mongoose';

const adminLogSchema = new mongoose.Schema({
    logId: {
        type: String,
        required: true,
        unique: true    // ← Auto-creates unique index
    },
    type: {
        type: String,
        required: true,
        index: true     // ← For filtering by log type
    },
    adminId: {
        type: String,
        required: true,
        index: true
    },
    targetUserId: {
        type: String,
        default: null,
        index: true
    },
    action: {
        type: String,
        required: true,
        index: true     // ← For action-based queries
    },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    ipAddress: {
        type: String,
        default: null
    },
    userAgent: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

// ═══════════════════════════════════════════════════════════
//  COMPOUND INDEXES
// ═══════════════════════════════════════════════════════════

// Admin activity feed
adminLogSchema.index({ adminId: 1, createdAt: -1 });

// User audit trail
adminLogSchema.index({ targetUserId: 1, createdAt: -1 });

// Action history
adminLogSchema.index({ action: 1, createdAt: -1 });

// Type-based queries
adminLogSchema.index({ type: 1, createdAt: -1 });

// Dashboard: recent activity across all admins
adminLogSchema.index({ createdAt: -1 });

// ═══════════════════════════════════════════════════════════
//  STATICS
// ═══════════════════════════════════════════════════════════

/**
 * Get recent logs with pagination
 */
adminLogSchema.statics.getRecent = async function(page = 1, limit = 50, filters = {}) {
    const query = {};
    if (filters.adminId) query.adminId = filters.adminId;
    if (filters.action) query.action = filters.action;
    if (filters.targetUserId) query.targetUserId = filters.targetUserId;
    if (filters.type) query.type = filters.type;
    
    if (filters.dateFrom || filters.dateTo) {
        query.createdAt = {};
        if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
        if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
    }

    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
        this.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        this.countDocuments(query)
    ]);

    return { logs, total, page, pages: Math.ceil(total / limit) };
};

/**
 * Get activity summary for an admin
 */
adminLogSchema.statics.getAdminSummary = async function(adminId, since) {
    return this.aggregate([
        { $match: { adminId, createdAt: { $gte: since } } },
        {
            $group: {
                _id: '$action',
                count: { $sum: 1 }
            }
        },
        { $sort: { count: -1 } }
    ]);
};

/**
 * Log an action (convenience wrapper)
 */
adminLogSchema.statics.log = async function({ logId, type, adminId, targetUserId, action, details, ipAddress, userAgent }) {
    return this.create({
        logId: logId || Math.random().toString(36).substring(2, 15),
        type: type || 'ADMIN_ACTION',
        adminId,
        targetUserId,
        action,
        details,
        ipAddress,
        userAgent
    });
};

const AdminLog = mongoose.model('AdminLog', adminLogSchema);

export default AdminLog;
    
