// bot/commands/otp/free.js — Free (ad-supported) mode: ads, credits, free service/country selection and polling
// Mixed into OTPCommands.prototype by bot/commands/otp.js (bodies unchanged: `this` is the OTPCommands instance).
import { getPricing, formatPrice } from '../../../utils/pricing.js';
import { Markup } from 'telegraf';
import { Session, User, Number as NumberModel, Transaction } from '../../../models/index.js';
import { COUNTRIES, SERVICES } from '../../../utils/constants.js';
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import { IMAGES } from './constants.js';

export const freeMethods = {
        // ═══════════════════════════════════════════════════════════════════════
//  FREE MODE — Check credits, show ad if needed, otherwise proceed
// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
//  FREE MODE — Check credits, show ad if needed, otherwise proceed
// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
//  FREE MODE — Check credits, show ad if needed, otherwise proceed
// ═══════════════════════════════════════════════════════════════════════
async handleFreeMode(ctx) {
    const user = ctx.state.user;
    const userId = String(ctx.from?.id);

    if (!user) {
        return ctx.reply('⚠️ Session expired. Please send /start to continue.', { parse_mode: 'HTML' });
    }

    // Check daily limit FIRST
    if (!this._canUseFree(user)) {
        return this._showFreeExhausted(ctx, user);
    }

    const freeProvider = this.smsProviderManager.getProvider('FREE_PUBLIC');

    // Check ad credits
    if (freeProvider && freeProvider.adSystem) {
        try {
            const creditCheck = await freeProvider.canRequestNumber(userId);

            // NO credits → MUST watch ad FIRST
            if (!creditCheck.allowed && creditCheck.reason === 'INSUFFICIENT_CREDITS') {
                return this._showAdPrompt(ctx, creditCheck, freeProvider, user);
            }

            // Any other block
            if (!creditCheck.allowed) {
                return this._showFreeExhausted(ctx, user);
            }

            // FIX: Don't hold credits here — hold them when number is requested
            // Just mark that user has sufficient credits
            ctx.session = ctx.session || {};
            ctx.session.freeCreditsAvailable = creditCheck.credits;
            ctx.session.freeCreditsDeducted = false; // Not deducted yet

        } catch (creditError) {
            logger.error('Ad credit check failed', { userId: userId, error: creditError.message });
            return this._showFreeExhausted(ctx, user);
        }
    }

    const remainingFree = this._freeRemaining(user);

    const warningMessage = [
        '⚠️ <b>Free Mode Notice</b>\n\n',
        '📵 Free numbers are <b>shared</b> and may be <b>blocked</b> by:\n',
        '• WhatsApp, Telegram, Google\n',
        '• Facebook, Instagram, Twitter\n',
        '• Banks, Binance, PayPal\n\n',
        '✅ You have <b>' + remainingFree + '</b> free OTPs left today\n\n',
        '💡 For <b>guaranteed</b> delivery, use:\n',
        '• 💰 CHEAP — Dynamic pricing\n',
        '• 📦 BUNDLE — Bulk savings\n',
        '• 👑 VIP — Unlimited access\n\n',
        '<i>Free mode is best effort only. No refunds for failed delivery.</i>'
    ].join('');

    const warningKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ I Understand, Proceed', 'confirm_free_mode')],
        [Markup.button.callback('💰 Switch to CHEAP', 'mode_cheap')],
        [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
        [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
        [Markup.button.callback('🔙 Back', 'menu')]
    ]);

    return this.sendPhotoWithCaption(ctx, IMAGES.freeMode, warningMessage, warningKeyboard, 'HTML');
},

// ═══════════════════════════════════════════════════════════════════════
//  FREE EXHAUSTED — Daily limit reached, NO ads allowed
// ═══════════════════════════════════════════════════════════════════════
async _showFreeExhausted(ctx, user) {
    // FIX 5: Remove ALL manual daily limit calculations
    // Use centralized helper for remaining count
    const remaining = this._freeRemaining(user);
    const isExhausted = remaining === 0 || remaining === '∞' ? false : remaining <= 0;

    // FIX 6: Use user's actual data instead of creditCheck fallbacks
    const dailyUsed = Number.isFinite(user?.freeUsedToday) ? user.freeUsedToday : 0;
    const dailyLimit = config.limits?.freeDaily || 3;

    const pricing = await getPricing();
    const formatted = formatPrice(pricing);

    const message = [
        '❌ <b>Free OTPs Used Up</b>\n\n',
        'You\'ve used ' + dailyUsed + '/' + dailyLimit + ' free OTPs today.\n\n',
        '⏳ <b>Come back tomorrow</b> for more free OTPs.\n\n',
        '💡 Upgrade for instant access:\n',
        '• 💰 CHEAP — ' + formatted.cheap + '\n',
        '• 📦 BUNDLE — ' + formatted.bundle + '\n',
        '• 👑 VIP — ' + formatted.vip
    ].join('');

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💰 Switch to CHEAP', 'mode_cheap')],
        [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
        [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
        [Markup.button.callback('🔙 Main Menu', 'menu')]
    ]);

    return this.sendPhotoWithCaption(ctx, IMAGES.freeMode, message, keyboard, 'HTML');
},

// ═══════════════════════════════════════════════════════════════════════
//  AD PROMPT — Force ad watch BEFORE any free OTP access
// ═══════════════════════════════════════════════════════════════════════
async _showAdPrompt(ctx, creditCheck, freeProvider, user) {
    // FIX 7: MUST verify user still has free requests before showing ads
    // If limit exhausted while ad prompt was pending, block immediately
    if (!this._canUseFree(user)) {
        return this._showFreeExhausted(ctx, user);
    }

    const pricing = await getPricing();
    const formatted = formatPrice(pricing);

    // FIX 8: Remove all manual dailyLimit/dailyUsed calculations
    // Use centralized helper for remaining count
    const remainingFree = this._freeRemaining(user);

    const shortfall = creditCheck.shortfall || (creditCheck.required - creditCheck.credits);
    const networks = freeProvider.getAvailableNetworks().filter(function(n) { return n.configured; });

    const minWatchTimeMs = (freeProvider.adSystem && freeProvider.adSystem.minWatchTime) ? freeProvider.adSystem.minWatchTime : 30000;
    const minWatchTimeSec = Math.floor(minWatchTimeMs / 1000);

    const message = [
        '🎁 <b>Watch Ad to Get Free OTP</b>\n\n',
        'Free OTPs remaining today: <b>' + remainingFree + '</b>\n\n',
        '📺 Watch 1 ad = <b>+2 credits</b>\n',
        '💳 1 credit = <b>1 free OTP</b>\n',
        '⏱ Required watch time: <b>' + minWatchTimeSec + ' seconds</b>\n\n',
        '<i>Watch the full ad to earn credits instantly.</i>\n\n',
        'Or upgrade for guaranteed delivery:\n',
        '• 💰 ' + formatted.cheap + '\n',
        '• 📦 ' + formatted.bundle
    ].join('');

    const buttons = networks.slice(0, 4).map(function(n) {
        return [
            Markup.button.callback(
                '📺 ' + n.name + ' (+' + n.creditValue + ' credits)',
                'watch_ad_' + n.id
            )
        ];
    });

    buttons.push(
        [Markup.button.callback('💰 Switch to CHEAP', 'mode_cheap')],
        [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
        [Markup.button.callback('🔙 Back', 'menu')]
    );

    return ctx.reply(message, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup
    });
},

// ═══════════════════════════════════════════════════════════════════════
//  CONFIRM FREE MODE — Just proceed to service selection, don't deduct credits
// ═══════════════════════════════════════════════════════════════════════
async handleConfirmFreeMode(ctx) {
    const userId = String(ctx.from.id);
    const user = ctx.state.user || await User.findOne({ userId: userId });

    ctx.session = ctx.session || {};
    ctx.session.otpMode = 'FREE';

    // Re-check daily limit
    if (!this._canUseFree(user)) {
        return this._showFreeExhausted(ctx, user);
    }

    // FIX: Don't commit any hold here — credits haven't been held yet
    // Just clear any stale session data
    delete ctx.session.freeHoldId;
    
    await ctx.editMessageCaption('⏳ <b>Loading Free Mode...</b>', { parse_mode: 'HTML' });
    return this._showLegacyServiceSelection(ctx, 'FREE', IMAGES.freeMode);
},

// ═══════════════════════════════════════════════════════════════════════
//  WATCH AD HANDLER — Generate ad, show tracked URL
// ═══════════════════════════════════════════════════════════════════════
async handleWatchAd(ctx, networkId) {
    const userId = String(ctx.from.id);
    const user = ctx.state.user || await User.findOne({ userId: userId });

    // FIX 10: Block ad watch if daily limit already exhausted
    // No point watching ads if no free requests remain
    if (!this._canUseFree(user)) {
        return ctx.answerCbQuery('❌ Free limit reached. No more free OTPs today.', { show_alert: true })
            .catch(function() {});
    }

    try {
        const freeProvider = this.smsProviderManager.getProvider('FREE_PUBLIC');
        if (!freeProvider || !freeProvider.adSystem) {
            return ctx.answerCbQuery('❌ Service unavailable').catch(function() {});
        }

        const adView = await freeProvider.adSystem.generateAdView(userId, networkId);

        if (!adView.success) {
            return ctx.answerCbQuery(adView.message || '❌ Ad unavailable').catch(function() {});
        }

        ctx.session = ctx.session || {};
        ctx.session.pendingAdVerification = adView.verificationId;

        const minWatchTimeSec = Math.floor((adView.minWatchTime || 30000) / 1000);

        const message = [
            '📺 <b>Watch Ad to Earn Credits</b>\n\n',
            'Reward: <b>+' + adView.creditValue + ' credits</b>\n',
            'Required watch time: <b>' + minWatchTimeSec + ' seconds</b>\n\n',
            '1️⃣ Click "📺 Open Ad" below\n',
            '2️⃣ Stay on the page for <b>' + minWatchTimeSec + ' seconds</b>\n',
            '3️⃣ Return and tap "✅ Check My Credits"\n\n',
            '<i>Do not close the ad before time is up or credits will not be awarded.</i>'
        ].join('');

        return ctx.editMessageText(message, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.url('📺 Open Ad', adView.adUrl)],
                [Markup.button.callback('✅ Check My Credits', 'check_credits')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]).reply_markup
        });

    } catch (error) {
        logger.error('handleWatchAd error', { userId: userId, error: error.message });
        return ctx.answerCbQuery('❌ Ad unavailable. Try another.').catch(function() {});
    }
},

