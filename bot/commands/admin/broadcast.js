// bot/commands/admin/broadcast.js — Broadcast and referral approval
// Methods are mixed into AdminCommands.prototype by bot/commands/admin.js (bodies unchanged: `this` is the AdminCommands instance).
import { Markup } from 'telegraf';
import { User, Transaction } from '../../../models/index.js';
import { formatCurrency } from '../../../utils/helpers.js';
import logger from '../../../utils/logger.js';
import { TX_TYPES, ADMIN_STATE } from './constants.js';

export const broadcastMethods = {
    // ═══════════════════════════════════════════════════════════
    //  BROADCAST (Fixed Flow)
    // ═══════════════════════════════════════════════════════════

    

    
async handleBroadcastMenu(ctx) {
        try {
            const stats = await this.getBroadcastStats();

            await this.replySuccess(ctx, `
<b>📢 Broadcast Menu</b>

<b>👥 Audience Stats:</b>
• Total Users: <code>${stats.total}</code>
• VIP Users: <code>${stats.vip}</code>
• Paying Users: <code>${stats.paying}</code>
• Recent (7d): <code>${stats.recent}</code>

<i>Select the target audience below.</i>
            `, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('📨 All Users', 'broadcast_all')],
                    [Markup.button.callback('👑 VIP Only', 'broadcast_vip')],
                    [Markup.button.callback('💰 Paying Users', 'broadcast_paying')],
                    [Markup.button.callback('🆕 Recent (7d)', 'broadcast_recent')],
                    [Markup.button.callback('🎯 Custom', 'broadcast_custom')],
                    [Markup.button.callback('❌ Cancel', 'broadcast_cancel')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Broadcast menu error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load broadcast menu.</b>');
        }
    },

    async getBroadcastStats() {
        const now = new Date();
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

        const [total, vip, paying, recent] = await Promise.all([
            User.countDocuments({ isBlacklisted: false }),
            User.countDocuments({ isBlacklisted: false, vipExpiry: { $gt: now } }),
            User.countDocuments({ isBlacklisted: false, balance: { $gt: 0 } }),
            User.countDocuments({ isBlacklisted: false, createdAt: { $gte: weekAgo } })
        ]);

        return { total, vip, paying, recent };
    },

    async executeBroadcast(ctx, filter, label, forcedMessage = null) {
        try {
            // If no message provided, ask admin to type it
            if (!forcedMessage) {
                this._ensureSession(ctx);
                ctx.session.awaitingBroadcast = { target: label, filter, label };
                return this.replySuccess(ctx, `
<b>📢 Broadcast to ${label}</b>

Send the message you want to broadcast to <code>${label}</code>.

<i>Type your message and send it. It will be delivered to all matching users.</i>
                `);
            }

            // Acknowledge callback if present
            if (ctx.callbackQuery && ctx.answerCbQuery) {
                await ctx.answerCbQuery(`Broadcasting to ${label}...`).catch(() => {});
            }

            const query = { isBlacklisted: false, ...filter };
            const users = await User.find(query).select('userId').lean();
            const results = { sent: 0, failed: 0, total: users.length };
            const batchSize = 30;

            logger.info('Broadcast started', { targetCount: users.length, label, filter });

            for (let i = 0; i < users.length; i += batchSize) {
                const batch = users.slice(i, i + batchSize);

                await Promise.all(batch.map(async (user) => {
                    try {
                        await ctx.telegram.sendMessage(user.userId, `
<b>📢 ${label}</b>

${forcedMessage}

---
<i>OTP Bot Team</i>
                        `, { parse_mode: 'HTML', disable_notification: false });
                        results.sent++;
                    } catch (error) {
                        results.failed++;
                        if (error.response?.error_code === 403) {
                            // User blocked bot
                            await User.updateOne(
                                { userId: user.userId },
                                { $set: { blockedBot: true } } // blocking the bot is NOT fraud: never blacklist for it
                            ).catch(() => {});
                        }
                        logger.warn('Broadcast failed for user', { userId: user.userId, error: error.message });
                    }
                }));

                // Rate limit protection between batches
                if (i + batchSize < users.length) {
                    await new Promise(r => setTimeout(r, 1000));
                }

                // Progress update every 5 batches (FIXED: i > 0 check)
                if (i > 0 && (i / batchSize) % 5 === 0) {
                    await ctx.reply(`⏳ Broadcast progress: ${results.sent}/${results.total} sent...`).catch(() => {});
                }
            }

            logger.info('Broadcast completed', results);

            await this.replySuccess(ctx, `
<b>📢 Broadcast Complete!</b>

<b>Target:</b> <code>${label}</code>
<b>Total:</b> <code>${results.total}</code>
<b>✅ Sent:</b> <code>${results.sent}</code>
<b>❌ Failed:</b> <code>${results.failed}</code>
<b>Success Rate:</b> <code>${results.total > 0 ? ((results.sent / results.total) * 100).toFixed(1) : 0}%</code>
            `);

        } catch (error) {
            logger.error('Broadcast execution error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Broadcast failed.</b>\n\nPlease check the logs.');
        }
    },

    async handleBroadcastAll(ctx) {
        await this.executeBroadcast(ctx, {}, 'All Users');
    },

    async handleBroadcastVip(ctx) {
        const now = new Date();
        await this.executeBroadcast(ctx, { vipExpiry: { $gt: now } }, 'VIP Users');
    },

    async handleBroadcastPaying(ctx) {
        await this.executeBroadcast(ctx, { balance: { $gt: 0 } }, 'Paying Users');
    },

    async handleBroadcastRecent(ctx) {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await this.executeBroadcast(ctx, { createdAt: { $gte: weekAgo } }, 'Recent Users');
    },

    async handleBroadcastCustom(ctx) {
        this._setAdminState(ctx, ADMIN_STATE.AWAITING_CUSTOM_BROADCAST_FILTER, {});
        await this.replySuccess(ctx, `
<b>🎯 Custom Broadcast</b>

Send a MongoDB-style filter query as text.

<i>Example: <code>{"balance": {"$gt": 10}}</code></i>

Or just send a message to broadcast to all users with custom text.
        `);
    },

    async handleBroadcastCancel(ctx) {
        if (ctx.session) {
            delete ctx.session.awaitingBroadcast;
        }
        if (ctx.answerCbQuery) await ctx.answerCbQuery('Cancelled').catch(() => {});
        await this.replySuccess(ctx, '❌ <b>Broadcast cancelled.</b>');
    },

    // ═══════════════════════════════════════════════════════════
    //  REFERRAL MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    
async handleApproveReferral(ctx) {
        try {
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                return this.replyError(ctx, '❌ <b>Usage:</b> <code>/approve_referral &lt;tx_id&gt;</code>');
            }

            const txId = args[1];
            const tx = await Transaction.findOne({ txId, type: TX_TYPES.REFERRAL_REWARD, status: 'PENDING' });

            if (!tx) {
                return this.replyError(ctx, '❌ <b>Referral transaction not found or already processed.</b>');
            }

            await User.updateOne(
                { userId: tx.userId },
                { $inc: { balance: tx.amount, referralRewardsPending: -tx.amount } }
            );

            await Transaction.updateOne(
                { txId },
                {
                    $set: {
                        status: 'COMPLETED',
                        approvedBy: ctx.from.id.toString(),
                        approvedAt: new Date()
                    }
                }
            );

            await this.replySuccess(ctx, `✅ <b>Referral Reward Approved!</b>\n\nAmount: <code>${formatCurrency(tx.amount)}</code>\nUser: <code>${tx.userId}</code>`);

            // Notify user
            await ctx.telegram.sendMessage(tx.userId, `
<b>🎁 Referral Reward Approved!</b>

Amount: <code>${formatCurrency(tx.amount)}</code>
Status: <b>Credited to your balance</b>

Thank you for referring users!
            `, { parse_mode: 'HTML' }).catch(() => {});

            await this.logAdminAction(ctx.from.id.toString(), 'APPROVE_REFERRAL', tx.userId, { txId, amount: tx.amount });

        } catch (error) {
            logger.error('Approve referral error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to approve referral.</b>');
        }
    },

    async handleRejectReferral(ctx) {
        try {
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                return this.replyError(ctx, '❌ <b>Usage:</b> <code>/reject_referral &lt;tx_id&gt; [reason]</code>');
            }

            const txId = args[1];
            const reason = args.slice(2).join(' ') || 'Rejected by admin';

            const tx = await Transaction.findOne({ txId, type: TX_TYPES.REFERRAL_REWARD, status: 'PENDING' });
            if (!tx) {
                return this.replyError(ctx, '❌ <b>Referral transaction not found or already processed.</b>');
            }

            await Transaction.updateOne(
                { txId },
                {
                    $set: {
                        status: 'REJECTED',
                        rejectedBy: ctx.from.id.toString(),
                        rejectedAt: new Date(),
                        rejectionReason: reason
                    }
                }
            );

            await User.updateOne(
                { userId: tx.userId },
                { $inc: { referralRewardsPending: -tx.amount } }
            );

            await this.replySuccess(ctx, `❌ <b>Referral Reward Rejected</b>\n\nTxID: <code>${txId}</code>\nReason: <i>${reason}</i>`);

            // Notify user
            await ctx.telegram.sendMessage(tx.userId, `
<b>❌ Referral Reward Rejected</b>

Amount: <code>${formatCurrency(tx.amount)}</code>
Reason: <i>${reason}</i>

Contact support if you have questions.
            `, { parse_mode: 'HTML' }).catch(() => {});

            await this.logAdminAction(ctx.from.id.toString(), 'REJECT_REFERRAL', tx.userId, { txId, reason });

        } catch (error) {
            logger.error('Reject referral error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to reject referral.</b>');
        }
    }
};

export default broadcastMethods;
