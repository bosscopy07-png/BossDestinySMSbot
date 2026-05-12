import mongoose from 'mongoose';
import { generateId } from '../utils/helpers.js';

// ───────────────────────────────────────────────────────────
//  Notification Schema
// ───────────────────────────────────────────────────────────

const notificationSchema = new mongoose.Schema(
    {
        notificationId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => generateId()
        },

        userId: {
            type: String,
            required: true,
            index: true
        },

        // Channel: where to deliver (telegram, in-app, email, push)
        channel: {
            type: String,
            enum: ['TELEGRAM', 'IN_APP', 'EMAIL', 'PUSH'],
            default: 'TELEGRAM'
        },

        // Type of notification event
        type: {
            type: String,
            required: true,
            enum: [
                'REFERRAL_JOINED',
                'REFERRAL_DEPOSITED',
                'REFERRAL_REWARDED',
                'REFERRAL_REJECTED',
                'REFERRAL_BELOW_MINIMUM',
                'DEPOSIT_CONFIRMED',
                'WITHDRAWAL_PROCESSED',
                'SYSTEM'
            ]
        },

        // Display content
        title: {
            type: String,
            required: true
        },

        message: {
            type: String,
            required: true
        },

        // Delivery status
        status: {
            type: String,
            enum: ['PENDING', 'SENT', 'FAILED', 'READ'],
            default: 'PENDING'
        },

        // For Telegram: chat ID to send to
        telegramChatId: {
            type: String,
            index: true
        },

        // Read tracking (for in-app)
        read: {
            type: Boolean,
            default: false
        },

        readAt: {
            type: Date
        },

        // Retry logic for failed sends
        retryCount: {
            type: Number,
            default: 0
        },

        maxRetries: {
            type: Number,
            default: 3
        },

        // Flexible metadata for event-specific data
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },

        // Soft delete
        deleted: {
            type: Boolean,
            default: false
        },

        deletedAt: {
            type: Date
        }
    },
    {
        timestamps: true, // adds createdAt, updatedAt
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

// ───────────────────────────────────────────────────────────
//  Indexes
// ───────────────────────────────────────────────────────────

// Fetch unread notifications for a user quickly
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

// Fetch pending notifications for processing
notificationSchema.index({ status: 1, channel: 1, createdAt: 1 });

// Fetch Telegram-specific pending
notificationSchema.index({ status: 1, channel: 1, telegramChatId: 1 });

// ───────────────────────────────────────────────────────────
//  Pre-save Hook
// ───────────────────────────────────────────────────────────

notificationSchema.pre('save', function (next) {
    if (!this.notificationId) {
        this.notificationId = generateId();
    }
    next();
});

// ───────────────────────────────────────────────────────────
//  Instance Methods
// ───────────────────────────────────────────────────────────

// Mark as sent
notificationSchema.methods.markSent = async function () {
    this.status = 'SENT';
    return this.save();
};

// Mark as failed with retry tracking
notificationSchema.methods.markFailed = async function (errorMessage) {
    this.retryCount += 1;
    this.metadata.lastError = errorMessage;

    if (this.retryCount >= this.maxRetries) {
        this.status = 'FAILED';
    }

    return this.save();
};

// Mark as read
notificationSchema.methods.markRead = async function () {
    this.read = true;
    this.readAt = new Date();
    this.status = 'READ';
    return this.save();
};

// Soft delete
notificationSchema.methods.softDelete = async function () {
    this.deleted = true;
    this.deletedAt = new Date();
    return this.save();
};

// ───────────────────────────────────────────────────────────
//  Static Methods
// ───────────────────────────────────────────────────────────

// Get unread count for a user
notificationSchema.statics.getUnreadCount = async function (userId) {
    return this.countDocuments({
        userId,
        read: false,
        deleted: false
    });
};

// Get pending notifications for processing (batch)
notificationSchema.statics.getPendingBatch = async function (channel, limit = 50) {
    return this.find({
        status: 'PENDING',
        channel,
        deleted: false
    })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();
};

// Get user's notification feed (paginated)
notificationSchema.statics.getUserFeed = async function (userId, options = {}) {
    const { page = 1, limit = 20, unreadOnly = false } = options;
    const skip = (page - 1) * limit;

    const query = {
        userId,
        deleted: false,
        ...(unreadOnly ? { read: false } : {})
    };

    const [notifications, total] = await Promise.all([
        this.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),

        this.countDocuments(query)
    ]);

    return {
        notifications,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

// Mark all as read for a user
notificationSchema.statics.markAllRead = async function (userId) {
    const result = await this.updateMany(
        { userId, read: false, deleted: false },
        { $set: { read: true, readAt: new Date(), status: 'READ' } }
    );

    return result.modifiedCount;
};

// ───────────────────────────────────────────────────────────
//  Export
// ───────────────────────────────────────────────────────────

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;