// ═══════════════════════════════════════════════════════════════════════
//  CHECK CREDITS HANDLER — Claim after watching ad
// ═══════════════════════════════════════════════════════════════════════
async handleCheckCredits(ctx) {
    const userId = String(ctx.from.id);
    const user = ctx.state.user || await User.findOne({ userId: userId });

    try {
        const freeProvider = this.smsProviderManager.getProvider('FREE_PUBLIC');
        if (!freeProvider || !freeProvider.adSystem) {
            return ctx.answerCbQuery('❌ Service unavailable').catch(function() {});
        }

        const verificationId = ctx.session && ctx.session.pendingAdVerification ? ctx.session.pendingAdVerification : null;

        if (!verificationId) {
            return ctx.answerCbQuery(
                '❌ No active ad session. Please watch an ad first.',
                { show_alert: true }
            );
        }

        const claimResult = await freeProvider.adSystem.claimCredits(verificationId, userId, {
            userAgent: (ctx.callbackQuery && ctx.callbackQuery.from && ctx.callbackQuery.from.username) ? ctx.callbackQuery.from.username : 'unknown'
        });

        if (claimResult.success) {
            delete ctx.session.pendingAdVerification;
            delete ctx.session.adStartTime;

            // FIX 11: After successful ad claim, re-check if user still has free requests
            // If they exhausted limit while watching ad, show exhausted screen
            if (!this._canUseFree(user)) {
                await ctx.answerCbQuery('✅ Credits added, but free limit reached!');
                return this._showFreeExhausted(ctx, user);
            }

            await ctx.answerCbQuery('✅ Credits added!');

            return ctx.editMessageText(
                [
                    '✅ <b>Credits Added!</b>\n\n',
                    '💳 Credits earned: <code>+' + claimResult.creditsAdded + '</code>\n',
                    '💳 Total credits: <code>' + claimResult.totalCredits + '</code>\n',
                    '⏱ Watch time: ' + Math.floor(claimResult.watchDuration / 1000) + 's\n\n',
                    '✅ You can now request a free OTP!'
                ].join(''),
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('📱 Get Free OTP', 'mode_free')],
                        [Markup.button.callback('🔙 Menu', 'menu')]
                    ]).reply_markup
                }
            );

        } else if (claimResult.error === 'TIME_NOT_ELAPSED') {
            await ctx.answerCbQuery(
                '⏳ Wait ' + claimResult.remaining + 's more...',
                { show_alert: true }
            );

            const progress = Math.floor((claimResult.elapsed / claimResult.required) * 100);

            return ctx.editMessageText(
                [
                    '📺 <b>Watching Ad...</b>\n\n',
                    '⏳ Progress: <code>' + claimResult.elapsed + '/' + claimResult.required + 's</code> (' + progress + '%)\n',
                    '⏳ Remaining: <code>' + claimResult.remaining + 's</code>\n\n',
                    '<i>Keep the ad page open. Do not close it.</i>'
                ].join(''),
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Check Again', 'check_credits')],
                        [Markup.button.callback('🔙 Give Up', 'menu')]
                    ]).reply_markup
                }
            );

        } else if (claimResult.error === 'WATCH_NOT_STARTED') {
            return ctx.answerCbQuery(
                '❌ Please open the ad first by tapping "📺 Open Ad"',
                { show_alert: true }
            );

        } else {
            delete ctx.session.pendingAdVerification;

            await ctx.answerCbQuery(
                '❌ ' + (claimResult.message || 'Failed to claim credits'),
                { show_alert: true }
            );

            return ctx.editMessageText(
                [
                    '❌ <b>Ad Session Expired</b>\n\n',
                    'Please watch a new ad to earn credits.'
                ].join(''),
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('📺 Watch New Ad', 'mode_free')],
                        [Markup.button.callback('🔙 Menu', 'menu')]
                    ]).reply_markup
                }
            );
        }

    } catch (error) {
        logger.error('handleCheckCredits error', { userId: userId, error: error.message });
        return ctx.answerCbQuery('❌ Check failed').catch(function() {});
    }
},

