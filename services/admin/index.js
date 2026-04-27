import { User, Session, Transaction, AdminLog } from '../../models/index.js';
import { generateId, formatCurrency } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class AdminService {
    constructor(walletService, referralService, bot = null) {
        this.walletService = walletService;
        this.referralService = referralService;
        this.bot = bot; // For broadcast messages
    }

    async logAction(adminId, action, targetUserId = null, details = {}) {
        try {
            await AdminLog.create({
                logId: generateId(),
                type: 'ADMIN_ACTION',
                adminId: adminId?.toString(),
                targetUserId: targetUserId?.toString(),
                action,
                details,
                timestamp: new Date()
            });
        } catch (error) {
            logger.error('Failed to log admin action', { adminId, action, error: error.message });
        }
    }

    // Dashboard stats
    async getDashboardStats() {
        const now = new Date();
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        let masterWallet = { address: 'N/A', usdt: '0', bnb: '0' };
        try {
            // Try getMasterWalletInfo first, fallback to getMasterBalance
            if (this.walletService.getMasterWalletInfo) {
                masterWallet = await this.walletService.getMasterWalletInfo();
            } else if (this.walletService.getMasterBalance) {
                const bal = await this.walletService.getMasterBalance();
                masterWallet = { address: this.walletService.getMasterAddress?.() || 'N/A', usdt: bal.usdt, bnb: bal.bnb };
            }
        } catch (error) {
            logger.warn('Failed to get master wallet info', { error: error.message });
        }

        const [
            totalUsers,
            newUsers24h,
            activeUsers24h,
            vipUsers,
            blacklistedUsers,
            totalSessions,
            sessions24h,
            revenue24h,
            revenue7d,
            revenue30d,
            pendingReferrals,
            pendingDeposits,
            totalRevenueAllTime
        ] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ createdAt: { $gte: dayAgo } }),
            User.countDocuments({ lastActive: { $gte: dayAgo } }),
            User.countDocuments({ vipExpiry: { $gt: now } }),
            User.countDocuments({ isBlacklisted: true }),
            Session.countDocuments(),
            Session.countDocuments({ startTime: { $gte: dayAgo } }),
            this.calculateRevenue(dayAgo),
            this.calculateRevenue(weekAgo),
            this.calculateRevenue(monthAgo),
            this.getPendingReferralsCount(),
            Transaction.countDocuments({ type: 'DEPOSIT', status: 'PENDING' }),
            this.calculateRevenue(new Date(0))
        ]);
        // IN bot/commands/admin.js — processDeductBalance() method

// BEFORE:
await Transaction.create({
    txId,
    userId: targetId,
    type: 'ADMIN_ADJUSTMENT',   // ← WRONG
    amount: -amount,
    ...
});

