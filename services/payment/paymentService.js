// ═══════════════════════════════════════════════════════════════════════════════
//  services/payment/paymentService.js — Paystack Payment Service
//  Handles: initialization, verification, webhook processing, idempotent crediting
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import crypto from 'crypto';
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';
import { User, Transaction } from '../../models/index.js';
import config from '../../config/env.js';
import { verifyHmacSha512 } from '../../utils/webhookSignature.js';
import logger from '../../utils/logger.js';
import exchangeRateService from './exchangeRate.service.js';
import { generateId } from '../../utils/helpers.js';

class PaymentService {
    constructor() {
        this.provider = config.payment?.provider || 'paystack';
        this.secretKey = config.payment?.paystackSecretKey;
        this.publicKey = config.payment?.paystackPublicKey;
        this.webhookSecret = config.payment?.paystackWebhookSecret;
        this.baseUrl = 'https://api.paystack.co';
        this.minDepositNgn = parseInt(config.payment?.minDepositNgn) || 500;
    }

    /**
     * Generate unique payment reference
     */
    _generateReference(userId) {
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        return `SWIFTSMS_NGN_${userId}_${timestamp}_${random}`;
    }

    /**
     * Generate unique payment ID
     */
    _generatePaymentId() {
        return `PAY_${generateId()}_${Date.now()}`;
    }

    /**
     * Validate Naira amount
     */
    _validateAmount(amountNgn) {
        const amount = parseFloat(amountNgn);
        if (isNaN(amount) || amount <= 0) {
            throw new Error('INVALID_AMOUNT');
        }
        if (amount < this.minDepositNgn) {
            throw new Error(`MINIMUM_DEPOSIT:${this.minDepositNgn}`);
        }
        if (amount > 10000000) {
            throw new Error('MAXIMUM_DEPOSIT_EXCEEDED');
        }
        return amount;
    }

    /**
     * Initialize Naira deposit
     */
    async createNairaDeposit(userId, amountNgn, email) {
        logger.info('Creating Naira deposit', { userId, amountNgn });

        // 1. Validate user
        const user = await User.findOne({ userId });
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }

        // 2. Validate amount
        const validatedAmount = this._validateAmount(amountNgn);

        // 3. Get exchange rate and calculate USD
        const { amountUsd, rate } = await exchangeRateService.ngnToUsd(validatedAmount);

        // 4. Generate unique reference
        const reference = this._generateReference(userId);
        const paymentId = this._generatePaymentId();

        // 5. Create PENDING payment record
        const payment = await Payment.create({
            paymentId,
            reference,
            userId,
            provider: this.provider.toUpperCase(),
            amountNaira: validatedAmount,
            amountUsd,
            exchangeRate: rate,
            status: 'PENDING',
            metadata: {
                email: email || `${userId}@swiftsms.user`,
                initiatedAt: new Date(),
                userEmail: user.email || null
            }
        });

        logger.info('Pending payment record created', { 
            paymentId, reference, amountNgn: validatedAmount, amountUsd, rate 
        });

        // 6. Initialize with provider
        const providerResponse = await this._initializeProviderPayment(payment, email);

        // 7. Update payment with provider data
        await Payment.updateOne(
            { paymentId },
            {
                $set: {
                    'metadata.providerResponse': providerResponse,
                    'metadata.authorizationUrl': providerResponse.authorization_url,
                    'metadata.accessCode': providerResponse.access_code,
                    updatedAt: new Date()
                }
            }
        );

