import { Router } from 'express';
import { ApiKey } from '../../models/index.js';
import sessionManager from '../../services/otp/index.js';
import logger from '../../utils/logger.js';

const router = Router();

// API key authentication middleware
const apiAuth = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }

    const keyData = await ApiKey.findOne({ apiKey, isActive: true });
    
    if (!keyData || (keyData.expiresAt && keyData.expiresAt < new Date())) {
        return res.status(401).json({ error: 'Invalid or expired API key' });
    }

    // Check permissions
    if (!keyData.permissions.includes('request_otp')) {
        return res.status(403).json({ error: 'Permission denied' });
    }

    // Update usage
    await ApiKey.updateOne(
        { keyId: keyData.keyId },
        { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } }
    );

    req.apiKey = keyData;
    next();
};

// Rate limit per API key
const apiRateLimit = async (req, res, next) => {
    // Implement per-key rate limiting here
    // Use Redis for distributed rate limiting
    next();
};

// Request OTP
router.post('/request', apiAuth, apiRateLimit, async (req, res) => {
    try {
        const { service, mode, country } = req.body;
        const userId = req.apiKey.userId;

        if (!service || !mode) {
            return res.status(400).json({ error: 'Service and mode required' });
        }

        const session = await sessionManager.createSession(
            userId,
            mode.toUpperCase(),
            service,
            country || 'US'
        );

        res.json({
            success: true,
            sessionId: session.sessionId,
            number: session.number,
            status: session.status,
            expiresAt: session.timeoutAt
        });

    } catch (error) {
        logger.error('API OTP request failed', { error: error.message });
        res.status(400).json({ error: error.message });
    }
});

// Check OTP status
router.get('/status/:sessionId', apiAuth, async (req, res) => {
    try {
        const { Session } = await import('../../models/index.js');
        const session = await Session.findOne({
            sessionId: req.params.sessionId,
            userId: req.apiKey.userId
        });

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json({
            success: true,
            sessionId: session.sessionId,
            status: session.status,
            otp: session.status === 'RECEIVED' ? session.maskedOtp : null,
            number: session.number,
            service: session.service,
            createdAt: session.startTime,
            completedAt: session.endTime
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;

