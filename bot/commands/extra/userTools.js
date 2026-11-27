// bot/commands/extra/userTools.js — User search, blacklist/whitelist, history & session reset, impersonation, messaging, notes, shadow ban, merge, broadcast
// Mixed into the Admin class by bot/commands/extra.js (bodies unchanged: `this` is the Admin instance).
import logger from '../../../utils/logger.js';
import { ADMIN_IMAGE_URL, safeEditWithImage } from './helpers.js';

export const userToolsMethods = {
    // ═══════════════════════════════════════════════════════
    //  USER MANAGEMENT FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 16. Search User ───
    
async promptSearchUser(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingSearchUser = true;
        
        await safeEditWithImage(ctx,
            `🔍 <b>Search User</b>\n\n` +
            `Send <b>User ID</b>, <b>Username</b>, or <b>Wallet Address</b> to search.\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processSearchUser(ctx, query) {
        try {
            const { User } = await import('../../../models/index.js');
            
            let user;
            if (/^\d+$/.test(query)) {
                user = await User.findOne({ userId: query });
            } else if (query.startsWith('0x')) {
                user = await User.findOne({ walletAddress: query });
            } else {
                user = await User.findOne({ username: query.replace('@', '') });
            }

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ No user found for: <code>${query}</code>`, 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                });
            }

            const text = 
                `👤 <b>User Found</b>\n\n` +
                `🆔 ID: <code>${user.userId}</code>\n` +
                `👤 Name: <b>${user.firstName || 'N/A'} ${user.lastName || ''}</b>\n` +
                `📛 Username: <b>@${user.username || 'N/A'}</b>\n` +
                `💰 Balance: <b>$${user.balance?.toFixed(2) || '0.00'}</b>\n` +
                `🔒 Locked: <b>$${user.lockedBalance?.toFixed(2) || '0.00'}</b>\n` +
                `📊 Total Spent: <b>$${user.totalSpent?.toFixed(2) || '0.00'}</b>\n` +
                `📥 Total Deposited: <b>$${user.totalDeposited?.toFixed(2) || '0.00'}</b>\n` +
                `🚫 Blacklisted: <b>${user.blacklisted ? 'YES 🔴' : 'No 🟢'}</b>\n` +
                `👑 VIP: <b>${user.isVip ? 'YES 🟢' : 'No'}</b>\n` +
                `📅 Joined: <i>${user.createdAt?.toLocaleDateString() || 'N/A'}</i>\n` +
                `📱 Last Active: <i>${user.lastActive?.toLocaleDateString() || 'N/A'}</i>`;

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: text,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '💰 Add Balance', callback_data: `admin_add_bal_${user.userId}` },
                            { text: '💸 Deduct', callback_data: `admin_ded_bal_${user.userId}` }
                        ],
                        [
                            { text: '🚫 Blacklist', callback_data: `admin_blacklist_${user.userId}` },
                            { text: '💬 Message', callback_data: `admin_msg_${user.userId}` }
                        ],
                        [{ text: '◀️ Back to Users', callback_data: 'admin_back_users' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Search user failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    // ─── 19. Blacklist User ───
    
async promptBlacklist(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingBlacklistReason = true;
        
        await safeEditWithImage(ctx,
            `🚫 <b>Blacklist User</b>\n\n` +
            `Send: <code>USER_ID REASON</code>\n` +
            `Example: <code>123456789 Fraudulent activity</code>\n\n` +
            `Or send <code>skip</code> for default reason.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    
    async processBlacklist(ctx, targetId, reason) {
        try {
            const { User } = await import('../../../models/index.js');
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { 
                    $set: { 
                        isBlacklisted: true,
                        blacklistDate: new Date(),
                        blacklistedBy: ctx.from.id.toString(),
                        blacklistSource: 'ADMIN',
                        blacklistReason: reason
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

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `🚫 <b>User Blacklisted</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `📝 Reason: <i>${reason}</i>\n` +
                    `⏰ Time: <i>${new Date().toLocaleString()}</i>\n\n` +
                    `⚠️ User can no longer use the bot.`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Blacklist failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    
    // ─── 20. Whitelist User ───
    
async promptWhitelist(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingWhitelist = true;
        
        await safeEditWithImage(ctx,
            `✅ <b>Whitelist User</b>\n\n` +
            `Send the <b>User ID</b> to remove from blacklist.\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processWhitelist(ctx, targetId) {
        try {
            const { User } = await import('../../../models/index.js');
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { 
                    $set: { 
                        isBlacklisted: false,
                        blacklistReason: null,
                        blacklistDate: null,
                        blacklistExpiresAt: null,
                        blacklistSource: null,
                        whitelistedAt: new Date(),
                        whitelistedBy: ctx.from.id.toString()
                    },
                    $unset: { blacklistedBy: 1 }
                },
                { new: true }
            );

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML' 
                });
            }

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `✅ <b>User Whitelisted</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `⏰ Time: <i>${new Date().toLocaleString()}</i>\n\n` +
                    `🎉 User can now use the bot again.`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Whitelist failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    // ─── 21. Clear User History ───
    
async promptClearHistory(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingClearHistory = true;
        
        await safeEditWithImage(ctx,
            `🧹 <b>Clear User History</b>\n\n` +
            `⚠️ <b>This is DESTRUCTIVE!</b>\n\n` +
            `Send the <b>User ID</b> to clear ALL history:\n` +
            `• Transactions\n` +
            `• Sessions\n` +
            `• OTP logs\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processClearHistory(ctx, targetId) {
        try {
            const { User, Transaction, Session } = await import('../../../models/index.js');
            
            const [user, txDel, sessDel] = await Promise.all([
                User.findOne({ userId: targetId }),
                Transaction.deleteMany({ userId: targetId }),
                Session.deleteMany({ userId: targetId })
            ]);

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                });
            }

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `✅ <b>History Cleared</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `🗑️ Transactions deleted: <b>${txDel.deletedCount}</b>\n` +
                    `🗑️ Sessions deleted: <b>${sessDel.deletedCount}</b>\n\n` +
                    `⚠️ Balance was preserved. Use "Deduct Balance" if needed.`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Clear history failed', { error: error.message, targetId });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    // ─── 22. Reset User Session ───
    
async promptResetSession(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingResetSession = true;
        
        await safeEditWithImage(ctx,
            `♻️ <b>Reset User Session</b>\n\n` +
            `Send the <b>User ID</b> to force-cancel their active session.\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processResetSession(ctx, targetId) {
        try {
            const { Session } = await import('../../../models/index.js');
            const result = await Session.updateMany(
                { userId: targetId, status: { $in: ['WAITING', 'CHECKING', 'PENDING'] } },
                { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'admin' } }
            );

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `♻️ <b>Session Reset</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `🔄 Sessions cancelled: <b>${result.modifiedCount}</b>`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Reset session failed', { error: error.message, targetId });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    // ─── 23. Impersonate User ───
    
async promptImpersonate(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingImpersonate = true;
        
        await safeEditWithImage(ctx,
            `🎭 <b>Impersonate User</b>\n\n` +
            `Send the <b>User ID</b> to see their dashboard view.\n\n` +
            `⚠️ You will see exactly what they see.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processImpersonate(ctx, targetId) {
        try {
            const { User } = await import('../../../models/index.js');
            const user = await User.findOne({ userId: targetId });

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
                });
            }

            const text = 
                `🎭 <b>Impersonating: ${targetId}</b>\n\n` +
                `💰 Balance: <b>$${user.balance?.toFixed(2) || '0.00'}</b>\n` +
                `🔒 Locked: <b>$${user.lockedBalance?.toFixed(2) || '0.00'}</b>\n` +
                `📊 Total Spent: <b>$${user.totalSpent?.toFixed(2) || '0.00'}</b>\n` +
                `📥 Total Deposited: <b>$${user.totalDeposited?.toFixed(2) || '0.00'}</b>\n` +
                `🚫 Blacklisted: <b>${user.blacklisted ? 'YES' : 'No'}</b>\n` +
                `📅 Joined: <i>${user.createdAt?.toLocaleDateString() || 'N/A'}</i>\n\n` +
                `<i>This is their current view.</i>`;

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: text,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '💰 Add Balance', callback_data: `admin_add_bal_${targetId}` },
                            { text: '💸 Deduct', callback_data: `admin_ded_bal_${targetId}` }
                        ],
                        [{ text: '◀️ Back to Users', callback_data: 'admin_back_users' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Impersonate failed', { error: error.message, targetId });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    // ─── 24. Message User ───
    
async promptMessageUser(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingMessageUser = true;
        
        await safeEditWithImage(ctx,
            `💬 <b>Message User</b>\n\n` +
            `Send: <code>USER_ID YOUR MESSAGE</code>\n` +
            `Example: <code>123456789 Hello, your deposit is confirmed!</code>\n\n` +
            `⚠️ Message will be sent as bot.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processMessageUser(ctx, targetId, messageText) {
        try {
            await ctx.telegram.sendMessage(targetId, 
                `📩 <b>Message from Admin</b>\n\n${messageText}`,
                { parse_mode: 'HTML' }
            );

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `✅ <b>Message Sent</b>\n\n` +
                    `👤 To: <code>${targetId}</code>\n` +
                    `📝 Content: <i>${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}</i>`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Message user failed', { error: error.message, targetId });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    // ─── 25. Broadcast ───
    
async processBroadcast(ctx, messageText) {
        try {
            const { User } = await import('../../../models/index.js');
            const users = await User.find({ blacklisted: { $ne: true } }).select('userId');
            
            let sent = 0;
            let failed = 0;
            
            for (const user of users) {
                try {
                    await ctx.telegram.sendMessage(user.userId, 
                        `📢 <b>Announcement</b>\n\n${messageText}`,
                        { parse_mode: 'HTML' }
                    );
                    sent++;
                } catch (e) {
                    failed++;
                }
            }

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `📢 <b>Broadcast Complete</b>\n\n` +
                    `✅ Sent: <b>${sent}</b>\n` +
                    `❌ Failed: <b>${failed}</b>\n` +
                    `📊 Total: <b>${users.length}</b>`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Broadcast failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    

    async promptUserNotes(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingUserNotes = true;
        
        await safeEditWithImage(ctx,
            `📋 <b>User Notes & Tags</b>\n\n` +
            `Send: <code>USER_ID | NOTE</code>\n` +
            `Example: <code>123456789 | VIP customer, always pays on time</code>\n\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processUserNotes(ctx, targetId, note) {
        try {
            const { User } = await import('../../../models/index.js');
            
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { 
                    $push: { 
                        adminNotes: { 
                            note, 
                            by: ctx.from.id.toString(), 
                            at: new Date() 
                        } 
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

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `📋 <b>Note Added</b>\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `📝 Note: <i>${note}</i>\n` +
                    `📊 Total notes: <b>${user.adminNotes?.length || 1}</b>`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('User notes failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    async promptShadowBan(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingShadowBan = true;
        
        await safeEditWithImage(ctx,
            `👻 <b>Shadow Ban</b>\n\n` +
            `Send: <code>USER_ID on|off</code>\n` +
            `Example: <code>123456789 on</code>\n\n` +
            `⚠️ Shadow banned users see bot working but OTPs always fail.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processShadowBan(ctx, targetId, action) {
        try {
            const { User } = await import('../../../models/index.js');
            
            const isBanned = action === 'on';
            const user = await User.findOneAndUpdate(
                { userId: targetId },
                { $set: { shadowBanned: isBanned, shadowBannedAt: isBanned ? new Date() : null } },
                { new: true }
            );

            if (!user) {
                return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                    caption: `❌ User <code>${targetId}</code> not found.`, 
                    parse_mode: 'HTML' 
                });
            }

            const status = isBanned ? '👻 SHADOW BANNED' : '✅ UNBANNED';
            
            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `${status}\n\n` +
                    `👤 User: <code>${targetId}</code>\n` +
                    `📊 Status: <b>${status}</b>\n\n` +
                    `${isBanned ? '🔇 User will see normal bot but OTPs will silently fail.' : '🎉 User fully restored.'}`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Shadow ban failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    },

    async promptAccountMerge(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery();
        ctx.session.awaitingAccountMerge = true;
        
        await safeEditWithImage(ctx,
            `🔗 <b>Account Merge</b>\n\n` +
            `Send: <code>KEEP_ID DELETE_ID</code>\n` +
            `Example: <code>123456789 987654321</code>\n\n` +
            `⚠️ DELETE_ID balance & history will be merged into KEEP_ID.\n` +
            `DELETE_ID will be removed.\n` +
            `Or send /cancel to abort.`,
            { parse_mode: 'HTML' }
        );
    },

    async processAccountMerge(ctx, keepId, deleteId) {
        try {
            const { User, Transaction, Session } = await import('../../../models/index.js');
            
            const [keep, del] = await Promise.all([
                User.findOne({ userId: keepId }),
                User.findOne({ userId: deleteId })
            ]);

            if (!keep) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Keep user <code>${keepId}</code> not found.`, 
                parse_mode: 'HTML' 
            });
            if (!del) return ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Delete user <code>${deleteId}</code> not found.`, 
                parse_mode: 'HTML' 
            });

            await User.updateOne(
                { userId: keepId },
                { 
                    $inc: { 
                        balance: del.balance || 0,
                        totalSpent: del.totalSpent || 0,
                        totalDeposited: del.totalDeposited || 0
                    },
                    $set: { lastMerged: new Date() }
                }
            );

            await Transaction.updateMany(
                { userId: deleteId },
                { $set: { userId: keepId, mergedFrom: deleteId } }
            );

            await Session.updateMany(
                { userId: deleteId },
                { $set: { userId: keepId } }
            );

            await User.deleteOne({ userId: deleteId });

            await ctx.replyWithPhoto(ADMIN_IMAGE_URL, {
                caption: 
                    `🔗 <b>Accounts Merged</b>\n\n` +
                    `✅ Kept: <code>${keepId}</code>\n` +
                    `🗑️ Deleted: <code>${deleteId}</code>\n` +
                    `💰 Balance transferred: <b>$${del.balance?.toFixed(2) || '0.00'}</b>\n\n` +
                    `All history and sessions moved to kept account.`,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });

        } catch (error) {
            logger.error('Account merge failed', { error: error.message });
            ctx.replyWithPhoto(ADMIN_IMAGE_URL, { 
                caption: `❌ Error: ${error.message}`, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }
};

export default userToolsMethods;