// ═══════════════════════════════════════════════════════════════════════
//  FREE SERVICE SELECTED
// ═══════════════════════════════════════════════════════════════════════
async handleFreeServiceSelected(ctx) {
    const userId = String(ctx.from.id);
    const user = ctx.state.user || await User.findOne({ userId: userId });
    const serviceId = ctx.match && ctx.match[1] ? ctx.match[1] : null;

    try {
        await ctx.answerCbQuery().catch(function() {});

        ctx.session = ctx.session || {};
        ctx.session.selectedService = serviceId;
        ctx.session.otpMode = 'FREE';

        const serviceName = SERVICES[serviceId] || serviceId;

        const message = [
            '🆓 <b>Free Mode — Select Country</b>\n\n',
            'Service: <b>' + serviceName + '</b>\n\n',
            'Select a country for your free number:\n\n',
            '<i>Free numbers are shared and may be blocked by major services.</i>'
        ].join('');

        const countries = [
            { code: 'US', name: '🇺🇸 United States', flag: '🇺🇸' },
            { code: 'GB', name: '🇬🇧 United Kingdom', flag: '🇬🇧' },
            { code: 'CA', name: '🇨🇦 Canada', flag: '🇨🇦' },
            { code: 'AU', name: '🇦🇺 Australia', flag: '🇦🇺' },
            { code: 'DE', name: '🇩🇪 Germany', flag: '🇩🇪' },
            { code: 'FR', name: '🇫🇷 France', flag: '🇫🇷' },
            { code: 'IN', name: '🇮🇳 India', flag: '🇮🇳' },
            { code: 'NG', name: '🇳🇬 Nigeria', flag: '🇳🇬' },
            { code: 'BR', name: '🇧🇷 Brazil', flag: '🇧🇷' },
            { code: 'ZA', name: '🇿🇦 South Africa', flag: '🇿🇦' },
            { code: 'KE', name: '🇰🇪 Kenya', flag: '🇰🇪' },
            { code: 'GH', name: '🇬🇭 Ghana', flag: '🇬🇭' },
            { code: 'PH', name: '🇵🇭 Philippines', flag: '🇵🇭' },
            { code: 'ID', name: '🇮🇩 Indonesia', flag: '🇮🇩' },
            { code: 'PK', name: '🇵🇰 Pakistan', flag: '🇵🇰' },
            { code: 'BD', name: '🇧🇩 Bangladesh', flag: '🇧🇩' },
            { code: 'EG', name: '🇪🇬 Egypt', flag: '🇪🇬' },
            { code: 'MA', name: '🇲🇦 Morocco', flag: '🇲🇦' }
        ];

        const buttons = [];
        for (let i = 0; i < countries.length; i += 3) {
            const row = countries.slice(i, i + 3).map(function(c) {
                return Markup.button.callback(c.flag + ' ' + c.code, 'free_country_' + c.code + '_' + serviceId);
            });
            buttons.push(row);
        }

        buttons.push([Markup.button.callback('🔙 Back', 'confirm_free_mode')]);
        buttons.push([Markup.button.callback('🏠 Menu', 'menu')]);

        return this.sendPhotoWithCaption(ctx, IMAGES.freeMode || IMAGES.default, message, Markup.inlineKeyboard(buttons), 'HTML');

    } catch (error) {
        logger.error('handleFreeServiceSelected error', { userId: userId, serviceId: serviceId, error: error.message });
        return ctx.answerCbQuery('❌ Error').catch(function() {});
    }
},

