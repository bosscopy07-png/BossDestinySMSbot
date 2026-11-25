import paymentService from '../services/payment/paymentService.js';
import logger from '../utils/logger.js';

class WebhookController {
    /**
     * Handle Paystack webhook
     * POST /api/webhooks/payment
     */
    async handlePaymentWebhook(req, res) {
        const signature = req.headers['x-paystack-signature'];
        
        logger.info('Webhook received', { 
            event: req.body?.event,
            reference: req.body?.data?.reference,
            ip: req.ip 
        });

        try {
            // Verify BEFORE acknowledging: bad signature -> 401, processing
            // failure -> 500 so Paystack retries instead of the credit being lost.
            const result = await paymentService.handleWebhook(req.body, signature, req.rawBody);
            logger.info('Webhook processed', { reference: req.body?.data?.reference, result: { ...result, payment: undefined } });
            return res.status(200).json({ received: true });
        } catch (error) {
            logger.error('Webhook processing failed', { error: error.message, reference: req.body?.data?.reference });
            if (error.message === 'INVALID_SIGNATURE') return res.status(401).json({ error: 'invalid signature' });
            if (error.message === 'PAYMENT_NOT_FOUND') return res.status(200).json({ received: true, ignored: true });
            return res.status(500).json({ error: 'processing failed' });
        }
    }

    /**
     * Health check endpoint
     */
    async healthCheck(req, res) {
        res.status(200).json({ status: 'ok', service: 'webhook' });
    }
}

export default new WebhookController();
                
