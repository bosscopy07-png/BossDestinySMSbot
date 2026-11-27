// bot/commands/extra/analytics.js — Statistics (24h/7d/30d), top users, OTP success, provider performance, retention, LTV, churn, funnel, velocity
// Mixed into the Admin class by bot/commands/extra.js (bodies unchanged: `this` is the Admin instance).
import logger from '../../../utils/logger.js';
import { safeEditWithImage } from './helpers.js';

export const analyticsMethods = {
                // ═══════════════════════════════════════════════════════
    //  ANALYTICS FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 9. 24h Stats ───
    
async handleStats(ctx, days = 1) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });
        const label = { 1: ['📊', '24h'], 7: ['📈', '7-Day'], 30: ['📉', '30-Day'] }[days] || ['📊', `${days}d`];
        await ctx.answerCbQuery(`${label[0]} Loading ${label[1]} stats...`);

        try {
            const { Transaction } = await import('../../../models/index.js');
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            const [revenue, deposits, pendingLocks] = await Promise.all([
                Transaction.calculateRevenue(since),
                Transaction.aggregate([
                    { $match: { type: { $in: ['DEPOSIT', 'NAIRA_DEPOSIT'] }, status: 'COMPLETED', createdAt: { $gte: since } } },
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
                ]),
                Transaction.countDocuments({ type: 'LOCK', status: 'PENDING' })
            ]);

            const depositTotal = deposits[0]?.total || 0;
            const depositCount = deposits[0]?.count || 0;
            const net = depositTotal - (revenue.total || 0);

            const text =
                `${label[0]} <b>${label[1]} Statistics</b>\n\n` +
                `💰 Revenue: <b>$${revenue.total?.toFixed(2) || '0.00'}</b> (${revenue.count || 0} tx)\n` +
                `💳 Deposits: <b>$${depositTotal.toFixed(2)}</b> (${depositCount} tx)\n` +
                `🔒 Pending Locks: <b>${pendingLocks}</b>\n` +
                `📈 Net: <b>$${net.toFixed(2)}</b>\n\n` +
                `⏰ Updated: <i>${new Date().toLocaleString()}</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📊 24h', callback_data: 'admin_stats' },
                            { text: '📈 7d', callback_data: 'admin_stats_7d' },
                            { text: '📉 30d', callback_data: 'admin_stats_30d' }
                        ],
                        [{ text: '🔄 Refresh', callback_data: days === 1 ? 'admin_stats' : `admin_stats_${days}d` }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Stats failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    },

    // ─── 10. 7-Day Stats ───
    

    // ─── 11. 30-Day Stats ───
    

    // ─── 12. Top Users by Volume ───
    
async handleTopUsers(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🏆 Loading top users...');

        try {
            const { User } = await import('../../../models/index.js');
            
            const topUsers = await User.find()
                .sort({ totalSpent: -1 })
                .limit(10)
                .select('userId firstName totalSpent totalDeposited balance');

            let text = `🏆 <b>Top 10 Users by Volume</b>\n\n`;
            
            if (topUsers.length === 0) {
                text += `<i>No users found.</i>`;
            } else {
                topUsers.forEach((u, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    text += `${medal} <code>${u.userId}</code>\n` +
                           `   💰 Spent: <b>$${u.totalSpent?.toFixed(2) || '0.00'}</b>\n` +
                           `   📥 Deposited: <b>$${u.totalDeposited?.toFixed(2) || '0.00'}</b>\n` +
                           `   💳 Balance: <b>$${u.balance?.toFixed(2) || '0.00'}</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_top_users' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Top users failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    },

    // ─── 13. OTP Success Rate ───
    
async handleOTPSuccessRate(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('✅ Analyzing OTP success...');

        try {
            const { Transaction } = await import('../../../models/index.js');
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            
            const [total, success, failed] = await Promise.all([
                Transaction.countDocuments({ type: 'OTP', createdAt: { $gte: since } }),
                Transaction.countDocuments({ type: 'OTP', status: 'COMPLETED', createdAt: { $gte: since } }),
                Transaction.countDocuments({ type: 'OTP', status: 'FAILED', createdAt: { $gte: since } })
            ]);

            const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';

            const text = 
                `✅ <b>OTP Success Rate (24h)</b>\n\n` +
                `📊 Total Requests: <b>${total}</b>\n` +
                `✅ Completed: <b>${success}</b>\n` +
                `❌ Failed: <b>${failed}</b>\n` +
                `📈 Success Rate: <b>${successRate}%</b>\n\n` +
                `${parseFloat(successRate) < 80 ? '⚠️ <i>Success rate is low. Check providers.</i>' : '🎉 <i>Great success rate!</i>'}`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_otp_success' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('OTP success rate failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    },

    // ─── 14. Provider Performance ───
    
async handleProviderPerformance(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📡 Analyzing providers...');

        try {
            const { Transaction } = await import('../../../models/index.js');
            
            const providerStats = await Transaction.aggregate([
                { $match: { type: 'OTP', createdAt: { $gte: new Date(Date.now() - 24*60*60*1000) } } },
                { $group: { 
                    _id: '$provider', 
                    total: { $sum: 1 }, 
                    success: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
                    avgTime: { $avg: '$duration' }
                }}
            ]);

            let text = `📡 <b>SMS Provider Performance (24h)</b>\n\n`;
            
            if (providerStats.length === 0) {
                text += `<i>No OTP data in last 24h.</i>`;
            } else {
                providerStats.forEach(p => {
                    const rate = ((p.success / p.total) * 100).toFixed(1);
                    const avg = p.avgTime ? `${p.avgTime.toFixed(1)}s` : 'N/A';
                    text += `📱 <b>${p._id || 'Unknown'}</b>\n` +
                           `   ✅ Success: <b>${rate}%</b> (${p.success}/${p.total})\n` +
                           `   ⏱️ Avg Time: <b>${avg}</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_provider_perf' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Provider perf failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    },

    // ─── 15. Peak Hours ───
    
async handlePeakHours(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('⏰ Analyzing peak hours...');

        try {
            const { Transaction } = await import('../../../models/index.js');
            
            const hourly = await Transaction.aggregate([
                { $match: { createdAt: { $gte: new Date(Date.now() - 7*24*60*60*1000) } } },
                { $group: { 
                    _id: { $hour: '$createdAt' }, 
                    count: { $sum: 1 } 
                }},
                { $sort: { _id: 1 } }
            ]);

            let text = `⏰ <b>Peak Hours (7 days)</b>\n\n`;
            const maxCount = Math.max(...hourly.map(h => h.count), 1);
            
            hourly.forEach(h => {
                const bar = '█'.repeat(Math.round((h.count / maxCount) * 10));
                const hour = h._id.toString().padStart(2, '0');
                text += `${hour}:00 ${bar} <b>${h.count}</b>\n`;
            });

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_peak_hours' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Peak hours failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    },

    // ─── 36. Price by Country ───
    

                // ═══════════════════════════════════════════════════════
    //  FRAUD & SECURITY FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 37. Auto-Blacklist Toggle ───
    

    // ─── 38. IP/Device Fingerprinting ───
    

    // ─── 39. Velocity Checks ───
    
async handleVelocityCheck(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('⚡ Checking velocity...');

        try {
            const { Transaction } = await import('../../../models/index.js');
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            
            const velocity = await Transaction.aggregate([
                { $match: { type: 'OTP', createdAt: { $gte: oneHourAgo } } },
                { $group: { 
                    _id: '$userId', 
                    count: { $sum: 1 } 
                }},
                { $match: { count: { $gt: 5 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            let text = `⚡ <b>Velocity Alerts (1h)</b>\n\n`;
            
            if (velocity.length === 0) {
                text += `<i>No suspicious velocity detected.</i>`;
            } else {
                text += `⚠️ <b>${velocity.length} users with >5 OTPs/hour:</b>\n\n`;
                velocity.forEach(v => {
                    text += `👤 <code>${v._id}</code>: <b>${v.count}</b> requests\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_fraud_velocity' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Velocity check failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_fraud' }]] }
            });
        }
    },

    // ═══════════════════════════════════════════════════════
    //  ADVANCED ANALYTICS FEATURES
    // ═══════════════════════════════════════════════════════

    // ─── 44. Cohort Retention ───
    
