// bot/commands/admin/users.js — User lookup, balance operations, blacklist/whitelist, VIP, messaging
// Methods are mixed into AdminCommands.prototype by bot/commands/admin.js (bodies unchanged: `this` is the AdminCommands instance).
import { Markup } from 'telegraf';
import { User, Session, Transaction, Number as NumberModel } from '../../../models/index.js';
import { generateId, formatCurrency } from '../../../utils/helpers.js';
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import { TX_TYPES, NUMBER_STATUS } from './constants.js';

export const usersMethods = {
                // ═══════════════════════════════════════════════════════════
    //  CANCEL VIP
    // ═══════════════════════════════════════════════════════════

    

    

    
async showCancelVipConfirm(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user) {
                return this.replyError(ctx, `❌ <b>User not found:</b> <code>${userId}</code>`);
            }

            if (!user.vipExpiry || new Date(user.vipExpiry) <= new Date()) {
                return this.replyError(ctx, `❌ <b>User is not VIP:</b> <code>${userId}</code>`);
            }

            const displayName = user.username ? `@${user.username}` : (user.firstName || userId);
            const daysLeft = Math.ceil((new Date(user.vipExpiry) - new Date()) / (1000 * 60 * 60 * 24));

            const message = `
<b>❌ Confirm Cancel VIP</b>

<b>User:</b> <code>${displayName}</code>
<b>ID:</b> <code>${userId}</code>
<b>Number:</b> <code>${user.vipPhoneNumber || 'N/A'}</code>
<b>Expires:</b> <code>${new Date(user.vipExpiry).toLocaleDateString()}</code>
<b>Days Left:</b> <code>${daysLeft}</code>

⚠️ This will immediately release their dedicated number and remove VIP status.
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Yes, Cancel VIP', `cancelvip_confirm_${userId}`)],
                [Markup.button.callback('❌ No, Keep VIP', 'admin_cancelvip')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Cancel VIP confirm error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to load user.</b>');
        }
    },

    async executeCancelVip(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user?.vipExpiry || new Date(user.vipExpiry) <= new Date()) {
                return this.replyError(ctx, `❌ <b>User is not VIP or already expired.</b>`);
            }

            // Release VIP number via pool manager
            if (this.smsProviderManager?.numberPool && user.vipNumberId) {
                try {
                    await this.smsProviderManager.numberPool.releaseNumber(user.vipNumberId, 'ADMIN_CANCELLED');
                } catch (e) {
                    logger.warn('Failed to release VIP number from provider', { userId, error: e.message });
                }
            }

            // Release from NumberModel
            if (user.vipNumberId) {
                try {
                    await NumberModel.updateOne(
                        { numberId: user.vipNumberId },
                        { $set: { status: NUMBER_STATUS.AVAILABLE, assignedTo: null, assignedAt: null } }
                    );
                } catch (e) {
                    logger.warn('Failed to release number in DB', { userId, error: e.message });
                }
            }

            // Update user
            await User.updateOne(
                { userId },
                {
                    $set: {
                        vipExpiry: new Date(0),
                        vipNumberId: null,
                        vipPhoneNumber: null,
                        vipProvider: null,
                        vipNumberAssignedAt: null,
                        vipNumberCountry: null,
                        mode: 'CHEAP'
                    }
                }
            );

            await Transaction.create({
                txId: generateId(),
                userId,
                type: TX_TYPES.NUMBER_RELEASE,
                amount: 0,
                status: 'COMPLETED',
                metadata: { adminId: ctx.from.id.toString(), reason: 'ADMIN_CANCELLED', previousExpiry: user.vipExpiry },
                createdAt: new Date()
            });

            await this.logAdminAction(
                ctx.from.id.toString(),
                'CANCEL_VIP',
                userId,
                { previousExpiry: user.vipExpiry, phoneNumber: user.vipPhoneNumber }
            );

            await this.replySuccess(ctx, `✅ <b>VIP Cancelled!</b>\n\nUser: <code>${userId}</code>\nNumber released and VIP status removed.`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancel Another', 'admin_cancelvip')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

            // Notify user with contact support button
            await ctx.telegram.sendMessage(userId, `
<b>❌ VIP Subscription Cancelled</b>

Your VIP subscription has been cancelled by an admin.

Your dedicated number has been released.

Contact @Swiftsmssupport if you have questions.
            `, { 
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('📞 Contact Support', 'https://t.me/Swiftsmssupport')]
                ]).reply_markup
            }).catch(() => {});

        } catch (error) {
            logger.error('Cancel VIP error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to cancel VIP.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  USERS LIST
    // ═══════════════════════════════════════════════════════════

    
async handleUsers(ctx) {
        try {
            const page = parseInt(ctx.match?.[1]) || 1;
            const limit = 10;
            const skip = (page - 1) * limit;

            const [users, totalUsers] = await Promise.all([
                User.find()
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                User.countDocuments()
            ]);

            const totalPages = Math.ceil(totalUsers / limit) || 1;

            if (!users.length) {
                return this.replyError(ctx, '<b>👥 No users found.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            let message = `<b>👥 Users</b> (Page ${page} of ${totalPages}) — Total: <code>${totalUsers}</code>\n\n`;
            const buttons = [];

            for (const user of users) {
                const status = user.isBlacklisted ? '🔴' :
                    (user.vipExpiry && new Date(user.vipExpiry) > new Date()) ? '👑' :
                        user.balance > 0 ? '💰' : '🆓';

                const displayName = user.username ? `@${user.username}` : (user.firstName || 'Unknown');
                message += `${status} <b>${displayName}</b> — <code>${user.userId}</code>\n`;
                message += `   Balance: <code>${formatCurrency(user.balance)}</code> | Joined: ${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}\n\n`;

                buttons.push([Markup.button.callback(
                    `${status} View ${displayName.substring(0, 20)}`,
                    `user_detail_${user.userId}`
                )]);
            }

            const navButtons = [];
            if (page > 1) {
                navButtons.push(Markup.button.callback('⬅️ Prev', `admin_users_${page - 1}`));
            }
            if (skip + users.length < totalUsers) {
                navButtons.push(Markup.button.callback('Next ➡️', `admin_users_${page + 1}`));
            }
            if (navButtons.length) {
                buttons.push(navButtons);
            }

            buttons.push([Markup.button.callback('🔙 Back to Admin', 'admin')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Users list error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load users.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  SEARCH USER
    // ═══════════════════════════════════════════════════════════

    
async handleSearchUserMenu(ctx) {
        const message = `
<b>🔍 Search Users</b>

Select search method:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆔 By User ID', 'search_by_id')],
            [Markup.button.callback('👤 By Username', 'search_by_username')],
            [Markup.button.callback('📝 By Name', 'search_by_name')],
            [Markup.button.callback('❌ Cancel', 'search_cancel')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    async executeSearch(ctx, query, mode) {
        try {
            let searchConditions = [];

            if (mode === 'id') {
                searchConditions.push({ userId: query });
            } else if (mode === 'username') {
                searchConditions.push({ username: { $regex: query, $options: 'i' } });
            } else if (mode === 'name') {
                searchConditions.push(
                    { firstName: { $regex: query, $options: 'i' } },
                    { lastName: { $regex: query, $options: 'i' } }
                );
            }

            const users = await User.find({ $or: searchConditions }).limit(10).lean();

            if (!users.length) {
                return this.replyError(ctx, '🔍 <b>No users found.</b>\n\nTry a different search term.', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔍 Search Again', 'admin_search')],
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            let message = `<b>🔍 Search Results</b> (${users.length} found)\n\n`;
            const buttons = [];

            for (const user of users) {
                const status = user.isBlacklisted ? '🔴' :
                    (user.vipExpiry && new Date(user.vipExpiry) > new Date()) ? '👑' :
                        user.balance > 0 ? '💰' : '🆓';

                const displayName = user.username ? `@${user.username}` : (user.firstName || 'Unknown');
                message += `${status} <b>${displayName}</b> — <code>${user.userId}</code>\n`;
                message += `   Balance: <code>${formatCurrency(user.balance)}</code>\n\n`;

                buttons.push([Markup.button.callback(
                    `${status} View ${displayName.substring(0, 20)}`,
                    `user_detail_${user.userId}`
                )]);
            }

            buttons.push([Markup.button.callback('🔍 Search Again', 'admin_search')]);
            buttons.push([Markup.button.callback('🔙 Back to Admin', 'admin')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Search user error', { error: error.message, query, mode });
            await this.replyError(ctx, '❌ <b>Search failed.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  TOP USERS
    // ═══════════════════════════════════════════════════════════

    
async handleTopUsers(ctx) {
        try {
            const topUsers = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE] },
                        status: 'COMPLETED'
                    }
                },
                {
                    $group: {
                        _id: '$userId',
                        totalSpent: { $sum: { $abs: '$amount' } }
                    }
                },
                { $sort: { totalSpent: -1 } },
                { $limit: 10 }
            ]);

            if (!topUsers.length) {
                return this.replyError(ctx, '<b>📊 No spending data yet.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            const userIds = topUsers.map(u => u._id);
            const users = await User.find({ userId: { $in: userIds } })
                .select('userId username firstName balance')
                .lean();

            const userMap = new Map(users.map(u => [u.userId, u]));

            let message = '<b>🏆 Top 10 Users by Spending</b>\n\n';

            for (let i = 0; i < topUsers.length; i++) {
                const tu = topUsers[i];
                const u = userMap.get(tu._id);
                const name = u?.username ? `@${u.username}` : (u?.firstName || tu._id);
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
                message += `${medal} <b>${name}</b>\n`;
                message += `   Spent: <code>${formatCurrency(tu.totalSpent)}</code> | Balance: <code>${formatCurrency(u?.balance || 0)}</code>\n\n`;
            }

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Top users error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load top users.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  RESET FREE OTPs
    // ═══════════════════════════════════════════════════════════

    
async handleResetFreeMenu(ctx) {
        const message = `
<b>🔄 Reset Free OTPs</b>

Choose how to select the user:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆔 Enter User ID', 'resetfree_search')],
            [Markup.button.callback('👥 Pick from User List', 'resetfree_from_users')],
            [Markup.button.callback('❌ Cancel', 'resetfree_cancel')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    async showResetFreeConfirm(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user) {
                return this.replyError(ctx, `❌ <b>User not found:</b> <code>${userId}</code>`, {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'admin_resetfree')],
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            const displayName = user.username ? `@${user.username}` : (user.firstName || userId);

            const message = `
<b>🔄 Confirm Reset Free OTPs</b>

<b>User:</b> <code>${displayName}</code>
<b>ID:</b> <code>${userId}</code>
<b>Current Free Used:</b> <code>${user.freeUsedToday || 0}</code>/3

Are you sure you want to reset their free OTP count?
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Yes, Reset', `resetfree_confirm_${userId}`)],
                [Markup.button.callback('❌ Cancel', 'admin_resetfree')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Reset free confirm error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to load user.</b>');
        }
    },

    async executeResetFree(ctx, userId) {
        try {
            await User.updateOne(
                { userId },
                { $set: { freeUsedToday: 0, freeResetDate: new Date() } }
            );

            await this.logAdminAction(ctx.from.id.toString(), 'RESET_FREE', userId, {});

            await this.replySuccess(ctx, `✅ <b>Free OTP Reset!</b>\n\nUser: <code>${userId}</code>\nDaily free count has been reset to 0.`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Reset Another', 'admin_resetfree')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

            await ctx.telegram.sendMessage(userId, `
<b>🔄 Free OTP Reset</b>

Your daily free OTP count has been reset by an admin.

You can now use your free OTPs again.
            `, { parse_mode: 'HTML' }).catch(() => {});

        } catch (error) {
            logger.error('Reset free error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to reset free OTPs.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  GIVE VIP
    // ═══════════════════════════════════════════════════════════

    
async handleGiveVipMenu(ctx) {
        const message = `
<b>👑 Grant VIP Status</b>

Choose how to select the user:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🆔 Enter User ID', 'givevip_search')],
            [Markup.button.callback('👥 Pick from User List', 'givevip_from_users')],
            [Markup.button.callback('❌ Cancel', 'givevip_cancel')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    async showGiveVipDaysInput(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user) {
                return this.replyError(ctx, `❌ <b>User not found:</b> <code>${userId}</code>`, {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'admin_givevip')],
                        [Markup.button.callback('🔙 Back', 'admin')]
                    ]).reply_markup
                });
            }

            const displayName = user.username ? `@${user.username}` : (user.firstName || userId);
            const currentVip = user.vipExpiry && new Date(user.vipExpiry) > new Date()
                ? `Until ${new Date(user.vipExpiry).toLocaleDateString()}`
                : 'Inactive';

            const message = `
<b>👑 Grant VIP to ${displayName}</b>

<b>ID:</b> <code>${userId}</code>
<b>Current VIP:</b> ${currentVip}

Send the number of days to grant:
            `;

            await this.replySuccess(ctx, message);
        } catch (error) {
            logger.error('Give VIP days input error', { error: error.message, userId });
            await this.replyError(ctx, '❌ <b>Failed to load user.</b>');
        }
    },

    
async executeGiveVip(ctx, userId, days) {
        try {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + days);

            await User.updateOne(
                { userId },
                { $set: { vipExpiry: expiry } }
            );

            await Transaction.create({
                txId: generateId(),
                userId,
                type: TX_TYPES.VIP_SUBSCRIPTION,
                amount: 0,
                status: 'COMPLETED',
                metadata: { adminId: ctx.from.id.toString(), grantedDays: days, expiry },
                createdAt: new Date()
            });

            await this.logAdminAction(ctx.from.id.toString(), 'GIVE_VIP', userId, { days, expiry });

            await this.replySuccess(ctx, `👑 <b>VIP Granted!</b>\n\nUser: <code>${userId}</code>\nDuration: <code>${days}</code> days\nExpires: <code>${expiry.toLocaleDateString()}</code>`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('👑 Grant Another', 'admin_givevip')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

            await ctx.telegram.sendMessage(userId, `
<b>👑 VIP Status Granted!</b>

You have been granted VIP status for <code>${days}</code> days.

<b>Expires:</b> <code>${expiry.toLocaleDateString()}</code>

Enjoy premium benefits!
            `, { parse_mode: 'HTML' }).catch(() => {});

        } catch (error) {
            logger.error('Give VIP error', { error: error.message, userId, days });
            await this.replyError(ctx, '❌ <b>Failed to grant VIP.</b>');
        }
    },
// ═══════════════════════════════════════════════════════════
    //  USER DETAIL INLINE (FIXED — was cut off at Lifetime Value)
    // ═══════════════════════════════════════════════════════════
async showUserDetailInline(ctx, userId) {
        try {
            const user = await User.findOne({ userId }).lean();

            if (!user) {
                return this.replyError(ctx, '❌ <b>User not found.</b>');
            }

            const [
                recentSessions,
                recentTransactions,
                referrals,
                sessionCounts,
                txStats
            ] = await Promise.all([
                Session.find({ userId })
                    .sort({ startTime: -1 })
                    .limit(10)
                    .lean(),
                Transaction.find({ userId })
                    .sort({ createdAt: -1 })
                    .limit(10)
                    .lean(),
                User.find({ referredBy: userId })
                    .select('userId username createdAt')
                    .lean(),
                Session.countDocuments({ userId }),
                Transaction.aggregate([
                    { $match: { userId, status: { $in: ['COMPLETED', 'completed'] } } },
                    {
                        $group: {
                            _id: null,
                            totalSpent: {
                                $sum: {
                                    $cond: [
                                        { $in: ['$type', [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE]] },
                                        { $abs: '$amount' },
                                        0
                                    ]
                                }
                            },
                            totalDeposited: {
                                $sum: {
                                    $cond: [{ $eq: ['$type', TX_TYPES.DEPOSIT] }, '$amount', 0]
                                }
                            },
                            totalRefEarnings: {
                                $sum: {
                                    $cond: [{ $eq: ['$type', TX_TYPES.REFERRAL_REWARD] }, '$amount', 0]
                                }
                            }
                        }
                    }
                ])
            ]);

            const stats = txStats[0] || { totalSpent: 0, totalDeposited: 0, totalRefEarnings: 0 };
            const isVip = user.vipExpiry && new Date(user.vipExpiry) > new Date();
            const statusEmoji = user.isBlacklisted ? '🔴 BANNED' : isVip ? '👑 VIP' : '✅ Active';

            // Calculate lifetime value safely
            const bundleValue = (user.bundleRemaining || 0) * (config.prices?.cheapOtp || 0.05);
            const lifetimeValue = (stats.totalSpent || 0) + bundleValue;

            const message = `
<b>👤 User Details</b>

<b>🆔 ID:</b> <code>${user.userId}</code>
<b>👤 Name:</b> ${(user.firstName || '') + ' ' + (user.lastName || '')}
<b>📱 Username:</b> ${user.username ? '@' + user.username : 'N/A'}
<b>💰 Balance:</b> <code>${formatCurrency(user.balance)}</code>
<b>🔒 Locked:</b> <code>${formatCurrency(user.lockedBalance || 0)}</code>
<b>📦 Bundle:</b> <code>${user.bundleRemaining || 0}</code> OTPs
<b>👑 VIP:</b> ${isVip ? `Until ${new Date(user.vipExpiry).toLocaleDateString()}` : 'Inactive'}
<b>🆓 Free Used Today:</b> <code>${user.freeUsedToday || 0}</code>/3
<b>📊 Mode:</b> <code>${user.mode || 'N/A'}</code>

<b>🚫 Status:</b> ${statusEmoji}
${user.isBlacklisted ? `<b>Reason:</b> ${user.blacklistReason || 'N/A'}\n` : ''}
<b>📅 Joined:</b> ${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Unknown'}
<b>🕐 Last Active:</b> ${user.lastActive ? new Date(user.lastActive).toLocaleDateString() : 'Never'}

<b>📊 Stats</b>
• Total Spent: <code>${formatCurrency(stats.totalSpent)}</code>
• Total Deposited: <code>${formatCurrency(stats.totalDeposited)}</code>
• Ref Earnings: <code>${formatCurrency(stats.totalRefEarnings)}</code>
• Total Sessions: <code>${sessionCounts}</code>
• Referrals: <code>${referrals.length}</code>
• Net Balance: <code>${formatCurrency((user.balance || 0) - (user.lockedBalance || 0))}</code>
• Lifetime Value: <code>${formatCurrency(lifetimeValue)}</code>

<b>📞 Recent Sessions:</b> <code>${recentSessions.length}</code> shown
<b>📜 Recent Transactions:</b> <code>${recentTransactions.length}</code> shown
            `;

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('➕ Add Balance', `addbal_${userId}`),
                    Markup.button.callback('➖ Deduct Balance', `dedbal_${userId}`)
                ],
                [
                    Markup.button.callback('📨 Message', `msg_${userId}`),
                    Markup.button.callback('📜 Transactions', `viewtx_${userId}`)
                ],
                [
                    Markup.button.callback('📞 Sessions', `viewsess_${userId}`),
                    user.isBlacklisted
                        ? Markup.button.callback('🟢 Unban', `unban_${userId}`)
                        : Markup.button.callback('🔴 Ban', `ban_${userId}`)
                ],
                [
                    user.isBlacklisted
                        ? Markup.button.callback('🟢 Whitelist', `wl_${userId}`)
                        : Markup.button.callback('🔴 Blacklist', `bl_${userId}`)
                ],
                [
                    Markup.button.callback('🔄 Reset Free', `quick_resetfree_${userId}`),
                    Markup.button.callback('👑 Give VIP', `quick_givevip_${userId}`)
                ],
                [
                    Markup.button.callback('❌ Cancel VIP', `quick_cancelvip_${userId}`)
                ],
                [Markup.button.callback('🔙 Back to Users', 'admin_users')]
            ]);

            await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('User detail inline error', { userId, error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load user details.</b>');
        }
    },

    

    async handleViewUserTransactions(ctx) {
        try {
            const userId = ctx.match[1];
            const transactions = await Transaction.find({ userId })
                .sort({ createdAt: -1 })
                .limit(15)
                .lean();

            if (!transactions.length) {
                return this.editCaption(ctx, '<b>📜 No transactions found.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', `back_user_${userId}`)]
                    ]).reply_markup
                });
            }

            let message = `<b>📜 Recent Transactions</b> for <code>${userId}</code>\n\n`;
            for (const tx of transactions) {
                const emoji = tx.status === 'COMPLETED' || tx.status === 'completed' ? '✅' : tx.status === 'PENDING' || tx.status === 'pending' ? '⏳' : '❌';
                message += `${emoji} <b>${tx.type}</b> | <code>${formatCurrency(Math.abs(tx.amount || 0))}</code>\n`;
                message += `   Status: <code>${tx.status}</code> | ${tx.createdAt ? new Date(tx.createdAt).toLocaleDateString() : 'N/A'}\n\n`;
            }

            await this.editCaption(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back to User', `back_user_${userId}`)]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('View transactions error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load transactions.</b>');
        }
    },

    async handleViewUserSessions(ctx) {
        try {
            const userId = ctx.match[1];
            const sessions = await Session.find({ userId })
                .sort({ startTime: -1 })
                .limit(15)
                .lean();

            if (!sessions.length) {
                return this.editCaption(ctx, '<b>📞 No sessions found.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', `back_user_${userId}`)]
                    ]).reply_markup
                });
            }

            let message = `<b>📞 Recent Sessions</b> for <code>${userId}</code>\n\n`;
            for (const s of sessions) {
                const emoji = s.status === 'RECEIVED' ? '✅' : s.status === 'TIMEOUT' ? '⏰' : '❌';
                message += `${emoji} <b>${s.service || 'N/A'}</b> (${s.country || 'N/A'})\n`;
                message += `   Status: <code>${s.status}</code> | Cost: <code>${formatCurrency(s.cost || 0)}</code>\n`;
                message += `   ${s.startTime ? new Date(s.startTime).toLocaleString() : 'N/A'}\n\n`;
            }

            await this.editCaption(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back to User', `back_user_${userId}`)]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('View sessions error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load sessions.</b>');
        }
    },

            // ═══════════════════════════════════════════════════════════
    //  BALANCE OPERATIONS
    // ═══════════════════════════════════════════════════════════

    

    
async processAddBalance(ctx, targetId, amount, reason) {
        try {
            let txId;
            if (this.walletService?.addBalance) {
                txId = await this.walletService.addBalance(targetId, amount, ctx.from.id.toString(), reason, { idempotencyKey: `${ctx.from.id}_${targetId}_${amount}_${ctx.message?.message_id || ctx.callbackQuery?.id || Date.now()}` });
            } else {
                // Fallback: direct DB update
                await User.updateOne({ userId: targetId }, { $inc: { balance: amount } });
                txId = generateId();
                await Transaction.create({
                    txId,
                    userId: targetId,
                    type: TX_TYPES.ADMIN_ADD,
                    amount,
                    status: 'COMPLETED',
                    processedBy: ctx.from.id.toString(),
                    metadata: { adminId: ctx.from.id.toString(), reason },
                    createdAt: new Date()
                });
            }

            await this.logAdminAction(
                ctx.from.id.toString(),
                'ADD_BALANCE',
                targetId,
                { amount, reason, txId }
            );

            await this.replySuccess(ctx, `✅ <b>Balance Added!</b>\n\nUser: <code>${targetId}</code>\nAmount: <code>+${formatCurrency(amount)}</code>\nReason: <i>${reason}</i>\nTxID: <code>${txId}</code>`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
<b>🎁 Balance Added!</b>

Amount: <code>+${formatCurrency(amount)}</code>
Reason: <i>${reason}</i>

Your new balance has been updated.
            `, { parse_mode: 'HTML' }).catch(err => {
                logger.warn('Failed to notify user of balance addition', { userId: targetId, error: err.message });
            });

        } catch (error) {
            logger.error('Add balance error', { targetId, amount, error: error.message, stack: error.stack });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    },

    async handleAddBalanceAction(ctx) {
        const targetId = ctx.match[1];
        this._ensureSession(ctx);
        ctx.session.awaitingAddBalance = targetId;
        await this.replySuccess(ctx, `💰 <b>Add Balance</b>\n\nSend the amount to add to user <code>${targetId}</code>:\n\n<i>Reply with a number (e.g., 10.50)</i>`);
    },

    

    async processDeductBalance(ctx, targetId, amount, reason) {
        try {
            const user = await User.findOne({ userId: targetId });
            if (!user) throw new Error('USER_NOT_FOUND');
            if ((user.balance || 0) < amount) throw new Error('INSUFFICIENT_BALANCE');

            let txId;
            if (this.walletService?.deductBalance) {
                txId = await this.walletService.deductBalance(targetId, amount, ctx.from.id.toString(), reason);
            } else {
                await User.updateOne({ userId: targetId }, { $inc: { balance: -amount } });
                txId = generateId();
                await Transaction.create({
                    txId,
                    userId: targetId,
                    type: TX_TYPES.ADMIN_DEDUCT,
                    amount: -amount,
                    status: 'COMPLETED',
                    processedBy: ctx.from.id.toString(),
                    metadata: { adminId: ctx.from.id.toString(), reason },
                    createdAt: new Date()
                });
            }

            await this.logAdminAction(
                ctx.from.id.toString(),
                'DEDUCT_BALANCE',
                targetId,
                { amount, reason, txId }
            );

            await this.replySuccess(ctx, `✅ <b>Balance Deducted!</b>\n\nUser: <code>${targetId}</code>\nAmount: <code>-${formatCurrency(amount)}</code>\nReason: <i>${reason}</i>\nTxID: <code>${txId}</code>`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
<b>⚠️ Balance Deducted</b>

Amount: <code>-${formatCurrency(amount)}</code>
Reason: <i>${reason}</i>

Your balance has been updated.
            `, { parse_mode: 'HTML' }).catch(err => {
                logger.warn('Failed to notify user of balance deduction', { userId: targetId, error: err.message });
            });

        } catch (error) {
            logger.error('Deduct balance error', { targetId, amount, error: error.message, stack: error.stack });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    },

    async handleDeductBalanceAction(ctx) {
        const targetId = ctx.match[1];
        this._ensureSession(ctx);
        ctx.session.awaitingDeductBalance = targetId;
        await this.replySuccess(ctx, `💰 <b>Deduct Balance</b>\n\nSend the amount to deduct from user <code>${targetId}</code>:\n\n<i>Reply with a number (e.g., 5.00)</i>`);
    },

    // ═══════════════════════════════════════════════════════════
    //  BLACKLIST / BAN / WHITELIST / MESSAGE USER
    // ═══════════════════════════════════════════════════════════

    

    
async processBlacklist(ctx, targetId, reason) {
        try {
            await User.updateOne(
                { userId: targetId },
                {
                    $set: {
                        isBlacklisted: true,
                        blacklistReason: reason,
                        blacklistDate: new Date()
                    }
                }
            );

            await Session.updateMany(
                { userId: targetId, status: { $in: ['WAITING', 'CHECKING'] } },
                { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
            );

            await this.logAdminAction(
                ctx.from.id.toString(),
                'BLACKLIST',
                targetId,
                { reason }
            );

            await this.replySuccess(ctx, `🚫 <b>User Blacklisted</b>\n\nUser: <code>${targetId}</code>\nReason: <i>${reason}</i>\n\nAll active sessions have been cancelled.`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
<b>🚫 Account Restricted</b>

Your account has been blacklisted.

<b>Reason:</b> <i>${reason}</i>

Contact support if you believe this is a mistake.
            `, { parse_mode: 'HTML' }).catch(() => {});

        } catch (error) {
            logger.error('Blacklist error', { targetId, error: error.message });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    },

    async handleBlacklistAction(ctx) {
        const targetId = ctx.match[1];
        this._ensureSession(ctx);
        ctx.session.awaitingBlacklistReason = targetId;
        await this.replySuccess(ctx, `🔴 <b>Blacklist User</b>\n\nSend reason for blacklisting user <code>${targetId}</code>:\n\n<i>Reply with a reason or send "skip" for default reason.</i>`);
    },

    

    async processWhitelist(ctx, targetId) {
        try {
            await User.updateOne(
                { userId: targetId },
                {
                    $set: {
                        isBlacklisted: false,
                        blacklistReason: null,
                        blacklistDate: null
                    }
                }
            );

            await this.logAdminAction(
                ctx.from.id.toString(),
                'WHITELIST',
                targetId,
                {}
            );

            await this.replySuccess(ctx, `✅ <b>User Whitelisted</b>\n\nUser: <code>${targetId}</code>\n\nAll restrictions have been removed.`);

            // Notify user
            await ctx.telegram.sendMessage(targetId, `
<b>✅ Account Restored</b>

Your account has been whitelisted. All restrictions have been removed.

You can now use the bot normally.
            `, { parse_mode: 'HTML' }).catch(() => {});

        } catch (error) {
            logger.error('Whitelist error', { targetId, error: error.message });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    },

    async handleWhitelistAction(ctx) {
        const targetId = ctx.match[1];
        await this.processWhitelist(ctx, targetId);
    },

    async handleBanAction(ctx) {
        const targetId = ctx.match[1];
        await this.processBlacklist(ctx, targetId, 'Banned by admin');
    },

    async handleUnbanAction(ctx) {
        const targetId = ctx.match[1];
        await this.processWhitelist(ctx, targetId);
    },

    

    async handleMessageUserAction(ctx) {
        const targetId = ctx.match[1];
        this._ensureSession(ctx);
        ctx.session.awaitingMessageUser = targetId;
        await this.replySuccess(ctx, `📨 <b>Message User</b>\n\nSend the message to deliver to user <code>${targetId}</code>:\n\n<i>Type your message and send it.</i>`);
    },

    async processMessageUser(ctx, targetId, messageText) {
        try {
            const user = await User.findOne({ userId: targetId });
            if (!user) throw new Error('USER_NOT_FOUND');

            await ctx.telegram.sendMessage(targetId, `
<b>📨 Message from Admin</b>

<i>${messageText}</i>

---
<i>SWIFTSMS — The fastest SMS Service. Contact us if you need assistance.</i>
            `, { parse_mode: 'HTML' });

            await this.logAdminAction(
                ctx.from.id.toString(),
                'MESSAGE_USER',
                targetId,
                { message: messageText.substring(0, 500) }
            );

            await this.replySuccess(ctx, `✅ <b>Message Sent!</b>\n\nTo: <code>${targetId}</code>\nMessage: <i>${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}</i>`);

        } catch (error) {
            logger.error('Message user error', { targetId, error: error.message });
            await this.replyError(ctx, `❌ <b>Error:</b> ${error.message}`);
        }
    }
};

export default usersMethods;
