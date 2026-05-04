// ═══════════════════════════════════════════════════════════════════════════════
// FreeNumberController.js — FREE Tier Integration Controller
// ═══════════════════════════════════════════════════════════════════════════════

import { Markup } from 'telegraf';
import FreeProvider from './FreeProvider.js';
import AdCreditSystem from './AdCreditSystem.js';
import logger from '../../utils/logger.js';

/**
 * FreeNumberController — Orchestrates FREE tier flow:
 * 1. Check credits / daily limit
 * 2. Show ad prompt if needed
 * 3. Get number from scraper
 * 4. Poll for real SMS
 * 5. Handle timeout/retry/upgrade prompt
 */
class FreeNumberController {
    constructor(bot) {
        this.bot = bot;
        this.provider = new FreeProvider();
        this.adSystem = new AdCreditSystem();

        this.COOLDOWN_MS = 60000; // 60s between free requests
        this.userLastRequest = new Map();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  MAIN FLOW: Handle "Get Free Number" request
    // ═══════════════════════════════════════════════════════════════════════

    async handleFreeRequest(ctx) {
        const userId = ctx.from.id.toString();
        const user = ctx.state.user;

        try {
            // 1. Check cooldown
            const lastRequest = this.userLastRequest.get(userId);
            if (lastRequest && Date.now() - lastRequest < this.COOLDOWN_MS) {
                const waitSec = Math.ceil((this.COOLDOWN_MS - (Date.now() - lastRequest)) / 1000);
                return ctx.reply(
                    `⏳ <b>Cooldown Active</b>\n\nPlease wait ${waitSec}s before another free request.`,
                    { parse_mode: 'HTML' }
                );
            }

            // 2. Check credits / daily limit
            const creditCheck = await this.adSystem.canRequestNumber(userId);

            if (!creditCheck.allowed && creditCheck.reason === 'DAILY_LIMIT_REACHED') {
                return this._sendDailyLimitMessage(ctx, creditCheck);
            }

            if (!creditCheck.allowed && creditCheck.reason === 'INSUFFICIENT_CREDITS') {
                return this._sendAdPrompt(ctx, creditCheck);
            }

            // 3. Deduct credits and proceed
            await this.adSystem.deductCredits(userId);
            this.userLastRequest.set(userId, Date.now());

            // 4. Get number from provider
            const numberData = await this.provider.getNumber(null, ctx.session?.otpService || 'Any');

            // 5. Send number to user with polling status
            const message =
                `✅ <b>Free Number Assigned</b>\n\n` +
                `📱 Number: <code>${numberData.phoneNumber}</code>\n` +
                `🌍 Country: ${this.provider._getFlag(numberData.country)} ${numberData.country}\n` +
                `🎯 Service: ${numberData.service}\n` +
                `⏳ Status: <b>Waiting for SMS...</b>\n\n` +
                `⚠️ <i>This is a public number. Anyone can see SMS.\n` +
                `Timeout: 90 seconds</i>`;

            const statusMsg = await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancel', `cancel_free_${numberData.sessionId}`)],
                    [Markup.button.callback('🔍 Check Now', `check_free_${numberData.sessionId}`)]
                ]).reply_markup
            });

            // 6. Start polling in background
            this._startPolling(ctx, userId, numberData.sessionId, statusMsg.message_id);

            return numberData;

        } catch (error) {
            logger.error('Free request failed', { userId, error: error.message });
            return ctx.reply(
                `❌ <b>Free Number Unavailable</b>\n\n${error.message}\n\n` +
                `💡 Try again later or upgrade to paid options.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('💰 CHEAP OTP', 'mode_cheap')],
                        [Markup.button.callback('👑 VIP', 'buy_vip')]
                    ]).reply_markup
                }
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  POLLING — Background SMS checking with live updates
    // ═══════════════════════════════════════════════════════════════════════

    async _startPolling(ctx, userId, sessionId, messageId) {
        let pollCount = 0;
        const startTime = Date.now();

        const poll = async () => {
            try {
                pollCount++;
                const result = await this.provider.checkSMS(sessionId);

                if (result.success) {
                    // OTP received!
                    const successMessage =
                        `🔓 <b>OTP Received!</b>\n\n` +
                        `📱 Number: <code>${result.number}</code>\n` +
                        `🔢 OTP: <code>${result.otp}</code>\n` +
                        `📤 From: ${result.sender || 'Unknown'}\n` +
                        `⏱ Delivery: ${result.deliveryTime || Date.now() - startTime}ms\n\n` +
                        `⚠️ Do not share this code with anyone.`;

                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        messageId,
                        undefined,
                        successMessage,
                        {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('📱 Request Another', 'mode_free')],
                                [Markup.button.callback('🔙 Menu', 'menu')]
                            ]).reply_markup
                        }
                    );
                    return;
                }

                // Check timeout
                if (Date.now() - startTime > 90000) {
                    await this._handleTimeout(ctx, userId, sessionId, messageId);
                    return;
                }

                // Update status
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const statusMessage =
                    `⏳ <b>Waiting for SMS...</b>\n\n` +
                    `📱 Number: <code>${result.number}</code>\n` +
                    `🔍 Poll: ${pollCount} | Elapsed: ${elapsed}s\n` +
                    `⏱ Timeout in: ${90 - elapsed}s\n\n` +
                    `<i>Checking inbox every 4 seconds...</i>`;

                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        messageId,
                        undefined,
                        statusMessage,
                        {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('❌ Cancel', `cancel_free_${sessionId}`)],
                                [Markup.button.callback('🔍 Check Now', `check_free_${sessionId}`)]
                            ]).reply_markup
                        }
                    );
                } catch (editErr) {
                    // Message might be too old to edit, ignore
                }

                // Schedule next poll
                setTimeout(poll, 4000);

            } catch (error) {
                logger.error('Polling error', { sessionId, error: error.message });
                setTimeout(poll, 4000);
            }
        };

        poll();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TIMEOUT HANDLER — Retry once, then suggest upgrade
    // ═══════════════════════════════════════════════════════════════════════

    async _handleTimeout(ctx, userId, sessionId, messageId) {
        try {
            // Try retry once
            const retryResult = await this.provider.retryWithNewNumber(sessionId);

            if (retryResult.success) {
                const retryMessage =
                    `🔄 <b>Retrying with New Number...</b>\n\n` +
                    `📱 New Number: <code>${retryResult.newNumber}</code>\n` +
                    `⏳ Starting fresh poll...\n\n` +
                    `<i>First attempt timed out. Trying once more.</i>`;

                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    messageId,
                    undefined,
                    retryMessage,
                    { parse_mode: 'HTML' }
                );

                // Start polling new session
                this._startPolling(ctx, userId, retryResult.newSessionId, messageId);
                return;
            }

            // Retry failed — final timeout
            await this.provider.releaseSession(sessionId);

            const failMessage =
                `⏰ <b>Free OTP Timed Out</b>\n\n` +
                `No SMS received after retry.\n\n` +
                `Possible reasons:\n` +
                `• Number was blocked by the service\n` +
                `• SMS delayed or not sent\n` +
                `• Public number overloaded\n\n` +
                `💡 <b>Upgrade for guaranteed delivery:</b>`;

            await ctx.telegram.editMessageText(
                ctx.chat.id,
                messageId,
                undefined,
                failMessage,
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('💰 CHEAP OTP ($0.05)', 'mode_cheap')],
                        [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
                        [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                        [Markup.button.callback('🔄 Try Free Again', 'mode_free')]
                    ]).reply_markup
                }
            );

        } catch (error) {
            logger.error('Timeout handling failed', { sessionId, error: error.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AD PROMPT — Show when user has insufficient credits
    // ═══════════════════════════════════════════════════════════════════════

    _sendAdPrompt(ctx, creditCheck) {
        const shortfall = creditCheck.shortfall;
        const networks = this.adSystem.getAvailableNetworks();

        let message =
            `🎁 <b>Free Number Available!</b>\n\n` +
            `💳 Credits needed: <code>${creditCheck.required}</code>\n` +
            `💳 Your credits: <code>${creditCheck.credits}</code>\n` +
            `❌ Shortfall: <code>${shortfall}</code>\n\n` +
            `Watch an ad to unlock:\n`;

        const buttons = networks.slice(0, 4).map(n => [
            Markup.button.callback(
                `📺 ${n.name} (+${n.creditValue} credit${n.creditValue > 1 ? 's' : ''})`,
                `watch_ad_${n.id}`
            )
        ]);

        buttons.push([Markup.button.callback('❌ Cancel', 'menu')]);

        return ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard(buttons).reply_markup
        });
    }

    _sendDailyLimitMessage(ctx, creditCheck) {
        return ctx.reply(
            `📛 <b>Daily Free Limit Reached</b>\n\n` +
            `You've used ${creditCheck.dailyUsed}/${creditCheck.dailyLimit} free requests today.\n` +
            `Resets at midnight UTC.\n\n` +
            `💡 Upgrade for unlimited access:`,
            {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('💰 CHEAP OTP', 'mode_cheap')],
                    [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
                    [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')]
                ]).reply_markup
            }
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AD VIEW HANDLER — User clicked "Watch Ad"
    // ═══════════════════════════════════════════════════════════════════════

    async handleWatchAd(ctx, networkId) {
        const userId = ctx.from.id.toString();

        try {
            const adView = await this.adSystem.generateAdView(userId, networkId);

            const message =
                `📺 <b>Watch Ad to Earn Credits</b>\n\n` +
                `Network: ${adView.network}\n` +
                `Type: ${adView.type}\n` +
                `Reward: +${adView.creditValue} credit${adView.creditValue > 1 ? 's' : ''}\n` +
                `Estimated time: ${adView.estimatedTime}\n\n` +
                `Click below to open the ad:`;

            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('📺 Open Ad', adView.adUrl)],
                    [Markup.button.callback('✅ I Watched It', `verify_ad_${adView.verificationId}`)],
                    [Markup.button.callback('❌ Cancel', 'menu')]
                ]).reply_markup
            });

        } catch (error) {
            logger.error('Ad generation failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Ad unavailable. Try another network.');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CANCEL HANDLER
    // ═══════════════════════════════════════════════════════════════════════

    async handleCancel(ctx, sessionId) {
        try {
            await this.provider.cancelNumber(sessionId);
            await ctx.answerCbQuery('✅ Session cancelled');
            await ctx.editMessageText(
                '❌ <b>Free Session Cancelled</b>\n\nCredits have been restored.',
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('📱 New Free Request', 'mode_free')],
                        [Markup.button.callback('🔙 Menu', 'menu')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            await ctx.answerCbQuery('❌ Cancel failed');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  STATS
    // ═══════════════════════════════════════════════════════════════════════

    getStats() {
        return {
            provider: this.provider.getStats(),
            adSystem: {
                pendingVerifications: this.adSystem.getPendingVerifications().length,
                networks: this.adSystem.getAvailableNetworks().length
            },
            cooldowns: this.userLastRequest.size
        };
    }
}

export default FreeNumberController;
                      
