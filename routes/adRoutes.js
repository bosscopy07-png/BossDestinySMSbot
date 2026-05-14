// 
import express from 'express';
import SMSProviderManager from '../services/SMSProviderManager.js';

const router = express.Router();
const providerManager = new SMSProviderManager();

router.get('/ad/redirect', async (req, res) => {
    const { subId, userId } = req.query;
    
    if (!subId || !userId) {
        return res.status(400).send('Invalid ad link');
    }

    const freeProvider = providerManager.getProvider('FREE_PUBLIC');
    if (!freeProvider?.adSystem) {
        return res.status(503).send('Service unavailable');
    }

    // Record that user actually opened the ad
    const result = freeProvider.adSystem.recordAdStart(subId, String(userId));
    
    if (!result.success) {
        console.warn('Ad redirect: recordAdStart failed', { subId, error: result.error });
    }

    // Find the actual ad URL from verification
    const verification = freeProvider.adSystem.activeVerifications.get(subId);
    const targetUrl = verification?.urlType === 'profitablecpm' 
        ? freeProvider.adSystem.FALLBACK_URL 
        : freeProvider.adSystem.PRIMARY_URL;

    res.redirect(targetUrl);
});

export default router;
