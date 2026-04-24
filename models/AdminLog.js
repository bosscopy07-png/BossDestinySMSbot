import mongoose from 'mongoose';

const adminLogSchema = new mongoose.Schema({
    logId: {
        type: String,
        required: true,
        unique: true
    },
    type: {
        type: String,
        required: true
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
        required: true
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

adminLogSchema.index({ adminId: 1, createdAt: -1 });
adminLogSchema.index({ targetUserId: 1, createdAt: -1 });

const AdminLog = mongoose.model('AdminLog', adminLogSchema);

export default AdminLog;
