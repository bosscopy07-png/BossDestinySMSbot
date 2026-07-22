import { Markup } from 'telegraf';
import paymentService from './paymentService.js';
import exchangeRateService from './exchangeRate.service.js';
import { Payment } from '../../models/index.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

class NairaDepositHandler {
    constructor(bot) {
        this.bot = bot;
        this.minDepositNgn = parseInt(config.payment?.minDepositNgn) || 500;
        this.registerHandlers();
    }

    registerHandlers() {
        // Naira deposit flow callbacks
        this.bot.action('deposit_naira', this.handleNairaDepositStart.bind(this));
        this.bot.action('naira_confirm_amount', this.handleConfirmAmount.bind(this));
        this.bot.action('naira_cancel', this.handleCancelDeposit.bind(this));
        this.bot.action('naira_check_status', this.handleCheckStatus.bind(this));
        this.bot.action('naira_pay_now', this.handlePayNow.bind(this));
        
        // Text input handler for Naira amount
        this.bot.on('text', async (ctx, next) => {
            if (ctx.session?.awaitingNairaAmount) {
                delete ctx.session.awaitingNairaAmount;
                return this.handleAmountInput(ctx);
            }
            return next();
        });
    }

    /**
     * Show Naira deposit option from main deposit menu
     */
    async showDepositOptions(ctx) {
        const message =
            '💰 <b>Deposit Funds</b>\n\n' +
            'Choose a deposit method:\n\n' +
            '💵 <b>USDT BEP-20</b> — Crypto deposit with automatic confirmation\n' +
            '🇳🇬 <b>Naira (₦)</b> — Pay with card, bank transfer, or USSD';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('₮ USDT BEP-20', 'deposit_usdt')],
            [Markup.button.callback('🇳🇬 Naira (₦)', 'deposit_naira')],
            [Markup.button.callback('⬅️ Back', 'menu')]
        ]);

        try {
            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        } catch {
            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        }
    }

    /**
     * Start Naira deposit flow
     */
    async handleNairaDepositStart(ctx) {
        try {
            await ctx.answerCbQuery('🇳🇬 Naira Deposit');
            
            const message =
                '🇳🇬 <b>Naira Deposit</b>\n\n' +
                'Enter the amount you want to deposit in Naira.\n\n' +
                `Minimum deposit: <code>₦${this.minDepositNgn.toLocaleString()}</code>\n\n` +
                '<i>Send the amount as a number (e.g., 5000, 10000, 50000)</i>';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', 'naira_cancel')]
            ]);

            // Set session state
            ctx.session = ctx.session || {};
            ctx.session.awaitingNairaAmount = true;

            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        } catch (error) {
            logger.error('Naira deposit start error', { error: error.message });
            await ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    }

    /**
     * Handle amount input from user
     */
    async handleAmountInput(ctx) {
        const userId = ctx.from.id.toString();
        const text = ctx.message.text.trim().replace(/[^0-9]/g, '');
        const amountNgn = parseInt(text);

        // Validate
        if (isNaN(amountNgn) || amountNgn <= 0) {
            return ctx.reply(
                '❌ <b>Invalid amount.</b>\n\nPlease enter a valid number.\n\n' +
                `Minimum: <code>₦${this.minDepositNgn.toLocaleString()}</code>`,
                { parse_mode: 'HTML' }
            );
        }

        if (amountNgn < this.minDepositNgn) {
            return ctx.reply(
                `❌ <b>Amount too low.</b>\n\n` +
                `Minimum deposit is <code>₦${this.minDepositNgn.toLocaleString()}</code>.\n\n` +
                'Please enter a higher amount.',
                { parse_mode: 'HTML' }
            );
        }

        try {
            // Get exchange rate and calculate USD
            const { amountUsd, rate } = await exchangeRateService.ngnToUsd(amountNgn);

            // Store in session
            ctx.session.nairaDepositAmount = amountNgn;
            ctx.session.nairaDepositUsd = amountUsd;
            ctx.session.nairaExchangeRate = rate;

            const message =
                '🇳🇬 <b>Naira Deposit</b>\n\n' +
                `Amount: <code>₦${amountNgn.toLocaleString()}</code>\n` +
                `You will receive approximately: <code>$${amountUsd.toFixed(2)}</code>\n\n` +
                `Exchange rate: <code>₦${rate.toLocaleString()} = $1</code>\n\n` +
                '<i>The rate is locked for this transaction.</i>';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💳 Continue Payment', 'naira_confirm_amount')],
                [Markup.button.callback('❌ Cancel', 'naira_cancel')]
            ]);

            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });

        } catch (error) {
            logger.error('Amount calculation error', { userId, error: error.message });
            await ctx.reply(
                '❌ <b>Error calculating exchange rate.</b>\n\nPlease try again later.',
                { parse_mode: 'HTML' }
            );
        }
    }

    /**
     * Confirm amount and initialize payment
     */
    async handleConfirmAmount(ctx) {
        const userId = ctx.from.id.toString();
        const amountNgn = ctx.session?.nairaDepositAmount;

        if (!amountNgn) {
            await ctx.answerCbQuery('Session expired. Please start again.');
            return this.handleNairaDepositStart(ctx);
        }

        try {
            await ctx.answerCbQuery('Initializing payment...');

            // Get user's email or generate placeholder
            const user = await User.findOne({ userId }).lean();
            const email = user?.email || `${userId}@swiftsms.user`;

            // Initialize payment
            const result = await paymentService.createNairaDeposit(userId, amountNgn, email);

            // Store reference in session
            ctx.session.nairaPaymentReference = result.reference;

            const message =
                '💳 <b>Payment Created</b>\n\n' +
                `Amount: <code>₦${amountNgn.toLocaleString()}</code>\n` +
                `Expected credit: <code>$${result.payment.amountUsd.toFixed(2)}</code>\n` +
                `Reference: <code>${result.reference}</code>\n\n` +
                'Complete your payment using the button below.';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url('💳 Pay Now', result.authorizationUrl)],
                [Markup.button.callback('🔄 Check Payment Status', 'naira_check_status')],
                [Markup.button.callback('❌ Cancel', 'naira_cancel')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });

        } catch (error) {
            logger.error('Payment initialization error', { userId, error: error.message });
            
            let errorMsg = '❌ <b>Payment initialization failed.</b>';
            if (error.message.includes('MINIMUM_DEPOSIT')) {
                errorMsg += '\n\nAmount is below the minimum deposit.';
            } else if (error.message.includes('PAYSTACK_ERROR')) {
                errorMsg += '\n\nPayment provider error. Please try again.';
            }

            await ctx.editMessageText(errorMsg, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Try Again', 'deposit_naira')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]).reply_markup
            });
        }
    }

    /**
     * Handle "Pay Now" button click
     */
    async handlePayNow(ctx) {
        const reference = ctx.session?.nairaPaymentReference;
        if (!reference) {
            await ctx.answerCbQuery('No active payment found.');
            return;
        }

        const payment = await Payment.findOne({ reference }).lean();
        if (!payment || payment.status !== 'PENDING') {
            await ctx.answerCbQuery('Payment not found or already processed.');
            return;
        }

        await ctx.answerCbQuery('Opening payment...');
        // The URL button already handles this, but we can log it
        logger.info('User clicked Pay Now', { userId: ctx.from.id, reference });
    }

    /**
     * Check payment status
     */
    async handleCheckStatus(ctx) {
        const userId = ctx.from.id.toString();
        const reference = ctx.session?.nairaPaymentReference;

        if (!reference) {
            await ctx.answerCbQuery('No active payment found.');
            return ctx.reply(
                '❌ <b>No active payment found.</b>\n\nStart a new deposit.',
                { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🇳🇬 New Naira Deposit', 'deposit_naira')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]).reply_markup }
            );
        }

        try {
            await ctx.answerCbQuery('Checking status...');

            const result = await paymentService.checkPaymentStatus(reference);

            if (result.status === 'SUCCESS') {
                const message =
                    '✅ <b>Payment Successful!</b>\n\n' +
                    `Amount paid: <code>₦${result.payment.amountNaira.toLocaleString()}</code>\n` +
                    `Credited: <code>$${result.payment.amountUsd.toFixed(2)}</code>\n` +
                    `Reference: <code>${reference}</code>\n\n` +
                    'Your balance has been updated.';

                // Clear session
                delete ctx.session.nairaPaymentReference;
                delete ctx.session.nairaDepositAmount;
                delete ctx.session.nairaDepositUsd;

                await ctx.editMessageText(message, {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('💰 Check Balance', 'balance')],
                        [Markup.button.callback('🔙 Main Menu', 'menu')]
                    ]).reply_markup
                });

            } else if (result.status === 'PENDING') {
                const message =
                    '⏳ <b>Payment Pending</b>\n\n' +
                    `Reference: <code>${reference}</code>\n\n` +
                    'Your payment is still being processed.\n' +
                    'Please complete the payment or check again in a few minutes.';

                await ctx.editMessageText(message, {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Check Again', 'naira_check_status')],
                        [Markup.button.callback('❌ Cancel', 'naira_cancel')]
                    ]).reply_markup
                });

            } else if (result.status === 'FAILED') {
                const message =
                    '❌ <b>Payment Failed</b>\n\n' +
                    `Reference: <code>${reference}</code>\n\n` +
                    'The payment could not be completed.\n' +
                    'Please try again with a different method.';

                delete ctx.session.nairaPaymentReference;

                await ctx.editMessageText(message, {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'deposit_naira')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]).reply_markup
                });
            }

        } catch (error) {
            logger.error('Status check error', { userId, reference, error: error.message });
            await ctx.answerCbQuery('Check failed');
            await ctx.reply(
                '❌ <b>Error checking payment status.</b>\n\nPlease try again later.',
                { parse_mode: 'HTML' }
            );
        }
    }

    /**
     * Cancel deposit and clean up
     */
    async handleCancelDeposit(ctx) {
        const reference = ctx.session?.nairaPaymentReference;
        
        // Clean up session
        delete ctx.session.awaitingNairaAmount;
        delete ctx.session.nairaDepositAmount;
        delete ctx.session.nairaDepositUsd;
        delete ctx.session.nairaExchangeRate;
        delete ctx.session.nairaPaymentReference;

        try {
            await ctx.answerCbQuery('Cancelled');
            await ctx.editMessageText(
                '❌ <b>Deposit Cancelled</b>\n\nYour deposit has been cancelled.',
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('💳 Deposit', 'deposit')],
                        [Markup.button.callback('🔙 Main Menu', 'menu')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            logger.error('Cancel deposit error', { error: error.message });
        }
    }
}

export default NairaDepositHandler;