// ═══════════════════════════════════════════════════════════════════════
//  FREE COUNTRY SELECTED — Hold credits HERE, then assign number
// ═══════════════════════════════════════════════════════════════════════
async handleFreeCountrySelected(ctx) {
    const userId = String(ctx.from.id);
    const countryCode = ctx.match && ctx.match[1] ? ctx.match[1] : null;
    const serviceId = ctx.match && ctx.match[2] ? ctx.match[2] : null;

    try {
        await ctx.answerCbQuery('⏳ Requesting free number...').catch(function() {});

        ctx.session = ctx.session || {};
        ctx.session.selectedCountry = countryCode;
        ctx.session.selectedService = serviceId;
        ctx.session.otpMode = 'FREE';

        const user = ctx.state.user || await User.findOne({ userId: userId });

        // HARD BLOCK 1: Daily limit
        if (!this._canUseFree(user)) {
            return this._showFreeExhausted(ctx, user);
        }

        const freeProvider = this.smsProviderManager.getProvider('FREE_PUBLIC');
        let holdId = null;

        // HARD BLOCK 2: Check and HOLD credits NOW (at number request time)
        if (freeProvider && freeProvider.adSystem) {
            const creditCheck = await freeProvider.canRequestNumber(userId);

            // NO credits → back to ad prompt
            if (!creditCheck.allowed && creditCheck.reason === 'INSUFFICIENT_CREDITS') {
                return this._showAdPrompt(ctx, creditCheck, freeProvider, user);
            }

            if (!creditCheck.allowed) {
                return this._showFreeExhausted(ctx, user);
            }

            // FIX: Hold credits NOW, right before getting the number
            holdId = await freeProvider.adSystem.holdCredits(userId);
        }

        try {
            const result = await this.smsProviderManager.getFreeNumber(countryCode, serviceId, userId);

            if (result && result.phoneNumber) {
                // Commit the credit hold
                if (holdId) {
                    await freeProvider.adSystem.commitHold(holdId);
                }

                // Increment free usage count — ONLY PLACE
                await User.updateOne({ userId: userId }, { $inc: { freeUsedToday: 1 } });

                const message = [
                    '📱 <b>Free Number Assigned</b>\n\n',
                    '📞 Number: <code>' + result.phoneNumber + '</code>\n',
                    '🌍 Country: ' + (result.country || countryCode) + '\n',
                    '🔢 Service: ' + serviceId + '\n\n',
                    '⏳ Waiting for OTP...\n',
                    '<i>Free numbers expire in 10 minutes.</i>'
                ].join('');

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Check OTP', 'check_free_' + result.sessionId)],
                    [Markup.button.callback('❌ Cancel', 'cancel_free_' + result.sessionId)],
                    [Markup.button.callback('🔙 Menu', 'menu')]
                ]);

                return this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

            } else {
                throw new Error(result && result.error ? result.error : 'Failed to get free number');
            }

        } catch (numberError) {
            // Release hold on failure
            if (holdId) {
                await freeProvider.adSystem.releaseHold(holdId).catch(function() {});
            }
            throw numberError;
        }

    } catch (error) {
        logger.error('handleFreeCountrySelected error', { userId: userId, countryCode: countryCode, serviceId: serviceId, error: error.message });
        await ctx.answerCbQuery('❌ Error').catch(function() {});

        const pricing = await getPricing();
        const formatted = formatPrice(pricing);

        const errorMessage = [
            '❌ <b>Free Number Error</b>\n\n',
            'Error: ' + error.message + '\n\n',
            'Try again or use CHEAP mode for guaranteed delivery.\n\n',
            '💰 CHEAP: ' + formatted.cheap
        ].join('');

        const errorKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Try Again', 'free_country_' + countryCode + '_' + serviceId)],
            [Markup.button.callback('💰 CHEAP Mode', 'mode_cheap')],
            [Markup.button.callback('🔙 Menu', 'menu')]
        ]);

        return this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, errorMessage, errorKeyboard, 'HTML');
    }
                                                                 },

       
