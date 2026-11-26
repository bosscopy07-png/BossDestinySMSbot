// bot/commands/admin/reports.js — Profits, revenue, system status, logs, master balance, analytics
// Methods are mixed into AdminCommands.prototype by bot/commands/admin.js (bodies unchanged: `this` is the AdminCommands instance).
import { Markup } from 'telegraf';
import { User, Session, Transaction, AdminLog } from '../../../models/index.js';
import { formatCurrency } from '../../../utils/helpers.js';
import logger from '../../../utils/logger.js';
import { TX_TYPES } from './constants.js';

export const reportsMethods = {
    // ═══════════════════════════════════════════════════════════
    //  DAILY REPORT
    // ═══════════════════════════════════════════════════════════

        
async handleDailyReport(ctx) {
        try {
            const now = new Date();
            const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

            const [
                newUsers,
                activeUsers,
                completedSessions,
                revenue,
                topServices,
                poolPurchases
            ] = await Promise.all([
                User.countDocuments({ createdAt: { $gte: dayAgo } }),
                User.countDocuments({ lastActive: { $gte: dayAgo } }),
                Session.countDocuments({ status: 'RECEIVED', startTime: { $gte: dayAgo } }),
                this.calculateRevenue(dayAgo),
                Session.aggregate([
                    { $match: { status: 'RECEIVED', startTime: { $gte: dayAgo } } },
                    { $group: { _id: '$service', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 5 }
                ]),
                Transaction.countDocuments({ type: TX_TYPES.POOL_PURCHASE, createdAt: { $gte: dayAgo } })
            ]);

            const topServicesText = topServices.length
                ? topServices.map(s => `• ${s._id}: <code>${s.count}</code>`).join('\n')
                : '<i>No data</i>';

            const message = `
<b>📊 Daily Report</b> (<code>${dayAgo.toLocaleDateString()}</code> — <code>${now.toLocaleDateString()}</code>)

<b>👥 Users:</b>
• New: <code>${newUsers}</code>
• Active: <code>${activeUsers}</code>

<b>📈 Sessions:</b>
• Completed: <code>${completedSessions}</code>

<b>💰 Revenue:</b> <code>${formatCurrency(revenue)}</code>

<b>📦 Pool Purchases:</b> <code>${poolPurchases}</code>

<b>🔥 Top Services:</b>
${topServicesText}
            `;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'admin_dailyreport')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

            await this.logAdminAction(ctx.from.id.toString(), 'DAILY_REPORT', null, { revenue, newUsers, activeUsers });

        } catch (error) {
            logger.error('Daily report error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to generate daily report.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  PROFITS
    // ═══════════════════════════════════════════════════════════

    
async handleProfits(ctx) {
        try {
            const now = new Date();
            const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
            const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
            const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

            const [dayRevenue, weekRevenue, monthRevenue] = await Promise.all([
                this.calculateRevenue(dayAgo),
                this.calculateRevenue(weekAgo),
                this.calculateRevenue(monthAgo)
            ]);

            let masterBalance = { usdt: 'N/A', bnb: 'N/A', address: 'N/A' };
            try {
                if (this.walletService?.getMasterBalance) {
                    masterBalance = await this.walletService.getMasterBalance();
                }
                if (this.walletService?.getMasterAddress) {
                    masterBalance.address = await this.walletService.getMasterAddress();
                }
            } catch (error) {
                logger.warn('Failed to get master balance for profits', { error: error.message });
            }

            const message = `
<b>💰 Profit Analytics</b>

<b>📅 Revenue:</b>
• 24h: <code>${formatCurrency(dayRevenue)}</code>
• 7d: <code>${formatCurrency(weekRevenue)}</code>
• 30d: <code>${formatCurrency(monthRevenue)}</code>

<b>💎 Master Wallet:</b>
• Address: <code>${masterBalance.address}</code>
• USDT: <code>${masterBalance.usdt}</code>
• BNB: <code>${masterBalance.bnb}</code>

<b>📊 By Mode (30d):</b>
${await this.getRevenueByMode(monthAgo)}

<b>📊 By Service (30d):</b>
${await this.getRevenueByService(monthAgo)}
            `;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('📥 Export CSV', 'export_profits')],
                    [Markup.button.callback('💸 Withdraw', 'withdraw_profits')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Profits error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load profit data.</b>');
        }
    },

    async getRevenueByMode(since) {
        try {
            const results = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE] },
                        status: 'COMPLETED',
                        createdAt: { $gte: since }
                    }
                },
                {
                    $group: {
                        _id: '$type',
                        total: { $sum: { $abs: '$amount' } }
                    }
                }
            ]);
            return results.map(r => `• ${r._id}: <code>${formatCurrency(r.total)}</code>`).join('\n') || '<i>No data</i>';
        } catch (error) {
            logger.error('Revenue by mode error', { error: error.message });
            return '<i>Error loading data</i>';
        }
    },

    async getRevenueByService(since) {
        try {
            const results = await Session.aggregate([
                {
                    $match: {
                        status: 'RECEIVED',
                        startTime: { $gte: since }
                    }
                },
                {
                    $group: {
                        _id: '$service',
                        count: { $sum: 1 },
                        revenue: { $sum: '$cost' }
                    }
                },
                { $sort: { revenue: -1 } },
                { $limit: 5 }
            ]);
            return results.map(r => `• ${r._id}: <code>${formatCurrency(r.revenue)}</code> (${r.count} OTPs)`).join('\n') || '<i>No data</i>';
        } catch (error) {
            logger.error('Revenue by service error', { error: error.message });
            return '<i>Error loading data</i>';
        }
    },

    async handleExportProfits(ctx) {
        try {
            if (ctx.callbackQuery && ctx.answerCbQuery) {
                await ctx.answerCbQuery('Generating export...').catch(() => {});
            }

            const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const results = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: [TX_TYPES.CHEAP_OTP, TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.POOL_PURCHASE] },
                        status: 'COMPLETED',
                        createdAt: { $gte: monthAgo }
                    }
                },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        total: { $sum: { $abs: '$amount' } }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            if (results.length === 0) {
                return this.replyError(ctx, '<b>📥 No profit data to export.</b>');
            }

            let csv = 'Date,Revenue\n';
            for (const r of results) {
                csv += `${r._id},${r.total.toFixed(2)}\n`;
            }

            await this.replySuccess(ctx, `<b>📥 Profit Export (Last 30 Days)</b>\n\n<pre>${csv}</pre>`);
        } catch (error) {
            logger.error('Export profits error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to export profits.</b>');
        }
    },

    async handleWithdrawProfits(ctx) {
        let address = 'N/A';
        try {
            if (this.walletService?.getMasterAddress) {
                address = await this.walletService.getMasterAddress();
            }
        } catch (error) {
            logger.warn('Failed to get master address', { error: error.message });
        }

        await this.replySuccess(ctx, `
<b>💸 Withdraw Profits</b>

To withdraw, send USDT from your master wallet manually or use your wallet app.

<b>Master Address:</b> <code>${address}</code>

⚠️ <i>Always keep some BNB for gas fees.</i>
        `, { parse_mode: 'HTML' });
    },

    // ═══════════════════════════════════════════════════════════
    //  SYSTEM STATUS
    // ═══════════════════════════════════════════════════════════

    
