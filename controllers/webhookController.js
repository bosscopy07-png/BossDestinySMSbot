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
            // Acknowledge immediately to prevent timeout retries
            res.status(200).json({ received: true });

            // Process asynchronously
            const result = await paymentService.handleWebhook(req.body, signature);
            
            logger.info('Webhook processed', { 
                reference: req.body?.data?.reference,
                result 
            });
        } catch (error) {
            logger.error('Webhook processing failed', { 
                error: error.message,
                reference: req.body?.data?.reference 
            });
            // Already responded with 200, just log the error
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
