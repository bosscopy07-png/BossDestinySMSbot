 import { Router } from 'express';
import sessionManager from '../../services/otp/index.js';
import logger from '../../utils/logger.js';

const router = Router();

// Twilio webhook for incoming SMS
router.post('/twilio', express.urlencoded({ extended: false }), async (req, res) => {
    try {
        const { From, Body, MessageSid } = req.body;

        logger.info('Twilio webhook received', {
            from: From,
            messageSid: MessageSid
        });

        // Find session by number
        const { Session } = await import('../../models/index.js');
        const session = await Session.findOne({
            number: From,
            status: { $in: ['WAITING', 'CHECKING'] },
            provider: 'TWILIO'
        });

        if (session) {
            // Extract OTP from message
            const otpMatch = Body.match(/\b\d{4,8}\b/);
            if (otpMatch) {
                await sessionManager.deliverOTP(session, otpMatch[0]);
            }
        }

        res.status(200).send('<Response></Response>');

    } catch (error) {
        logger.error('Twilio webhook error', { error: error.message });
        res.status(200).send('<Response></Response>');
    }
});

// Vonage webhook for delivery status
router.post('/vonage', async (req, res) => {
    try {
        const { msisdn, to, messageId, status, err-code } = req.body;

        logger.info('Vonage webhook', { messageId, status, errCode: err-code });

        res.sendStatus(200);

    } catch (error) {
        logger.error('Vonage webhook error', { error: error.message });
        res.sendStatus(200);
    }
});

// Blockchain deposit webhook (if using external service)
router.post('/blockchain', async (req, res) => {
    try {
        const { address, txHash, amount, confirmations } = req.body;

        logger.info('Blockchain webhook', { address, txHash, amount, confirmations });

        // Find user by deposit address
        const { User } = await import('../../models/index.js');
        const user = await User.findOne({ depositAddress: address });

        if (user) {
            // Trigger deposit check
            const { default: WalletService } = await import('../../services/wallet/index.js');
            const walletService = new WalletService();
            await walletService.checkDeposit(user.userId);
        }

        res.sendStatus(200);

    } catch (error) {
        logger.error('Blockchain webhook error', { error: error.message });
        res.sendStatus(200);
    }
});

export default router;