// AFTER:
await Transaction.create({
    txId,
    userId: targetId,
    type: 'ADMIN_DEDUCT',       // ← FIXED
    amount: -amount,
    status: 'COMPLETED',
    metadata: { adminId: ctx.from.id.toString(), reason },
    createdAt: new Date()
});
        

        const otpStats24h = await Session.aggregate([
            { $match: { startTime: { $gte: dayAgo } } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    received: { $sum: { $cond: [{ $eq: ['$status', 'RECEIVED'] }, 1, 0] } },
                    timeout: { $sum: { $cond: [{ $eq: ['$status', 'TIMEOUT'] }, 1, 0] } },
                    cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } }
                }
            }
        ]);

        const stats = otpStats24h[0] || { total: 0, received: 0, timeout: 0, cancelled: 0 };

        // Calculate average session duration
        const avgDurationAgg = await Session.aggregate([
            { $match: { startTime: { $gte: dayAgo }, endTime: { $exists: true } } },
            {
                $group: {
                    _id: null,
                    avgDuration: { $avg: { $subtract: ['$endTime', '$startTime'] } }
                }
            }
        ]);
        const avgDuration = avgDurationAgg[0]?.avgDuration || 0;

        // Top services today
        const topServices = await Session.aggregate([
            { $match: { startTime: { $gte: dayAgo } } },
            { $group: { _id: '$service', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]);

        // Revenue by type (24h)
        const revenueByType = await Transaction.aggregate([
            {
                $match: {
                    type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'] },
                    status: 'COMPLETED',
                    createdAt: { $gte: dayAgo }
                }
            },
            {
                $group: {
                    _id: '$type',
                    total: { $sum: { $abs: '$amount' } }
                }
            }
        ]);

        return {
            users: {
                total: totalUsers,
                new24h: newUsers24h,
                active24h: activeUsers24h,
                vip: vipUsers,
                blacklisted: blacklistedUsers,
                growthRate: totalUsers > 0 ? ((newUsers24h / totalUsers) * 100).toFixed(2) : 0
            },
            sessions: {
                total: totalSessions,
                today: sessions24h,
                successRate: stats.total > 0 ? ((stats.received / stats.total) * 100).toFixed(1) : 0,
                byStatus: {
                    received: stats.received,
                    timeout: stats.timeout,
                    cancelled: stats.cancelled
                },
                avgDuration: Math.round(avgDuration / 1000) // seconds
            },
            revenue: {
                today: revenue24h,
                week: revenue7d,
                month: revenue30d,
                allTime: totalRevenueAllTime,
                byType: revenueByType.reduce((acc, r) => {
                    acc[r._id] = r.total;
                    return acc;
                }, {})
            },
            referrals: {
                pendingApproval: pendingReferrals
            },
            deposits: {
                pending: pendingDeposits
            },
            wallet: {
                masterAddress: masterWallet.address || 'N/A',
                usdtBalance: parseFloat(masterWallet.usdt) || 0,
                bnbBalance: parseFloat(masterWallet.bnb) || 0
            },
            services: {
                topToday: topServices.map(s => ({ name: s._id, count: s.count }))
            },
            system: {
                uptime: process.uptime(),
                uptimeFormatted: this.formatUptime(process.uptime()),
                memory: {
                    used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                    total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
                },
                nodeVersion: process.version
            }
        };
    }

    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (days > 0) return `${days}d ${hours}h ${mins}m`;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    }

    async calculateRevenue(since) {
        try {
            const result = await Transaction.aggregate([
                {
                    $match: {
                        type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'] },
                        status: 'COMPLETED',
                        createdAt: { $gte: since }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: { $abs: '$amount' } }
                    }
                }
            ]);
            return Math.abs(result[0]?.total || 0);
        } catch (error) {
            logger.error('Revenue calculation failed', { error: error.message });
            return 0;
        }
    }

    async getPendingReferralsCount() {
        try {
            if (this.referralService?.getPendingCount) {
                return await this.referralService.getPendingCount();
            }
            // Fallback: count users with pending referral rewards
            const count = await User.countDocuments({
                referralRewardsPending: { $gt: 0 }
            });
            return count;
        } catch (error) {
            logger.warn('Failed to get pending referrals count', { error: error.message });
            return 0;
        }
    }

    // User management
    async getUsersList(page = 1, limit = 20, filters = {}) {
        const query = {};
        
        if (filters.mode) query.mode = filters.mode;
        if (filters.isBlacklisted !== undefined) query.isBlacklisted = filters.isBlacklisted;
        if (filters.hasBalance) query.balance = { $gt: 0 };
        if (filters.isVip) query.vipExpiry = { $gt: new Date() };
        if (filters.minBalance) query.balance = { $gte: filters.minBalance };
        if (filters.maxBalance) query.balance = { ...query.balance, $lte: filters.maxBalance };
        if (filters.search) {
            const searchRegex = { $regex: filters.search, $options: 'i' };
            query.$or = [
                { userId: searchRegex },
                { username: searchRegex },
                { firstName: searchRegex },
                { lastName: searchRegex }
            ];
        }
        if (filters.dateFrom || filters.dateTo) {
            query.createdAt = {};
            if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
            if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
        }

        const [users, total] = await Promise.all([
            User.find(query)
                .sort({ lastActive: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            User.countDocuments(query)
        ]);

        return {
            users,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
                hasNext: page * limit < total,
                hasPrev: page > 1
            }
        };
    }

    async getUserDetail(userId) {
        const [user, sessions, transactions, referrals] = await Promise.all([
            User.findOne({ userId }).lean(),
            Session.find({ userId })
                .sort({ startTime: -1 })
                .limit(20)
                .lean(),
            Transaction.find({ userId })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            User.find({ referredBy: userId })
                .select('userId username createdAt')
                .lean()
        ]);

        if (!user) throw new Error('USER_NOT_FOUND');

        const totalSpent = transactions
            .filter(t => ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'].includes(t.type))
            .reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);

        const totalDeposited = transactions
            .filter(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED')
            .reduce((sum, t) => sum + (t.amount || 0), 0);

        const totalRefEarnings = transactions
            .filter(t => t.type === 'REFERRAL_REWARD' && t.status === 'COMPLETED')
            .reduce((sum, t) => sum + (t.amount || 0), 0);

        return {
            user,
            stats: {
                totalSessions: sessions.length,
                successfulSessions: sessions.filter(s => s.status === 'RECEIVED').length,
                failedSessions: sessions.filter(s => s.status === 'TIMEOUT').length,
                totalSpent,
                totalDeposited,
                totalRefEarnings,
                netBalance: (user.balance || 0) - (user.lockedBalance || 0),
                lifetimeValue: totalSpent + (user.bundleRemaining || 0) * (config.prices?.cheapOtp || 0.05)
            },
            recentSessions: sessions,
            recentTransactions: transactions,
            referrals: {
                count: referrals.length,
                list: referrals,
                earnings: totalRefEarnings
            }
        };
    }

    async updateUser(userId, updates, adminId) {
        const allowedUpdates = [
            'balance', 'bundleRemaining', 'vipExpiry', 'mode',
            'isBlacklisted', 'blacklistReason', 'preferredCountry',
            'notificationsEnabled', 'privacyEnabled'
        ];

        const filteredUpdates = {};
        for (const key of allowedUpdates) {
            if (updates[key] !== undefined) {
                filteredUpdates[key] = updates[key];
            }
        }

        if (Object.keys(filteredUpdates).length === 0) {
            throw new Error('NO_VALID_UPDATES');
        }

        const user = await User.findOneAndUpdate(
            { userId },
            { $set: filteredUpdates },
            { new: true }
        );

        if (!user) throw new Error('USER_NOT_FOUND');

        await this.logAction(adminId, 'UPDATE_USER', userId, filteredUpdates);

        return user;
    }

    // Financial operations
    async addBalance(userId, amount, adminId, reason) {
        if (!amount || amount <= 0) throw new Error('INVALID_AMOUNT');
        
        let txId;
        if (this.walletService.addBalance) {
            txId = await this.walletService.addBalance(userId, amount, adminId, reason);
        } else {
            // Fallback: direct DB update
            await User.updateOne({ userId }, { $inc: { balance: amount } });
            txId = generateId();
            await Transaction.create({
                txId,
                userId,
                type: 'ADMIN_ADD',
                amount,
                status: 'COMPLETED',
                metadata: { adminId, reason },
                createdAt: new Date()
            });
        }
        
        await this.logAction(adminId, 'ADD_BALANCE', userId, { amount, reason, txId });
        return txId;
    }

    async deductBalance(userId, amount, adminId, reason) {
        if (!amount || amount <= 0) throw new Error('INVALID_AMOUNT');
        
        const user = await User.findOne({ userId });
        if (!user) throw new Error('USER_NOT_FOUND');
        if ((user.balance || 0) < amount) throw new Error('INSUFFICIENT_BALANCE');

        let txId;
        if (this.walletService.deductBalance) {
            txId = await this.walletService.deductBalance(userId, amount, adminId, reason);
        } else {
            await User.updateOne({ userId }, { $inc: { balance: -amount } });
            txId = generateId();
            await Transaction.create({
                txId,
                userId,
                type: 'ADMIN_DEDUCT',
                amount: -amount,
                status: 'COMPLETED',
                metadata: { adminId, reason },
                createdAt: new Date()
            });
        }
        
        await this.logAction(adminId, 'DEDUCT_BALANCE', userId, { amount, reason, txId });
        return txId;
    }

    // Blacklist operations
    async blacklistUser(userId, reason, adminId) {
        await User.updateOne(
            { userId },
            {
                $set: {
                    isBlacklisted: true,
                    blacklistReason: reason,
                    blacklistDate: new Date()
                }
            }
        );

        await Session.updateMany(
            { userId, status: { $in: ['WAITING', 'CHECKING'] } },
            { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
        );

        await this.logAction(adminId, 'BLACKLIST', userId, { reason });
    }

    async whitelistUser(userId, adminId) {
        await User.updateOne(
            { userId },
            {
                $set: {
                    isBlacklisted: false,
                    blacklistReason: null,
                    blacklistDate: null
                }
            }
        );

        await this.logAction(adminId, 'WHITELIST', userId, {});
    }

    // Broadcast - NOW ACTUALLY WORKS
    async broadcastMessage(message, filters = {}, options = {}) {
        if (!this.bot) {
            logger.error('Broadcast failed: no bot instance provided');
            throw new Error('BOT_NOT_INITIALIZED');
        }

        const query = { isBlacklisted: false };
        if (filters.mode) query.mode = filters.mode;
        if (filters.vipOnly) query.vipExpiry = { $gt: new Date() };
        if (filters.activeSince) query.lastActive = { $gte: filters.activeSince };
        if (filters.minBalance) query.balance = { $gte: filters.minBalance };

        const users = await User.find(query).select('userId').lean();
        const results = { sent: 0, failed: 0, total: users.length };
        const delay = options.delay || 50; // ms between messages
        const batchSize = options.batchSize || 30; // Process in batches

        logger.info('Broadcast started', { targetCount: users.length, filters });

        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (user) => {
                try {
                    await this.bot.telegram.sendMessage(user.userId, message, {
                        parse_mode: options.parseMode || undefined,
                        disable_notification: options.silent || false
                    });
                    results.sent++;
                } catch (error) {
                    results.failed++;
                    if (error.response?.error_code === 403) {
                        // User blocked bot, mark as inactive
                        await User.updateOne({ userId: user.userId }, { $set: { blockedBot: true } });
                    }
                }
            }));

            // Rate limit protection
            if (i + batchSize < users.length) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        logger.info('Broadcast completed', results);
        return results;
    }

    // Referral management
    async getPendingReferrals(page = 1, limit = 20) {
        if (this.referralService?.getPendingRewards) {
            return await this.referralService.getPendingRewards(page, limit);
        }

        // Fallback: query users with pending rewards
        const query = { referralRewardsPending: { $gt: 0 } };
        const [users, total] = await Promise.all([
            User.find(query)
                .sort({ referralRewardsPending: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            User.countDocuments(query)
        ]);

        return {
            referrals: users.map(u => ({
                userId: u.userId,
                username: u.username,
                pendingAmount: u.referralRewardsPending,
                totalEarnings: u.referralEarnings,
                referralCount: u.referralCount
            })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        };
    }

        async approveReferral(txId, adminId) {
        if (this.referralService?.approveReward) {
            const result = await this.referralService.approveReward(txId, adminId);
            await this.logAction(adminId, 'APPROVE_REFERRAL', result.referrerId, { txId, amount: result.amount });
            return result;
        }

        // Fallback: manual approval via transaction
        const tx = await Transaction.findOne({ txId, type: 'REFERRAL_REWARD', status: 'PENDING' });
        if (!tx) throw new Error('TRANSACTION_NOT_FOUND');

        await Promise.all([
            User.updateOne({ userId: tx.userId }, { $inc: { balance: tx.amount, referralRewardsPending: -tx.amount } }),
            Transaction.updateOne({ txId }, { $set: { status: 'COMPLETED', approvedBy: adminId, approvedAt: new Date() } })
        ]);

        await this.logAction(adminId, 'APPROVE_REFERRAL', tx.userId, { txId, amount: tx.amount });
        return { txId, amount: tx.amount, userId: tx.userId };
    }

    async rejectReferral(txId, adminId, reason) {
        if (this.referralService?.rejectReward) {
            const result = await this.referralService.rejectReward(txId, adminId, reason);
            await this.logAction(adminId, 'REJECT_REFERRAL', null, { txId, reason });
            return result;
        }

        const tx = await Transaction.findOne({ txId, type: 'REFERRAL_REWARD', status: 'PENDING' });
        if (!tx) throw new Error('TRANSACTION_NOT_FOUND');

        await Transaction.updateOne(
            { txId },
            { $set: { status: 'REJECTED', rejectedBy: adminId, rejectedAt: new Date(), rejectionReason: reason } }
        );

        await this.logAction(adminId, 'REJECT_REFERRAL', tx.userId, { txId, reason });
        return { txId, status: 'REJECTED' };
    }

    // System settings
    async updateSettings(settings, adminId) {
        // Validate settings
        const allowedSettings = ['prices', 'limits', 'providers', 'maintenance', 'referral'];
        const validated = {};
        
        for (const key of allowedSettings) {
            if (settings[key] !== undefined) {
                validated[key] = settings[key];
            }
        }

        if (Object.keys(validated).length === 0) {
            throw new Error('NO_VALID_SETTINGS');
        }

        // Update in-memory config (persistent storage depends on your setup)
        Object.assign(config, validated);

        await this.logAction(adminId, 'UPDATE_SETTINGS', null, validated);
        return validated;
    }

    // Export data with proper CSV escaping
    escapeCSV(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    async exportUsers(format = 'csv') {
        const users = await User.find().lean();
        
        if (format === 'csv') {
            const headers = ['userId', 'username', 'firstName', 'lastName', 'balance', 'lockedBalance', 'bundleRemaining', 'mode', 'vipExpiry', 'isBlacklisted', 'referralCode', 'referredBy', 'referralCount', 'createdAt', 'lastActive'];
            const rows = users.map(u => headers.map(h => this.escapeCSV(u[h])).join(','));
            return [headers.join(','), ...rows].join('\n');
        }

        if (format === 'json') {
            return JSON.stringify(users, null, 2);
        }

        return users;
    }

    async exportTransactions(startDate, endDate, format = 'csv') {
        const query = {
            createdAt: {
                $gte: startDate ? new Date(startDate) : new Date(0),
                $lte: endDate ? new Date(endDate) : new Date()
            }
        };

        const transactions = await Transaction.find(query).lean();

        if (format === 'csv') {
            const headers = ['txId', 'userId', 'type', 'amount', 'status', 'metadata', 'createdAt'];
            const rows = transactions.map(t => headers.map(h => {
                if (h === 'metadata') return this.escapeCSV(JSON.stringify(t[h] || {}));
                return this.escapeCSV(t[h]);
            }).join(','));
            return [headers.join(','), ...rows].join('\n');
        }

        if (format === 'json') {
            return JSON.stringify(transactions, null, 2);
        }

        return transactions;
    }

    async exportSessions(startDate, endDate, format = 'csv') {
        const query = {
            startTime: {
                $gte: startDate ? new Date(startDate) : new Date(0),
                $lte: endDate ? new Date(endDate) : new Date()
            }
        };

        const sessions = await Session.find(query).lean();

        if (format === 'csv') {
            const headers = ['sessionId', 'userId', 'mode', 'service', 'country', 'number', 'status', 'cost', 'otpCode', 'startTime', 'endTime'];
            const rows = sessions.map(s => headers.map(h => this.escapeCSV(s[h])).join(','));
            return [headers.join(','), ...rows].join('\n');
        }

        return sessions;
    }

    // Logs
    async getAdminLogs(page = 1, limit = 50, filters = {}) {
        const query = {};
        if (filters.adminId) query.adminId = filters.adminId;
        if (filters.action) query.action = filters.action;
        if (filters.targetUserId) query.targetUserId = filters.targetUserId;
        if (filters.dateFrom || filters.dateTo) {
            query.timestamp = {};
            if (filters.dateFrom) query.timestamp.$gte = new Date(filters.dateFrom);
            if (filters.dateTo) query.timestamp.$lte = new Date(filters.dateTo);
        }

        const [logs, total] = await Promise.all([
            AdminLog.find(query)
                .sort({ timestamp: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            AdminLog.countDocuments(query)
        ]);

        return {
            logs,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
                hasNext: page * limit < total,
                hasPrev: page > 1
            }
        };
    }

    // Service management
    async getServiceStats() {
        const now = new Date();
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

        const [serviceStats, countryStats, hourlyStats] = await Promise.all([
            // By service
            Session.aggregate([
                { $match: { startTime: { $gte: dayAgo } } },
                { $group: { _id: '$service', count: { $sum: 1 }, success: { $sum: { $cond: [{ $eq: ['$status', 'RECEIVED'] }, 1, 0] } } } },
                { $sort: { count: -1 } }
            ]),
            // By country
            Session.aggregate([
                { $match: { startTime: { $gte: dayAgo } } },
                { $group: { _id: '$country', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]),
            // Hourly distribution
            Session.aggregate([
                { $match: { startTime: { $gte: dayAgo } } },
                { $group: { _id: { $hour: '$startTime' }, count: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ])
        ]);

        return {
            byService: serviceStats.map(s => ({ name: s._id, requests: s.count, successRate: s.count > 0 ? ((s.success / s.count) * 100).toFixed(1) : 0 })),
            byCountry: countryStats.map(c => ({ code: c._id, requests: c.count })),
            byHour: hourlyStats.map(h => ({ hour: h._id, requests: h.count }))
        };
    }

    // Financial reports
    async getFinancialReport(startDate, endDate) {
        const query = {
            createdAt: {
                $gte: startDate ? new Date(startDate) : new Date(0),
                $lte: endDate ? new Date(endDate) : new Date()
            }
        };

        const [revenue, expenses, deposits, withdrawals] = await Promise.all([
            Transaction.aggregate([
                { $match: { ...query, type: { $in: ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'] }, status: 'COMPLETED' } },
                { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
            ]),
            Transaction.aggregate([
                { $match: { ...query, type: { $in: ['REFERRAL_REWARD', 'ADMIN_ADD'] }, status: 'COMPLETED' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            Transaction.aggregate([
                { $match: { ...query, type: 'DEPOSIT', status: 'COMPLETED' } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Transaction.aggregate([
                { $match: { ...query, type: 'WITHDRAWAL', status: 'COMPLETED' } },
                { $group: { _id: null, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } }
            ])
        ]);

        return {
            period: { start: startDate, end: endDate },
            revenue: revenue[0]?.total || 0,
            expenses: expenses[0]?.total || 0,
            netProfit: (revenue[0]?.total || 0) - (expenses[0]?.total || 0),
            deposits: { total: deposits[0]?.total || 0, count: deposits[0]?.count || 0 },
            withdrawals: { total: withdrawals[0]?.total || 0, count: withdrawals[0]?.count || 0 }
        };
    }
}

export default AdminService;