async handleSystem(ctx) {
        try {
            let masterBalance = { usdt: 'N/A', bnb: 'N/A' };
            let address = 'N/A';
            try {
                if (this.walletService?.getMasterBalance) {
                    masterBalance = await this.walletService.getMasterBalance();
                }
                if (this.walletService?.getMasterAddress) {
                    address = await this.walletService.getMasterAddress();
                }
            } catch (error) {
                logger.warn('Failed to get master data for system status', { error: error.message });
            }

            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const mins = Math.floor((uptime % 3600) / 60);

            const message = `
<b>⚙️ System Status</b>

🖥 <b>Server:</b> Online
💾 <b>Database:</b> Connected
⏱ <b>Uptime:</b> <code>${hours}h ${mins}m</code>

<b>💎 Master Wallet:</b>
• Address: <code>${address}</code>
• USDT: <code>${masterBalance.usdt}</code>
• BNB: <code>${masterBalance.bnb}</code>

<b>📊 Memory:</b>
• Used: <code>${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB</code>
• Total: <code>${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB</code>
• RSS: <code>${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB</code>

<b>🔧 Node.js:</b> <code>${process.version}</code>
            `;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🏥 Health', 'admin_healthcheck')],
                [Markup.button.callback('🔙 Back', 'admin')]     
                ]).reply_markup
            });
        } catch (error) {
            logger.error('System status error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load system status.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  ADMIN LOGS
    // ═══════════════════════════════════════════════════════════

    
async handleLogs(ctx) {
        try {
            const logs = await AdminLog.find()
                .sort({ timestamp: -1 })
                .limit(20)
                .lean();

            let message = '<b>📋 Admin Logs</b> (Last 20)\n\n';

            if (logs.length === 0) {
                message += '<i>No logs yet.</i>';
            } else {
                for (const log of logs) {
                    const time = log.timestamp ? new Date(log.timestamp).toLocaleString() : 'N/A';
                    const details = JSON.stringify(log.details || {}).substring(0, 100);
                    message += `<b>[${time}]</b>\n`;
                    message += `👤 <code>${log.adminId}</code> → <b>${log.action}</b>\n`;
                    message += `🎯 ${log.targetUserId ? `<code>${log.targetUserId}</code>` : 'N/A'}\n`;
                    message += `📄 <code>${details}</code>\n\n`;
                }
            }

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'admin_logs')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Logs error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load logs.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  MASTER BALANCE
    // ═══════════════════════════════════════════════════════════

    
async handleMasterBalance(ctx) {
        try {
            let balance = { usdt: 'N/A', bnb: 'N/A' };
            let address = 'N/A';

            try {
                if (this.walletService?.getMasterBalance) {
                    balance = await this.walletService.getMasterBalance();
                }
                if (this.walletService?.getMasterAddress) {
                    address = await this.walletService.getMasterAddress();
                }
            } catch (error) {
                logger.warn('Failed to get master balance', { error: error.message });
            }

            await this.replySuccess(ctx, `
<b>💎 Master Wallet Balance</b>

<b>Address:</b> <code>${address}</code>

<b>USDT:</b> <code>${balance.usdt}</code>
<b>BNB:</b> <code>${balance.bnb}</code>

<i>This is your revenue wallet.</i>
            `);
        } catch (error) {
            logger.error('Master balance error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to get master balance.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  ANALYTICS (NEW FEATURE)
    // ═══════════════════════════════════════════════════════════

    

    
async handleAnalyticsRevenue(ctx) {
        try {
            const now = new Date();
            const days7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
            const days30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

            const [weekData, monthData] = await Promise.all([
                Transaction.aggregate([
                    { $match: { status: 'COMPLETED', createdAt: { $gte: days7 } } },
                    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: { $abs: '$amount' } } } },
                    { $sort: { _id: 1 } }
                ]),
                Transaction.aggregate([
                    { $match: { status: 'COMPLETED', createdAt: { $gte: days30 } } },
                    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: { $abs: '$amount' } } } },
                    { $sort: { _id: 1 } }
                ])
            ]);

            let message = '<b>💰 Revenue Trends</b>\n\n<b>Last 7 Days:</b>\n';
            weekData.forEach(d => {
                message += `• ${d._id}: <code>${formatCurrency(d.total)}</code>\n`;
            });

            const monthTotal = monthData.reduce((sum, d) => sum + d.total, 0);
            message += `\n<b>30-Day Total:</b> <code>${formatCurrency(monthTotal)}</code>\n`;
            message += `<b>Daily Average:</b> <code>${formatCurrency(monthTotal / 30)}</code>`;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'analytics_revenue')],
                    [Markup.button.callback('🔙 Back', 'admin_analytics')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Analytics revenue error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load revenue analytics.</b>');
        }
    },

    async handleAnalyticsUsers(ctx) {
        try {
            const now = new Date();
            const intervals = [1, 7, 30, 90].map(d => new Date(now - d * 24 * 60 * 60 * 1000));

            const [new1d, new7d, new30d, new90d, total, active7d, active30d] = await Promise.all([
                User.countDocuments({ createdAt: { $gte: intervals[0] } }),
                User.countDocuments({ createdAt: { $gte: intervals[1] } }),
                User.countDocuments({ createdAt: { $gte: intervals[2] } }),
                User.countDocuments({ createdAt: { $gte: intervals[3] } }),
                User.countDocuments(),
                User.countDocuments({ lastActive: { $gte: intervals[1] } }),
                User.countDocuments({ lastActive: { $gte: intervals[2] } })
            ]);

            const message = `
<b>👥 User Growth Analytics</b>

<b>New Users:</b>
• 24h: <code>${new1d}</code>
• 7d: <code>${new7d}</code>
• 30d: <code>${new30d}</code>
• 90d: <code>${new90d}</code>

<b>Active Users:</b>
• 7d active: <code>${active7d}</code>
• 30d active: <code>${active30d}</code>

<b>Total Users:</b> <code>${total}</code>
<b>Retention (7d/30d):</b> <code>${new30d > 0 ? ((active7d / new30d) * 100).toFixed(1) : 0}%</code>
            `;

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'analytics_users')],
                    [Markup.button.callback('🔙 Back', 'admin_analytics')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Analytics users error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load user analytics.</b>');
        }
    },

    async handleAnalyticsServices(ctx) {
        try {
            const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

            const services = await Session.aggregate([
                { $match: { status: 'RECEIVED', startTime: { $gte: monthAgo } } },
                { $group: { _id: '$service', count: { $sum: 1 }, revenue: { $sum: '$cost' }, avgTime: { $avg: '$duration' } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            let message = '<b>🔥 Service Demand (30d)</b>\n\n';
            services.forEach((s, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
                message += `${medal} <b>${s._id}</b>\n`;
                message += `   Requests: <code>${s.count}</code> | Revenue: <code>${formatCurrency(s.revenue)}</code>\n`;
                message += `   Avg Time: <code>${(s.avgTime || 0).toFixed(1)}s</code>\n\n`;
            });

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'analytics_services')],
                    [Markup.button.callback('🔙 Back', 'admin_analytics')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Analytics services error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load service analytics.</b>');
        }
    },

    async handleAnalyticsRetention(ctx) {
        try {
            const now = new Date();
            const cohorts = [];
            const weeks = 4;

            for (let i = 0; i < weeks; i++) {
                const weekStart = new Date(now - (i + 1) * 7 * 24 * 60 * 60 * 1000);
                const weekEnd = new Date(now - i * 7 * 24 * 60 * 60 * 1000);

                const newUsers = await User.countDocuments({ createdAt: { $gte: weekStart, $lt: weekEnd } });
                const retained = await User.countDocuments({
                    createdAt: { $gte: weekStart, $lt: weekEnd },
                    lastActive: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) }
                });

                cohorts.push({
                    week: `Week ${weeks - i}`,
                    newUsers,
                    retained,
                    rate: newUsers > 0 ? ((retained / newUsers) * 100).toFixed(1) : 0
                });
            }

            let message = '<b>🔄 Retention Cohorts</b>\n\n';
            cohorts.forEach(c => {
                message += `<b>${c.week}</b>: <code>${c.newUsers}</code> new → <code>${c.retained}</code> retained (<code>${c.rate}%</code>)\n`;
            });

            await this.replySuccess(ctx, message, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'analytics_retention')],
                    [Markup.button.callback('🔙 Back', 'admin_analytics')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Analytics retention error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load retention analytics.</b>');
        }
    }
};

export default reportsMethods;