async handleCohortRetention(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('👥 Analyzing cohorts...');

        try {
            const { User } = await import('../../../models/index.js');
            
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const newUsers = await User.countDocuments({ createdAt: { $gte: sevenDaysAgo } });
            const activeNew = await User.countDocuments({ 
                createdAt: { $gte: sevenDaysAgo },
                lastActive: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            });

            const retention = newUsers > 0 ? ((activeNew / newUsers) * 100).toFixed(1) : '0.0';

            const text = 
                `👥 <b>Cohort Retention (7-Day)</b>\n\n` +
                `🆕 New Users: <b>${newUsers}</b>\n` +
                `✅ Active Today: <b>${activeNew}</b>\n` +
                `📈 Retention: <b>${retention}%</b>\n\n` +
                `${parseFloat(retention) < 30 ? '⚠️ Retention is low. Consider onboarding improvements.' : '🎉 Good retention rate!'}`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_cohort' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Cohort retention failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    },

    // ─── 45. LTV per User ───
    
async handleLTV(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('💎 Analyzing LTV...');

        try {
            const { User } = await import('../../../models/index.js');
            
            const avgLTV = await User.aggregate([
                { $match: { totalSpent: { $gt: 0 } } },
                { $group: { _id: null, avg: { $avg: '$totalSpent' }, max: { $max: '$totalSpent' } } }
            ]);

            const avg = avgLTV[0]?.avg || 0;
            const max = avgLTV[0]?.max || 0;

            const text = 
                `💎 <b>Lifetime Value (LTV) Analysis</b>\n\n` +
                `📊 Average LTV: <b>$${avg.toFixed(2)}</b>\n` +
                `🏆 Highest LTV: <b>$${max.toFixed(2)}</b>\n\n` +
                `<i>LTV = Total Spent - Total Deposited</i>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_ltv' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('LTV failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    },

    // ─── 46. Churn Prediction ───
    
async handleChurnPrediction(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📉 Analyzing churn...');

        try {
            const { User } = await import('../../../models/index.js');
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            
            const churnRisk = await User.find({
                lastActive: { $lt: sevenDaysAgo },
                totalSpent: { $gt: 0 },
                blacklisted: { $ne: true }
            }).sort({ totalSpent: -1 }).limit(20);

            let text = `📉 <b>Churn Risk Users</b>\n\n` +
                       `Users inactive >7 days but previously spent:\n\n`;

            if (churnRisk.length === 0) {
                text += `<i>No churn risk users. Great retention!</i>`;
            } else {
                churnRisk.forEach((u, i) => {
                    const daysSince = u.lastActive 
                        ? Math.floor((Date.now() - u.lastActive) / 86400000) 
                        : 'N/A';
                    text += `${i + 1}. <code>${u.userId}</code>\n` +
                           `   💰 LTV: <b>$${u.totalSpent?.toFixed(2) || '0.00'}</b>\n` +
                           `   📅 Last active: <b>${daysSince} days ago</b>\n` +
                           `   💬 <i>Consider re-engagement message</i>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                                                [{ text: '🔄 Refresh', callback_data: 'admin_churn' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_automation' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Churn prediction failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_automation' }]] }
            });
        }
    },

    // ─── 47. Revenue by Country ───
    
