// bot/commands/extra/finance.js — Refunds, transaction adjustments, balance freeze/add/deduct, invoices and tax export
// Mixed into the Admin class by bot/commands/extra.js (bodies unchanged: `this` is the Admin instance).
import logger from '../../../utils/logger.js';
import { ADMIN_IMAGE_URL, safeEditWithImage } from './helpers.js';

export const financeMethods = {
    // ─── 17. Add Balance ───
        

    
async processAddBalance(ctx, targetId, amount, reason = 'Admin credit') {
        try {
            const { User, Transaction } = await import('../../../models/index.js');
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { $inc: { balance: amount } },
                { new: true }
            );

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML' 
                });
            }

            await Transaction.create({
                userId: targetId,
                type: 'ADMIN_CREDIT',
                amount: amount,
                status: 'COMPLETED',
                reason: reason,
                adminId: ctx.from.id.toString(),
                createdAt: new Date()
            });

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `💰 <b>Balance Added</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `💵 Amount: <b>$${amount.toFixed(2)}</b>\n` +
                    `📝 Reason: <i>${reason}</i>\n` +
                    `💳 New Balance: <b>$${user.balance.toFixed(2)}</b>`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Add balance failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    // ─── 18. Deduct Balance ───
    

    
async processDeductBalance(ctx, targetId, amount, reason = 'Admin deduction') {
        try {
            const { User, Transaction } = await import('../../../models/index.js');
            
            const user = await User.findOne({ userId: targetId });
            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML' 
                });
            }

            if (user.balance < amount) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                    caption: 
                        `❌ <b>Insufficient Balance</b>\n\n` +
                        `👤 User: <code>${targetId}</code>\n` +
                        `💰 Current: <b>$${user.balance.toFixed(2)}</b>\n` +
                        `💸 Requested: <b>$${amount.toFixed(2)}</b>`,
                    parse_mode: 'HTML'
                });
            }

            await User.updateOne(
                { userId: targetId },
                { $inc: { balance: -amount } }
            );

            await Transaction.create({
                userId: targetId,
                type: 'ADMIN_DEBIT',
                amount: -amount,
                status: 'COMPLETED',
                reason: reason,
                adminId: ctx.from.id.toString(),
                createdAt: new Date()
            });

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `💸 <b>Balance Deducted</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `💵 Amount: <b>$${amount.toFixed(2)}</b>\n` +
                    `📝 Reason: <i>${reason}</i>\n` +
                    `💳 New Balance: <b>$${(user.balance - amount).toFixed(2)}</b>`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Deduct balance failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    // ═══════════════════════════════════════════════════════
    //  FINANCIAL FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 26. Manual Refund ───
    
