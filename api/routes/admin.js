import { Router } from 'express';
import AdminService from '../../services/admin/index.js';
import WalletService from '../../services/wallet/index.js';
import ReferralService from '../../services/referral/index.js';
import { requireAdmin } from '../middleware/adminAuth.js';

const router = Router();

// Initialize services
const walletService = new WalletService();
const referralService = new ReferralService(walletService);
const adminService = new AdminService(walletService, referralService);

router.use(requireAdmin);

// Dashboard
router.get('/dashboard', async (req, res) => {
    try {
        const stats = await adminService.getDashboardStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Users
router.get('/users', async (req, res) => {
    try {
        const { page, limit, mode, search } = req.query;
        const result = await adminService.getUsersList(
            parseInt(page) || 1,
            parseInt(limit) || 20,
            { mode, search }
        );
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/users/:userId', async (req, res) => {
    try {
        const detail = await adminService.getUserDetail(req.params.userId);
        res.json({ success: true, data: detail });
    } catch (error) {
        res.status(404).json({ success: false, error: error.message });
    }
});

router.patch('/users/:userId', async (req, res) => {
    try {
        const user = await adminService.updateUser(
            req.params.userId,
            req.body,
            req.adminId
        );
        res.json({ success: true, data: user });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Financial
router.post('/users/:userId/balance/add', async (req, res) => {
    try {
        const { amount, reason } = req.body;
        const txId = await adminService.addBalance(
            req.params.userId,
            amount,
            req.adminId,
            reason
        );
        res.json({ success: true, data: { txId } });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

router.post('/users/:userId/balance/deduct', async (req, res) => {
    try {
        const { amount, reason } = req.body;
        const txId = await adminService.deductBalance(
            req.params.userId,
            amount,
            req.adminId,
            reason
        );
        res.json({ success: true, data: { txId } });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Blacklist
router.post('/users/:userId/blacklist', async (req, res) => {
    try {
        const { reason } = req.body;
        await adminService.blacklistUser(req.params.userId, reason, req.adminId);
        res.json({ success: true, message: 'User blacklisted' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

router.post('/users/:userId/whitelist', async (req, res) => {
    try {
        await adminService.whitelistUser(req.params.userId, req.adminId);
        res.json({ success: true, message: 'User whitelisted' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Referrals
router.get('/referrals/pending', async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await adminService.getPendingReferrals(
            parseInt(page) || 1,
            parseInt(limit) || 20
        );
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/referrals/:txId/approve', async (req, res) => {
    try {
        const result = await adminService.approveReferral(req.params.txId, req.adminId);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

router.post('/referrals/:txId/reject', async (req, res) => {
    try {
        const { reason } = req.body;
        const result = await adminService.rejectReferral(req.params.txId, req.adminId, reason);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Wallet
router.get('/wallet/master', async (req, res) => {
    try {
        const info = await walletService.getMasterWalletInfo();
        res.json({ success: true, data: info });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/wallet/withdraw', async (req, res) => {
    try {
        const { toAddress, amount } = req.body;
        const result = await walletService.withdrawProfits(toAddress, amount, req.adminId);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Broadcast
router.post('/broadcast', async (req, res) => {
    try {
        const { message, filters } = req.body;
        const result = await adminService.broadcastMessage(message, filters);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Export
router.get('/export/users', async (req, res) => {
    try {
        const csv = await adminService.exportUsers('csv');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/export/transactions', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const csv = await adminService.exportTransactions(
            startDate ? new Date(startDate) : null,
            endDate ? new Date(endDate) : null,
            'csv'
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Logs
router.get('/logs', async (req, res) => {
    try {
        const { page, limit, action, adminId } = req.query;
        const result = await adminService.getAdminLogs(
            parseInt(page) || 1,
            parseInt(limit) || 50,
            { action, adminId }
        );
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;