        return {
            payment,
            authorizationUrl: providerResponse.authorization_url,
            accessCode: providerResponse.access_code,
            reference
        };
    }

    /**
     * Initialize payment with Paystack
     */
    async _initializeProviderPayment(payment, email) {
        try {
            const payload = {
                email: email || `${payment.userId}@swiftsms.user`,
                amount: payment.amountNaira * 100,
                reference: payment.reference,
                currency: 'NGN',
                callback_url: config.payment?.callbackUrl || `${config.app?.url}/webhooks/payment/callback`,
                metadata: {
                    userId: payment.userId,
                    paymentId: payment.paymentId,
                    amountUsd: payment.amountUsd,
                    exchangeRate: payment.exchangeRate,
                    custom_fields: [
                        {
                            display_name: "SwiftSMS User ID",
                            variable_name: "user_id",
                            value: payment.userId
                        },
                        {
                            display_name: "USD Equivalent",
                            variable_name: "usd_amount",
                            value: `$${payment.amountUsd}`
                        }
                    ]
                }
            };

            const response = await axios.post(
                `${this.baseUrl}/transaction/initialize`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${this.secretKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );

            if (!response.data.status) {
                throw new Error(`PAYSTACK_ERROR: ${response.data.message}`);
            }

            logger.info('Paystack initialization successful', { 
                reference: payment.reference,
                authUrl: response.data.data.authorization_url 
            });

            return response.data.data;
        } catch (error) {
            logger.error('Paystack initialization failed', { 
                reference: payment.reference,
                error: error.response?.data?.message || error.message 
            });

            await Payment.updateOne(
                { paymentId: payment.paymentId },
                { $set: { status: 'FAILED', 'metadata.failureReason': error.message } }
            );

            throw new Error(`PAYMENT_INIT_FAILED: ${error.message}`);
        }
    }

    /**
     * Verify payment with provider API
     */
    async verifyPayment(reference) {
        logger.info('Verifying payment with provider', { reference });

        try {
            const response = await axios.get(
                `${this.baseUrl}/transaction/verify/${reference}`,
                {
                    headers: {
                        Authorization: `Bearer ${this.secretKey}`
                    },
                    timeout: 30000
                }
            );

            if (!response.data.status) {
                throw new Error(`VERIFICATION_FAILED: ${response.data.message}`);
            }

            const data = response.data.data;
            logger.info('Payment verification response', { 
                reference, 
                status: data.status,
                amount: data.amount,
                currency: data.currency 
            });

            return {
                success: data.status === 'success',
                reference: data.reference,
                amountPaid: data.amount / 100,
                currency: data.currency,
                paidAt: data.paid_at,
                channel: data.channel,
                transactionId: data.id.toString(),
                metadata: data.metadata,
                gatewayResponse: data.gateway_response
            };
        } catch (error) {
            logger.error('Payment verification failed', { 
                reference, 
                error: error.response?.data?.message || error.message 
            });
            throw error;
        }
    }

    /**
     * Verify webhook signature against the RAW request body (Paystack signs the
     * exact bytes it sent; re-serialising parsed JSON can change the bytes and
     * cause valid webhooks to be rejected). Fails closed if no secret is set.
     */
    verifyWebhookSignature(rawBody, signature) {
        const secret = this.webhookSecret || this.secretKey;
        if (!secret) {
            logger.error('No Paystack secret configured; rejecting webhook');
            return false;
        }
        if (!signature || !rawBody) return false;

        const isValid = verifyHmacSha512(rawBody, signature, secret);
        if (!isValid) logger.warn('Webhook signature verification failed');
        return isValid;
    }

    /**
     * Process successful payment - IDEMPOTENT, no replica-set dependency.
     *
     * Safety model:
     *  1. Claim the payment (PENDING -> PROCESSING) atomically. A stale
     *     PROCESSING claim (crashed worker) can be re-claimed.
     *  2. Credit the wallet with ONE single-document update guarded by
     *     `processedPaymentRefs: { $ne: reference }`, so the credit can be
     *     applied at most once even if two workers race or a retry happens
     *     after a crash. This works on standalone MongoDB.
     *  3. Upsert the ledger Transaction by deterministic txId.
     *  4. Mark the payment SUCCESS.
     * On failure the payment stays PROCESSING (never silently reset), and the
     * reconciliation job retries it.
     */
    async processSuccessfulPayment(paymentData) {
        const { reference, providerTransactionId, amountPaid, paidAt } = paymentData;
        logger.info('Processing successful payment', { reference, providerTransactionId });

        const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
        const payment = await Payment.findOneAndUpdate(
            {
                reference,
                $or: [
                    { status: 'PENDING' },
                    { status: 'PROCESSING', 'metadata.processingAt': { $lt: staleBefore } }
                ]
            },
            {
                $set: {
                    status: 'PROCESSING',
                    providerTransactionId,
                    'metadata.processingAt': new Date(),
                    updatedAt: new Date()
                }
            },
            { new: true }
        );

        if (!payment) {
            const existing = await Payment.findOne({ reference });
            logger.info('Payment already processed, in progress or not found', {
                reference, status: existing?.status
            });
            return { alreadyProcessed: true, payment: existing || null };
        }

        try {
            // Credit what was actually paid (provider-verified), not blindly the quoted amount.
            const paidNgn = Number(amountPaid);
            let creditUsd = payment.amountUsd;
            if (Number.isFinite(paidNgn) && paidNgn > 0 && Math.abs(paidNgn - payment.amountNaira) > 1) {
                creditUsd = Math.round((paidNgn / payment.exchangeRate) * 10000) / 10000;
                logger.warn('Paid amount differs from quoted amount; crediting paid amount', {
                    reference, quoted: payment.amountNaira, paid: paidNgn, creditUsd
                });
            }
            if (!(creditUsd > 0)) throw new Error('INVALID_CREDIT_AMOUNT');

            // Single atomic, idempotent credit
            const credited = await User.updateOne(
                { userId: payment.userId, processedPaymentRefs: { $ne: reference } },
                {
                    $inc: { balance: creditUsd, totalDeposited: creditUsd },
                    $push: { processedPaymentRefs: { $each: [reference], $slice: -500 } }
                }
            );

            if (credited.matchedCount === 0) {
                const u = await User.findOne({ userId: payment.userId }).select('_id').lean();
                if (!u) throw new Error('USER_NOT_FOUND');
                logger.warn('Reference already credited; skipping duplicate credit', { reference });
            }

            await Transaction.updateOne(
                { txId: `NGN_DEP_${reference}` },
                {
                    $setOnInsert: {
                        txId: `NGN_DEP_${reference}`,
                        userId: payment.userId,
                        type: 'NAIRA_DEPOSIT',
                        amount: creditUsd,
                        currency: 'USD',
                        status: 'COMPLETED',
                        metadata: {
                            provider: payment.provider,
                            paymentReference: reference,
                            providerTransactionId,
                            amountNaira: payment.amountNaira,
                            exchangeRate: payment.exchangeRate,
                            amountUsd: creditUsd,
                            amountPaid,
                            paidAt: paidAt ? new Date(paidAt) : new Date(),
                            creditedNow: credited.matchedCount > 0,
                            source: 'automatic'
                        },
                        createdAt: new Date()
                    }
                },
                { upsert: true }
            );

            const done = await Payment.findOneAndUpdate(
                { reference },
                {
                    $set: {
                        status: 'SUCCESS',
                        paidAt: paidAt ? new Date(paidAt) : new Date(),
                        'metadata.amountPaid': amountPaid,
                        'metadata.creditedUsd': creditUsd,
                        'metadata.processedAt': new Date(),
                        updatedAt: new Date()
                    }
                },
                { new: true }
            );

            if (credited.matchedCount > 0) {
                try {
                    if (global.referralService) {
                        await global.referralService.processReferralDeposit(payment.userId, creditUsd);
                    }
                } catch (refError) {
                    logger.error('Referral processing failed (non-critical)', { userId: payment.userId, error: refError.message });
                }
                try {
                    if (global.notificationService) {
                        await global.notificationService.sendPaymentSuccess(payment.userId, done);
                    }
                } catch (notifError) {
                    logger.error('Notification failed (non-critical)', { userId: payment.userId, error: notifError.message });
                }
            }

            return { success: true, payment: done, alreadyCredited: credited.matchedCount === 0 };
        } catch (error) {
            logger.error('Payment processing failed; will be retried by reconciliation', {
                reference, error: error.message
            });
            await Payment.updateOne(
                { reference },
                { $set: { 'metadata.processError': error.message, 'metadata.processErrorAt': new Date() } }
            );
            throw error;
        }
    }

    /**
     * Reconcile payments that are still PENDING/PROCESSING by asking Paystack.
     * Called by cron so a missed/late webhook never needs a manual credit.
     */
    async reconcilePendingPayments({ minAgeMs = 60 * 1000, maxAgeHours = 24, limit = 50 } = {}) {
        const now = Date.now();
        const candidates = await Payment.find({
            status: { $in: ['PENDING', 'PROCESSING'] },
            createdAt: { $lt: new Date(now - minAgeMs), $gt: new Date(now - maxAgeHours * 3600 * 1000) }
        }).sort({ createdAt: 1 }).limit(limit);

        let credited = 0, failed = 0;
        for (const p of candidates) {
            try {
                const v = await this.verifyPayment(p.reference);
                if (v.success && v.currency === 'NGN') {
                    await this.processSuccessfulPayment({
                        reference: p.reference,
                        providerTransactionId: v.transactionId,
                        amountPaid: v.amountPaid,
                        paidAt: v.paidAt
                    });
                    credited++;
                }
            } catch (e) {
                failed++;
                logger.warn('Reconcile failed for payment', { reference: p.reference, error: e.message });
            }
        }
        if (candidates.length) logger.info('Payment reconciliation done', { checked: candidates.length, credited, failed });
        return { checked: candidates.length, credited, failed };
    }

    /**
     * Handle webhook event
     */
    async handleWebhook(payload, signature, rawBody) {
        // 1. Verify signature against raw bytes
        if (!this.verifyWebhookSignature(rawBody, signature)) {
            throw new Error('INVALID_SIGNATURE');
        }

        // 2. Validate event type
        if (payload.event !== 'charge.success') {
            logger.info('Ignoring non-success webhook event', { event: payload.event });
            return { ignored: true, event: payload.event };
        }

        const data = payload.data;
        const reference = data.reference;

        // 3. Verify directly with provider API (never trust webhook alone)
        const verification = await this.verifyPayment(reference);

        if (!verification.success) {
            logger.warn('Webhook received but provider verification failed', { reference });
            throw new Error('PROVIDER_VERIFICATION_FAILED');
        }

        // 4. Validate amount and currency
        const payment = await Payment.findOne({ reference });
        if (!payment) {
            logger.warn('Payment not found for webhook', { reference });
            throw new Error('PAYMENT_NOT_FOUND');
        }

        if (verification.currency !== 'NGN') {
            logger.warn('Invalid currency in webhook', { 
                reference, 
                expected: 'NGN', 
                received: verification.currency 
            });
            throw new Error('INVALID_CURRENCY');
        }

        // Allow small tolerance for amount (±1 NGN due to kobo rounding)
        const amountDiff = Math.abs(verification.amountPaid - payment.amountNaira);
        if (amountDiff > 1) {
            logger.warn('Amount mismatch', { 
                reference, 
                expected: payment.amountNaira, 
                received: verification.amountPaid 
            });
        }

        // 5. Process payment
        return await this.processSuccessfulPayment({
            reference,
            providerTransactionId: verification.transactionId,
            amountPaid: verification.amountPaid,
            paidAt: verification.paidAt
        });
    }

    /**
     * Check payment status manually
     */
    
    async checkPaymentStatus(reference) {
        logger.info('Manual payment status check', { reference });

        const payment = await Payment.findOne({ reference });
        if (!payment) {
            throw new Error('PAYMENT_NOT_FOUND');
        }

        if (payment.status !== 'PENDING') {
            return { status: payment.status, payment };
        }

        try {
            const verification = await this.verifyPayment(reference);

            if (verification.success) {
                const result = await this.processSuccessfulPayment({
                    reference,
                    providerTransactionId: verification.transactionId,
                    amountPaid: verification.amountPaid,
                    paidAt: verification.paidAt
                });
                return { status: 'SUCCESS', payment: result.payment };
            }

            return { status: 'PENDING', payment };
        } catch (error) {
            logger.error('Status check verification failed', { reference, error: error.message });
            return { status: payment.status, payment, error: error.message };
        }
    }

    /**
     * Get user's pending payment
     */
    async getPendingPayment(userId) {
        return await Payment.findOne({
            userId,
            status: 'PENDING',
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }).sort({ createdAt: -1 });
    }

    /**
     * Get payment history for user
     */
    async getPaymentHistory(userId, limit = 10) {
        return await Payment.find({ userId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
    }

    /**
     * Expire old pending payments
     */
    async expireOldPayments(maxAgeHours = 24) {
        const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
        
        const result = await Payment.updateMany(
            {
                status: 'PENDING',
                createdAt: { $lt: cutoff }
            },
            {
                $set: {
                    status: 'EXPIRED',
                    'metadata.expiredAt': new Date(),
                    updatedAt: new Date()
                }
            }
        );

        logger.info('Expired old payments', { count: result.modifiedCount });
        return result.modifiedCount;
    }
}

export default new PaymentService();