async handleRevenueByCountry(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🌍 Analyzing by country...');

        try {
            const { Transaction, User } = await import('../../../models/index.js');
            
            const byCountry = await Transaction.aggregate([
                { $match: { type: 'DEPOSIT', status: 'COMPLETED' } },
                { $lookup: { from: 'users', localField: 'userId', foreignField: 'userId', as: 'user' } },
                { $unwind: '$user' },
                { $group: { _id: '$user.countryCode', total: { $sum: '$amount' }, count: { $sum: 1 } } },
                                 { $sort: { total: -1 } },
                { $limit: 10 }
            ]);

            let text = `🌍 <b>Revenue by Country</b>\n\n`;
            
            if (byCountry.length === 0) {
                text += `<i>No country data available.</i>`;
            } else {
                byCountry.forEach(c => {
                    const flag = c._id ? String.fromCodePoint(...[...c._id.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '🏳️';
                    text += `${flag} <b>${c._id || 'Unknown'}</b>\n` +
                           `   💰 Revenue: <b>$${c.total?.toFixed(2) || '0.00'}</b>\n` +
                           `   📊 Transactions: <b>${c.count}</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_revenue_country' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Revenue by country failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    },

    async handleHourlyHeatmap(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🔥 Generating heatmap...');

        try {
            const { Transaction } = await import('../../../models/index.js');
            
            const hourly = await Transaction.aggregate([
                { $match: { createdAt: { $gte: new Date(Date.now() - 7*24*60*60*1000) } } },
                { $group: { 
                    _id: { $hour: '$createdAt' }, 
                    count: { $sum: 1 } 
                }},
                { $sort: { _id: 1 } }
            ]);

            let text = `🔥 <b>Hourly Activity Heatmap (7 days)</b>\n\n`;
            const maxCount = Math.max(...hourly.map(h => h.count), 1);
            
            hourly.forEach(h => {
                const intensity = h.count / maxCount;
                const emoji = intensity > 0.8 ? '🔴' : intensity > 0.5 ? '🟠' : intensity > 0.2 ? '🟡' : '🟢';
                const bar = '█'.repeat(Math.round(intensity * 10));
                const hour = h._id.toString().padStart(2, '0');
                text += `${emoji} ${hour}:00 ${bar} <b>${h.count}</b>\n`;
            });

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_heatmap' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Heatmap failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    },

    async handleConversionFunnel(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('📉 Generating funnel...');

        try {
            const { User, Transaction } = await import('../../../models/index.js');
            
            const totalUsers = await User.countDocuments();
            const depositors = await User.countDocuments({ totalDeposited: { $gt: 0 } });
            const otpRequesters = await Transaction.countDocuments({ type: 'OTP' });
            const otpSuccess = await Transaction.countDocuments({ type: 'OTP', status: 'COMPLETED' });

            const dRate = totalUsers > 0 ? ((depositors / totalUsers) * 100).toFixed(1) : '0.0';
            const oRate = depositors > 0 ? ((otpRequesters / depositors) * 100).toFixed(1) : '0.0';
            const sRate = otpRequesters > 0 ? ((otpSuccess / otpRequesters) * 100).toFixed(1) : '0.0';

            const text = 
                `📉 <b>Conversion Funnel</b>\n\n` +
                `👤 Total Users: <b>${totalUsers}</b>\n` +
                `   ↓ <b>${dRate}%</b> convert to depositors\n` +
                `💳 Depositors: <b>${depositors}</b>\n` +
                `   ↓ <b>${oRate}%</b> request OTP\n` +
                `📱 OTP Requests: <b>${otpRequesters}</b>\n` +
                `   ↓ <b>${sRate}%</b> success rate\n` +
                `✅ OTP Success: <b>${otpSuccess}</b>`;

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_funnel' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Funnel failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_analytics' }]] }
            });
        }
    },

    async handleReferralTree(ctx) {
        const userId = ctx.from?.id?.toString();
        if (!this.isAdmin(userId)) return ctx.answerCbQuery('⛔ Admin only!', { show_alert: true });

        await ctx.answerCbQuery('🌳 Loading tree...');

        try {
            const { User } = await import('../../../models/index.js');
            
            const topReferrers = await User.find({ referralCount: { $gt: 0 } })
                .sort({ referralCount: -1 })
                .limit(10)
                .select('userId firstName referralCount referralEarnings');

            let text = `🌳 <b>Referral Tree Top 10</b>\n\n`;
            
            if (topReferrers.length === 0) {
                text += `<i>No referrals yet.</i>`;
            } else {
                topReferrers.forEach((u, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    text += `${medal} <code>${u.userId}</code>\n` +
                           `   👤 ${u.firstName || 'N/A'}\n` +
                           `   🎁 Referrals: <b>${u.referralCount || 0}</b>\n` +
                           `   💰 Earnings: <b>$${u.referralEarnings?.toFixed(2) || '0.00'}</b>\n\n`;
                });
            }

            await safeEditWithImage(ctx, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Refresh', callback_data: 'admin_referral_tree' }],
                        [{ text: '◀️ Back', callback_data: 'admin_back_users' }]
                    ]
                }
            });

        } catch (error) {
            logger.error('Referral tree failed', { error: error.message });
            await safeEditWithImage(ctx, `❌ Error: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_back_users' }]] }
            });
        }
    }
};

export default analyticsMethods;