// ═══════════════════════════════════════════════════════════════════════
//  FREE CHECK NOW — Manual poll for SMS
// ═══════════════════════════════════════════════════════════════════════
async handleCheckFree(ctx, sessionId) {
    try {
        // FIX: Use smsProviderManager.checkFreeSMS(), not freeProvider.checkFreeSMS()
        // The manager has the unified checkFreeSMS method, not the individual provider
        const result = await this.smsProviderManager.checkFreeSMS(sessionId);

        if (!result) {
            return ctx.answerCbQuery('❌ Session not found').catch(function() {});
        }

        if (result.success && result.otp) {
            await ctx.answerCbQuery('✅ OTP received! Updating...');
            
            // Update the message to show the OTP
            const message = [
                '📱 <b>Free Number — OTP Received!</b>\n\n',
                '🔢 OTP: <code>' + result.otp + '</code>\n\n',
                '⏳ This number has expired.'
            ].join('');

            await ctx.editMessageCaption(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Menu', 'menu')]
                ]).reply_markup
            });

        } else if (result.status === 'EXPIRED' || result.status === 'CANCELLED') {
            await ctx.answerCbQuery('❌ Session expired', { show_alert: true });
            
            await ctx.editMessageCaption('❌ <b>Session Expired</b>\n\nThe free number has expired. Please request a new one.', {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Get Free OTP', 'mode_free')],
                    [Markup.button.callback('🔙 Menu', 'menu')]
                ]).reply_markup
            });

        } else {
            await ctx.answerCbQuery('⏳ ' + (result.message || 'Still waiting...'));
        }

    } catch (error) {
        logger.error('handleCheckFree error', { sessionId: sessionId, error: error.message });
        return ctx.answerCbQuery('❌ Check failed').catch(function() {});
    }
},

                    
    
                    
        

    // ═══════════════════════════════════════════════════════════════════════
    //  FREE POLLING — Unified free OTP polling
    // ═══════════════════════════════════════════════════════════════════════

    

    
