//  — Ad network postback routes

import express from 'express';
import { SMSProviderManager } from '../services/sms/index.js';

const router = express.Router();

// Generic ad postback — used by most networks
// Format: GET /webhook/ad/ogads?subId=xxx&status=approved&payout=0.5
router.get('/ad/:network', async (req, res) => {
    try {
        const { network } = req.params;
        const providerManager = SMSProviderManager.getInstance(); // Or however you access it

        // Get FreeProvider's AdCreditSystem
        const freeProvider = providerManager.getProvider('FREE_PUBLIC');
        if (!freeProvider || !freeProvider.adSystem) {
            return res.status(500).send('ERROR');
        }

        const result = await freeProvider.adSystem.handlePostback(network, req.body, req.query);

        // Always return 200 to ad network, even on error (they retry otherwise)
        if (result.success) {
            return res.status(200).send('OK');
        } else {
            logger.warn('Ad postback processing failed', { error: result.error });
            return res.status(200).send('OK'); // Still 200 to stop retries
        }

    } catch (error) {
        logger.error('Ad postback route error', { error: error.message });
        res.status(200).send('OK'); // Always 200 for ad networks
    }
});

// Shorte.st / generic verification callback
// Format: GET /webhook/ad/:verificationId?status=completed
router.get('/ad/:verificationId', async (req, res) => {
    try {
        const { verificationId } = req.params;
        const { status, payout } = req.query;

        const providerManager = SMSProviderManager.getInstance();
        const freeProvider = providerManager.getProvider('FREE_PUBLIC');

        if (!freeProvider || !freeProvider.adSystem) {
            return res.redirect('/error?msg=system_not_ready');
        }

        // Process the verification
        const result = await freeProvider.adSystem.handlePostback('generic', null, {
            verify: verificationId,
            status,
            payout
        });

        // Redirect user back to bot with success/failure
        if (result.success) {
            return res.redirect(`/success?credits=${result.creditsAdded}`);
        } else {
            return res.redirect(`/error?msg=${encodeURIComponent(result.error)}`);
        }

    } catch (error) {
        logger.error('Verification callback error', { error: error.message });
        res.redirect('/error?msg=verification_failed');
    }
});

export default router;
