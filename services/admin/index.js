import { User, Session, Transaction, AdminLog, Referral } from '../../models/index.js';
import { generateId, formatCurrency } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class AdminService {
    constructor(walletService, referralService) {
        this.walletService = walletService;
        this.referralService = referralService;
    }

    async logAction(adminId, action, targetUserId = null, details = {}) {
        try {
            await AdminLog.create({
                logId: generateId(),
                type: 'ADMIN_ACTION',
                adminId,
                targetUserId,
                action,
                details,
                timestamp: new Date()
            });
        } catch (error) {
            logger.error('Failed to log admin action', { error: error.message });
        }
    }

    // Dashboard stats
    async getDashboardStats() {
        const now = new Date();
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

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
            masterWallet
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
            Referral.countDocuments({ status: 'DEPOSITED' }),
            this.walletService.getMasterWalletInfo().catch(() => ({ usdt: '0', bnb: '0' }))
        ]);

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

        return {
            users: {
                total: totalUsers,
                new24h: newUsers24h,
                active24h: activeUsers24h,
                vip: vipUsers,
                blacklisted: blacklistedUsers
            },
            sessions: {
                total: totalSessions,
                today: sessions24h,
                successRate: stats.total > 0 ? ((stats.received / stats.total) * 100).toFixed(1) : 0,
                byStatus: {
                    received: stats.received,
                    timeout: stats.timeout,
                    cancelled: stats.cancelled
                }
            },
            revenue: {
                today: revenue24h,
                week: revenue7d,
                month: revenue30d
            },
            referrals: {
                pendingApproval: pendingReferrals
            },
            wallet: {
                masterAddress: masterWallet.address,
                usdtBalance: parseFloat(masterWallet.usdt),
                bnbBalance: parseFloat(masterWallet.bnb)
            },
            system: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                nodeVersion: process.version
            }
        };
    }

    async calculateRevenue(since) {
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
    }

    // User management
    async getUsersList(page = 1, limit = 20, filters = {}) {
        const query = {};
        
        if (filters.mode) query.mode = filters.mode;
        if (filters.isBlacklisted !== undefined) query.isBlacklisted = filters.isBlacklisted;
        if (filters.hasBalance) query.balance = { $gt: 0 };
        if (filters.search) {
            query.$or = [
                { userId: { $regex: filters.search, $options: 'i' } },
                { username: { $regex: filters.search, $options: 'i' } },
                { firstName: { $regex: filters.search, $options: 'i' } }
            ];
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
                pages: Math.ceil(total / limit)
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
            Referral.find({ referrerId: userId })
                .sort({ createdAt: -1 })
                .limit(10)
                .lean()
        ]);

        if (!user) throw new Error('USER_NOT_FOUND');

        // Calculate stats
        const totalSpent = transactions
            .filter(t => ['CHEAP_OTP', 'BUNDLE_PURCHASE', 'VIP_SUBSCRIPTION'].includes(t.type))
            .reduce((sum, t) => sum + Math.abs(t.amount), 0);

        const totalDeposited = transactions
            .filter(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED')
            .reduce((sum, t) => sum + t.amount, 0);

        return {
            user,
            stats: {
                totalSessions: sessions.length,
                successfulSessions: sessions.filter(s => s.status === 'RECEIVED').length,
                totalSpent,
                totalDeposited,
                netRevenue: totalSpent // What user has paid
            },
            recentSessions: sessions,
            recentTransactions: transactions,
            referrals
        };
    }

    async updateUser(userId, updates, adminId) {
        const allowedUpdates = [
            'balance', 'bundleRemaining', 'vipExpiry', 'mode',
            'isBlacklisted', 'blacklistReason', 'preferredCountry'
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
        const txId = await this.walletService.addBalance(userId, amount, adminId, reason);
        await this.logAction(adminId, 'ADD_BALANCE', userId, { amount, reason, txId });
        return txId;
    }

    async deductBalance(userId, amount, adminId, reason) {
        const txId = await this.walletService.deductBalance(userId, amount, adminId, reason);
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

        // Cancel active sessions
        await Session.updateMany(
            { userId, status: { $in: ['WAITING', 'CHECKING'] } },
            { $set: { status: 'CANCELLED' } }
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

    // Broadcast
    async broadcastMessage(message, filters = {}) {
        const query = { isBlacklisted: false };
        
        if (filters.mode) query.mode = filters.mode;
        if (filters.vipOnly) query.vipExpiry = { $gt: new Date() };
        if (filters.activeSince) query.lastActive = { $gte: filters.activeSince };

        const users = await User.find(query).select('userId');
        const results = { sent: 0, failed: 0 };

        for (const user of users) {
            try {
                // This would need bot instance to send messages
                // Implementation depends on how you inject the bot
                results.sent++;
            } catch (error) {
                results.failed++;
            }
        }

        return results;
    }

    // Referral management
    async getPendingReferrals(page = 1, limit = 20) {
        return await this.referralService.getPendingRewards(page, limit);
    }

    async approveReferral(txId, adminId) {
        const result = await this.referralService.approveReward(txId, adminId);
        await this.logAction(adminId, 'APPROVE_REFERRAL', result.referrerId, { txId, amount: result.amount });
        return result;
    }

    async rejectReferral(txId, adminId, reason) {
        const result = await this.referralService.rejectReward(txId, adminId, reason);
        await this.logAction(adminId, 'REJECT_REFERRAL', null, { txId, reason });
        return result;
    }

    // System settings
    async updateSettings(settings, adminId) {
        // Update config in database or file
        // Implementation depends on your settings storage
        await this.logAction(adminId, 'UPDATE_SETTINGS', null, settings);
        return settings;
    }

    // Export data
    async exportUsers(format = 'csv') {
        const users = await User.find().lean();
        
        if (format === 'csv') {
            const headers = ['userId', 'username', 'balance', 'mode', 'vipExpiry', 'createdAt'];
            const rows = users.map(u => headers.map(h => u[h] || '').join(','));
            return [headers.join(','), ...rows].join('\n');
        }

        return users;
    }

    async exportTransactions(startDate, endDate, format = 'csv') {
        const query = {
            createdAt: {
                $gte: startDate || new Date(0),
                $lte: endDate || new Date()
            }
        };

        const transactions = await Transaction.find(query).lean();

        if (format === 'csv') {
            const headers = ['txId', 'userId', 'type', 'amount', 'status', 'createdAt'];
            const rows = transactions.map(t => headers.map(h => t[h] || '').join(','));
            return [headers.join(','), ...rows].join('\n');
        }

        return transactions;
    }

    // Logs
    async getAdminLogs(page = 1, limit = 50, filters = {}) {
        const query = {};
        if (filters.adminId) query.adminId = filters.adminId;
        if (filters.action) query.action = filters.action;
        if (filters.targetUserId) query.targetUserId = filters.targetUserId;

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
                pages: Math.ceil(total / limit)
            }
        };
    }
}

export default AdminService;

 
