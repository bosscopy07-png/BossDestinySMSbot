
import { Notification } from '../models/index.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════
//  NotificationService
//  Handles creating, queuing, and delivering notifications
// ═══════════════════════════════════════════════════════════

class NotificationService {
    constructor(telegramInstance = null) {
        // Support both Telegraf bot (bot.telegram) and raw telegram instances
        this.telegram = telegramInstance;
    }

    // ─── Core: Create and optionally send immediately ───
    async send(userId, payload) {
        const {
            type,
            title,
            message,
            channel = 'TELEGRAM',
            telegramChatId = null,
            immediate = true, // send now vs queue for later
            metadata = {}
        } = payload;

        try {
            // Create notification record
            const notification = await Notification.create({
                userId,
                type,
                title,
                message,
                channel,
                telegramChatId,
                metadata,
                status: immediate ? 'PENDING' : 'PENDING' // always start PENDING
            });

            // Send immediately if requested and channel available
            if (immediate && channel === 'TELEGRAM' && this.telegram && telegramChatId) {
                await this._sendTelegram(notification);
            }

            return notification;

        } catch (error) {
            logger.error('Failed to create/send notification', {
                userId,
                type,
                error: error.message
            });
            throw error;
        }
    }

    // ─── Send to Telegram bot ───
    async _sendTelegram(notification) {
        if (!this.telegram || !notification.telegramChatId) {
            logger.warn('Telegram bot or chatId missing, notification queued', {
                notificationId: notification.notificationId
            });
            return notification;
        }

        try {
            await this.telegram.sendMessage(
                notification.telegramChatId,
                this._formatTelegramMessage(notification),
                { parse_mode: 'HTML' }
            );

            await notification.markSent();

            logger.info('Telegram notification sent', {
                notificationId: notification.notificationId,
                chatId: notification.telegramChatId
            });

        } catch (error) {
            logger.error('Telegram send failed', {
                notificationId: notification.notificationId,
                error: error.message
            });

            await notification.markFailed(error.message);
        }

        return notification;
    }

    // ─── Format message for Telegram HTML ───
    _formatTelegramMessage(notification) {
        const { title, message, type } = notification;

        const icons = {
            REFERRAL_JOINED: '🎉',
            REFERRAL_DEPOSITED: '💰',
            REFERRAL_REWARDED: '✅',
            REFERRAL_REJECTED: '❌',
            REFERRAL_BELOW_MINIMUM: '📉',
            DEPOSIT_CONFIRMED: '💵',
            WITHDRAWAL_PROCESSED: '🏦',
            SYSTEM: '📢'
        };

        const icon = icons[type] || '🔔';

        return `
<b>${icon} ${title}</b>

${message}

<i>— ${new Date().toLocaleString()}</i>
        `.trim();
    }

    // ─── Batch process pending notifications (run via cron/job) ───
    async processPendingBatch(channel = 'TELEGRAM', limit = 50) {
        const pending = await Notification.getPendingBatch(channel, limit);

        const results = await Promise.allSettled(
            pending.map((n) => this._processOne(n))
        );

        const summary = results.reduce(
            (acc, result, index) => {
                const notification = pending[index];
                if (result.status === 'fulfilled') {
                    acc.sent += 1;
                } else {
                    acc.failed += 1;
                    logger.error('Batch notification failed', {
                        notificationId: notification.notificationId,
                        error: result.reason?.message
                    });
                }
                return acc;
            },
            { sent: 0, failed: 0, total: pending.length }
        );

        logger.info('Notification batch processed', summary);
        return summary;
    }

    // ─── Process a single pending notification ───
    async _processOne(notification) {
        const doc = await Notification.findOne({
            notificationId: notification.notificationId
        });

        if (!doc || doc.status !== 'PENDING') return doc;

        if (doc.channel === 'TELEGRAM') {
            return this._sendTelegram(doc);
        }

        // Add other channels here (email, push, etc.)
        return doc;
    }

    // ─── Get user's notification feed ───
    async getUserFeed(userId, options = {}) {
        return Notification.getUserFeed(userId, options);
    }

    // ─── Mark single notification as read ───
    async markRead(notificationId, userId) {
        const notification = await Notification.findOne({
            notificationId,
            userId,
            deleted: false
        });

        if (!notification) {
            throw new Error('NOTIFICATION_NOT_FOUND');
        }

        return notification.markRead();
    }

    // ─── Mark all as read ───
    async markAllRead(userId) {
        return Notification.markAllRead(userId);
    }

    // ─── Get unread count ───
    async getUnreadCount(userId) {
        return Notification.getUnreadCount(userId);
    }
}

export default NotificationService;
            