async startFreePolling(ctx, userId, freeSessionId, dbSessionId) {
        if (!this.smsProviderManager) {
            logger.error('startFreePolling: smsProviderManager not available', { userId, dbSessionId });
            return;
        }

        let pollMessageId = null;
        const startTime = Date.now();
        const maxDuration = 600000;
        const pollInterval = 5000;

        const updatePollMessage = async (text) => {
            try {
                if (pollMessageId) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        pollMessageId,
                        undefined,
                        text,
                        { parse_mode: 'HTML' }
                    );
                    return;
                }
                
                const sent = await ctx.reply(text, { parse_mode: 'HTML' });
                if (sent?.message_id) pollMessageId = sent.message_id;
            } catch (err) {
                // Silently ignore
            }
        };

        const deletePollMessage = async () => {
            if (pollMessageId) {
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, pollMessageId);
                    pollMessageId = null;
                } catch (err) {
                    // Ignore
                }
            }
        };

        const formatElapsed = (ms) => {
            const secs = Math.floor(ms / 1000);
            if (secs < 60) return `${secs}s`;
            const mins = Math.floor(secs / 60);
            const rem = secs % 60;
            return `${mins}m ${rem}s`;
        };

        try {
            await updatePollMessage(
                `⏳ <b>Waiting for SMS...</b>\n\n` +
                `Session: <code>${dbSessionId.slice(-8)}</code>\n` +
                `Elapsed: 0s\n` +
                `Timeout: 10m\n\n` +
                `<i>Checking every 5 seconds...</i>`
            );

            while (Date.now() - startTime < maxDuration) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));

                try {
                    const result = await this.smsProviderManager.checkFreeSMS(freeSessionId);

                    if (result.success && result.otp) {
                        await deletePollMessage();

                        await Session.updateOne(
                            { sessionId: dbSessionId },
                            {
                                $set: {
                                    status: 'RECEIVED',
                                    otpCode: result.otp,
                                    endTime: new Date(),
                                    fullText: result.fullText || null
                                }
                            }
                        );

                        await User.updateOne(
                            { userId },
                            { $inc: { totalOtps: 1, freeUsedToday: 1 } }
                        );

                        const message = 
                            `🔓 <b>OTP Received!</b>\n\n` +
                            `📱 Number: <code>${result.number || ctx.session?.number || 'N/A'}</code>\n` +
                            `🎯 Service: ${result.service || ctx.session?.service || 'N/A'}\n` +
                            `🔢 OTP: <code>${result.otp}</code>\n` +
                            `⏱ Delivery: ${formatElapsed(Date.now() - startTime)}\n\n` +
                            `⚠️ Do not share this code with anyone.`;

                        await this.bot.telegram.sendMessage(userId, message, {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('🔙 Back to Menu', 'menu')],
                                [Markup.button.callback('📱 Request Another', 'mode_free')]
                            ]).reply_markup
                        });

                        if (ctx.session) {
                            delete ctx.session.freeSessionId;
                            delete ctx.session.providerNumberId;
                            delete ctx.session.number;
                            delete ctx.session.service;
                            delete ctx.session.selectedService;
                            delete ctx.session.selectedCountry;
                            delete ctx.session.freeCreditsDeducted;
                        }

                        return;
                    }

                    if (result.status === 'EXPIRED' || result.status === 'CANCELLED') {
                        await deletePollMessage();

                        await Session.updateOne(
                            { sessionId: dbSessionId },
                            { $set: { status: result.status, endTime: new Date() } }
                        );

                        const message = 
                            `❌ <b>Session ${result.status}</b>\n\n` +
                            `The number is no longer active.\n\n` +
                            `You can request a new free OTP or try paid options:`;

                        await this.bot.telegram.sendMessage(userId, message, {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('🔄 Retry Free', 'mode_free')],
                                [Markup.button.callback('💰 Try CHEAP', 'mode_cheap')],
                                [Markup.button.callback('👑 Try VIP', 'buy_vip')],
                                [Markup.button.callback('🔙 Menu', 'menu')]
                            ]).reply_markup
                        });

                        if (ctx.session) {
                            delete ctx.session.freeSessionId;
                            delete ctx.session.providerNumberId;
                            delete ctx.session.number;
                            delete ctx.session.service;
                            delete ctx.session.selectedService;
                            delete ctx.session.selectedCountry;
                            delete ctx.session.freeCreditsDeducted;
                        }

                        return;
                    }

                    const elapsed = Date.now() - startTime;
                    const remaining = Math.max(0, maxDuration - elapsed);
                    
                    await updatePollMessage(
                        `⏳ <b>Waiting for SMS...</b>\n\n` +
                        `Session: <code>${dbSessionId.slice(-8)}</code>\n` +
                        `Elapsed: ${formatElapsed(elapsed)}\n` +
                        `Remaining: ${formatElapsed(remaining)}\n\n` +
                        `<i>Checking every 5 seconds...</i>`
                    );

                } catch (pollError) {
                    logger.error('Free poll iteration error', { 
                        userId, 
                        freeSessionId, 
                        error: pollError.message 
                    });
                }
            }

            await deletePollMessage();

            logger.info('Free tier timeout', { userId, sessionId: dbSessionId });

            try {
                await this.smsProviderManager.cancelNumber('FREE_PUBLIC', freeSessionId);
            } catch (e) {}

            await Session.updateOne(
                { sessionId: dbSessionId },
                { $set: { status: 'TIMEOUT', endTime: new Date() } }
            );

            const message = 
                `⏰ <b>Free OTP Timed Out</b>\n\n` +
                `No SMS received within 10 minutes.\n\n` +
                `💡 Try again or use paid options for better reliability:`;

            await this.bot.telegram.sendMessage(userId, message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Retry Free', 'mode_free')],
                    [Markup.button.callback('💰 Try CHEAP', 'mode_cheap')],
                    [Markup.button.callback('👑 Try VIP', 'buy_vip')],
                    [Markup.button.callback('🔙 Menu', 'menu')]
                ]).reply_markup
            });

            if (ctx.session) {
                delete ctx.session.freeSessionId;
                delete ctx.session.providerNumberId;
                delete ctx.session.number;
                delete ctx.session.service;
                delete ctx.session.selectedService;
                delete ctx.session.selectedCountry;
                delete ctx.session.freeCreditsDeducted;
            }

        } catch (error) {
            logger.error('Free polling failed', { userId, dbSessionId, error: error.message });
            await deletePollMessage();
        }
    }
};

export default freeMethods;