async promptRefund(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingRefund = true;
        
        await safeEditWithImage(ctx,
            `↩️ <b>Manual Refund</b>\n\n` +
            `Send: <code>USER_ID AMOUNT REASON</code>\n` +
            `Example: <code>123456789 10.50 Service outage</code>\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processRefund(ctx, targetId, amount, reason) {
        try {
            const { User, Transaction } = await import('../../../models/index.js');
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { $inc: { balance: amount } },
                { new: true }
            );

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML' 
                });
            }

            await Transaction.create({
                userId: targetId,
                type: 'REFUND',
                amount: amount,
                status: 'COMPLETED',
                reason: reason,
                createdAt: new Date()
            });

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `↩️ <b>Refund Processed</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `💰 Amount: <b>$${amount.toFixed(2)}</b>\n` +
                    `📝 Reason: <i>${reason}</i>\n` +
                    `💳 New Balance: <b>$${user.balance.toFixed(2)}</b>`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });

        } catch (error) {
            logger.error('Refund failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    },

    // ─── 27. Adjust Transaction ───
    
async promptAdjustTransaction(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingAdjustTx = true;
        
        await safeEditWithImage(ctx,
            `✏️ <b>Adjust Transaction</b>\n\n` +
            `Send: <code>TX_ID NEW_AMOUNT</code>\n` +
            `Example: <code>507f1f77bcf86cd799439011 25.00</code>\n\n` +
            `⚠️ This modifies historical data!\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processAdjustTransaction(ctx, txId, newAmount) {
        try {
            const { Transaction } = await import('../../../models/index.js');
            // Atomic claim: only a not-yet-completed tx can be force-confirmed (no double credit)
            const mongoose = (await import('mongoose')).default;
            const filter = mongoose.isValidObjectId(txId)
                ? { _id: txId, status: { $ne: 'COMPLETED' } }
                : { txId, status: { $ne: 'COMPLETED' } };
            const tx = await Transaction.findOneAndUpdate(
                filter,
                { $set: { status: 'COMPLETED', confirmedBy: ctx.from.id.toString(), confirmedAt: new Date(),
                          'metadata.manualCredit': true, 'metadata.manualCreditBy': ctx.from.id.toString() } },
                { new: true }
            );

            if (!tx) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                    caption: `❌ Transaction <code>${txId}</code> not found or already completed (no credit applied).`,
                    parse_mode: 'HTML'
                });
            }

            await User.updateOne(
                { userId: tx.userId },
                { $inc: { balance: tx.amount, totalDeposited: tx.amount } }
            );
            try {
                const { AdminLog } = await import('../../../models/index.js');
                await AdminLog.create({ adminId: ctx.from.id.toString(), action: 'FORCE_CONFIRM_DEPOSIT',
                    targetUserId: tx.userId, details: { txId: tx.txId, amount: tx.amount } });
            } catch (_) { /* audit best-effort */ }

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `✅ <b>Deposit Confirmed</b>\n\n` +
                    `🆔 TX: <code>${txId}</code>\n` +
                    `👤 User: <code>${tx.userId}</code>\n` +
                    `💰 Amount: <b>$${tx.amount?.toFixed(2) || '0.00'}</b>\n` +
                    `⏰ Confirmed: <i>${new Date().toLocaleString()}</i>`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });

        } catch (error) {
            logger.error('Force confirm failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    },

    // ─── 40. Geo-Fencing ───
    

    // ═══════════════════════════════════════════════════════
    //  AUTOMATION FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 41. Smart Refund Bot ───
    
async handleSmartRefund(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🧠 Checking smart refunds...');

        try {
            const { Transaction } = await import('../../../models/index.js');
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            
            const stuck = await Transaction.find({
                type: 'DEPOSIT',
                status: 'PENDING',
                createdAt: { $lt: oneDayAgo }
            }).limit(10);

            let text = `🧠 <b>Smart Refund Candidates</b>\n\n`;
            
            if (stuck.length === 0) {
                text += `<i>No stuck deposits found. All good!</i>`;
            } else {
                text += `⚠️ <b>${stuck.length} stuck deposits (>24h):</b>\n\n`;
                stuck.forEach((tx, i) => {
                    text += `${i + 1}. <code>${tx.userId}</code>\n` +
                           `   💰 Amount: <b>$${tx.amount?.toFixed(2) || '0.00'}</b>\n` +
                           `   ⏰ Age: <b>${Math.floor((Date.now() - tx.createdAt) / 3600000)}h</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                                                [{ text: '🔄 Refresh', callback_data: 'admin_smart_refund' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Smart refund failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    },

    async promptBalanceFreeze(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingBalanceFreeze = true;
        
        await safeEditWithImage(ctx,
            `🔒 <b>Balance Freeze/Unfreeze</b>\n\n` +
            `Send: <code>USER_ID freeze|unfreeze REASON</code>\n` +
            `Example: <code>123456789 freeze Investigation pending</code>\n\n` +
            `⚠️ Frozen users can still use bot but cannot withdraw/transfer.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processBalanceFreeze(ctx, targetId, action, reason) {
        try {
            const { User } = await import('../../../models/index.js');
            
            const isFrozen = action === 'freeze';
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { 
                    $set: { 
                        balanceFrozen: isFrozen,
                        balanceFrozenAt: isFrozen ? new Date() : null,
                        balanceFrozenReason: isFrozen ? reason : null,
                        balanceFrozenBy: isFrozen ? ctx.from.id.toString() : null
                    } 
                },
                { new: true }
            );

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML' 
                });
            }

            const status = isFrozen ? '🔒 FROZEN' : '🔓 UNFROZEN';
            
            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `${status} <b>Balance Updated</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `💰 Balance: <b>$${user.balance?.toFixed(2) || '0.00'}</b>\n` +
                    `📊 Status: <b>${status}</b>\n` +
                    `${isFrozen ? `📝 Reason: <i>${reason}</i>\n` : ''}` +
                    `${isFrozen ? `⏰ Frozen at: <i>${new Date().toLocaleString()}</i>\n` : ''}`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Balance freeze failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
        },

                   async handleInvoiceGenerator(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🧾 Generating invoice...');

        await safeEditWithImage(ctx,
            `🧾 <b>Invoice Generator</b>\n\n` +
            `Send: <code>USER_ID MONTH</code>\n` +
            `Example: <code>123456789 2026-05</code>\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processInvoice(ctx, targetId, month) {
        try {
            const { User, Transaction } = await import('../../../models/index.js');
            
            const [startDate, endDate] = [
                new Date(`${month}-01`),
                new Date(`${month}-01T23:59:59.999Z`)
            ];
            endDate.setMonth(endDate.getMonth() + 1);

            const user = await User.findOne({ userId: targetId });
            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML' 
                });
            }

            const txs = await Transaction.find({
                userId: targetId,
                createdAt: { $gte: startDate, $lt: endDate },
                status: 'COMPLETED'
            });

            const total = txs.reduce((sum, tx) => sum + (tx.amount || 0), 0);

            const invoiceText = 
                `🧾 <b>INVOICE</b>\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `To: <b>${user.firstName || 'Customer'} ${user.lastName || ''}</b>\n` +
                `ID: <code>${targetId}</code>\n` +
                `Period: <b>${month}</b>\n\n` +
                `Items: <b>${txs.length}</b>\n` +
                `Total: <b>$${total.toFixed(2)}</b>\n\n` +
                `━━━━━━━━━━━━━━━\n` +
                `Thank you for your business!`;

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: invoiceText,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });

        } catch (error) {
            logger.error('Invoice failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    },

    async handleTaxExport(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📑 Generating tax report...');

        try {
            const { Transaction } = await import('../../../models/index.js');
            
            const year = new Date().getFullYear();
            const startOfYear = new Date(`${year}-01-01`);
            
            const report = await Transaction.aggregate([
                { $match: { status: 'COMPLETED', createdAt: { $gte: startOfYear } } },
                { $group: { 
                    _id: { $month: '$createdAt' }, 
                    revenue: { $sum: '$amount' },
                    count: { $sum: 1 }
                }},
                { $sort: { _id: 1 } }
            ]);

            let csv = `Month,Revenue,Transactions\n`;
            let totalRevenue = 0;
            
            report.forEach(r => {
                const monthName = new Date(2026, r._id - 1).toLocaleString('default', { month: 'long' });
                csv += `${monthName},${r.revenue.toFixed(2)},${r.count}\n`;
                totalRevenue += r.revenue;
            });

            csv += `TOTAL,${totalRevenue.toFixed(2)},${report.reduce((a, b) => a + b.count, 0)}\n`;

            await ctx.replyWithDocument({
                source: Buffer.from(csv),
                filename: `tax_report_${year}.csv`
            }, {
                caption: `📑 <b>Tax Report ${year}</b>\n\nTotal Revenue: <b>$${totalRevenue.toFixed(2)}</b>`,
                parse_mode: 'HTML'
            });

        } catch (error) {
            logger.error('Tax export failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_finance' }]] }
            });
        }
    }
};

export default financeMethods;


    

    

    

    

    

    

    

    

    

    

                
      
