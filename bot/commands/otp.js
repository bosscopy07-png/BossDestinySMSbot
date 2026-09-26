// ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 1: Imports, Setup, User Helpers, VIP & Deposit
//  INTEGRATED: Tier-based operator selection system for CHEAP mode
// ═══════════════════════════════════════════════════════════════════════════════


import { getPricing, formatPrice } from '../../utils/pricing.js';
import ServiceCatalog from '../../services/ServiceCatalog.js';
import TierOperatorSelector from '../../services/TierOperatorSelector.js';
import CountryCatalog from '../../services/CountryCatalog.js';
import { TIER_CONFIG } from '../../config/tierConfig.js';

import { Markup } from 'telegraf';
import { Session, User, Number as NumberModel, Transaction } from '../../models/index.js';
import { COUNTRIES, SERVICES } from '../../utils/constants.js';
import { formatCurrency, maskOTP } from '../../utils/helpers.js';
import sessionManager from '../../services/otp/index.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW TIER SYSTEM IMPORTS
// ═══════════════════════════════════════════════════════════════════════════════
const PROFIT_MARGIN = 0.00;
function applyProfitMargin(rawPrice) {
    if (rawPrice === null || rawPrice === undefined || isNaN(rawPrice)) return null;
    return parseFloat((rawPrice + PROFIT_MARGIN).toFixed(4));
                        }
       
// ─── Image Assets ─────────────────────────────────────────────────────────────
const IMAGES = {
    otpMenu: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231499/file_000000006c1c724685bb402218b7c208_ste2ky.png',
    vipFirst: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    vipOther: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231495/file_00000000800071f48dbbef2fbcc543fe_qgr5ch.png',
    bundleFirst: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231494/file_00000000733c7246bf7774567468638b_l64i5g.png',
    bundleOther: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231493/file_000000004c8c71f49757d61e50e41a4e_dyocuq.png',
    freeMode: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231492/file_00000000820072468452896492cba37c_rw0k7f.png',
    countrySelect: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000cad4720a8c06373a016e5150_mg6tx1.png',
    cheapMode: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231494/file_0000000040a871f4a09afb0846cf618e_jdiomc.png',
    otpRequested: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235811/file_00000000e318720a951c5e2e7a2588cf_yyva4e.png',
    otpReceived: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000621c71f4b75e0fc04a89d1c2_saojfi.png',
    otpFailed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235806/file_00000000621c71f4b75e0fc04a89d1c2_saojfi.png',
    default: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    depositConfirmed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235826/file_000000001c0c720aa51ae407e6741ca5_steie1.png',
    myNumber: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    banned: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    history: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231497/file_0000000034547246812a74392b500be0_gelms4.png',
    referral: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231496/file_00000000970071f4a9405256d1d028af_hjzc8o.png',
    stats: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231495/file_00000000800071f48dbbef2fbcc543fe_qgr5ch.png'
};

// ─── Inline Keyboards (Reusable) ──────────────────────────────────────────────
const KEYBOARDS = {
    backToMenu: () => Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Menu', 'menu')]
    ]),
    
    depositOrBack: () => Markup.inlineKeyboard([
        [Markup.button.callback('💳 Deposit', 'deposit')],
        [Markup.button.callback('🔙 Back', 'menu')]
    ]),
    
    supportOrRetry: () => Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'menu')],
        [Markup.button.callback('📞 Support', 'contact_support')]
    ]),
    
    otpActions: (sessionId) => Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Check OTP', `check_otp_${sessionId}`)],
        [Markup.button.callback('❌ Cancel', 'cancel_otp')]
    ])
};

// ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands Class
// ═══════════════════════════════════════════════════════════════════════════════

class OTPCommands {
    constructor(bot, walletService, sessionManager = null, smsProviderManager = null, tierIntegrationService = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.sessionManager = sessionManager;
        this.smsProviderManager = smsProviderManager;
        
        // ═════════════════════════════════════════════════════════════════
        //  Tier system integration (injected from TelegramBot)
        // ═════════════════════════════════════════════════════════════════
        this.tierService = null;
        this.tierSelector = null;
        this.serviceCatalog = null;
        this.countryCatalog = null;
        
        // Guard: check if tierIntegrationService is valid before using
        if (tierIntegrationService && typeof tierIntegrationService.isAvailable === 'function') {
            this.tierService = tierIntegrationService;
            this.tierSelector = tierIntegrationService._tierSelector;
            this.serviceCatalog = tierIntegrationService._serviceCatalog;
            this.countryCatalog = tierIntegrationService._countryCatalog;
            logger.info('OTPCommands: Tier system injected', {
                available: tierIntegrationService.isAvailable()
            });
        } else {
            if (tierIntegrationService) {
                logger.warn('OTPCommands: Invalid tierIntegrationService, using fallback', {
                    type: typeof tierIntegrationService,
                    hasIsAvailable: typeof tierIntegrationService?.isAvailable === 'function'
                });
            }
            // Legacy fallback: initialize tier components directly
            this._initTierSystem();
        }
        
        // Bind all handler methods to ensure `this` context
        this._bindAllHandlers();
        
        this.setupTextHandlers();
        
        this.registerCommands();
        
        if (this.walletService?.onDepositNotification) {
            this.walletService.onDepositNotification(this.handleDepositNotification.bind(this));
        }
    }

    // ─── Legacy Tier System Initialization (fallback) ───────────────────────
    _initTierSystem() {
        const cheapProvider = this.smsProviderManager?.getProvider('CHEAP_PANEL');
        
        if (!cheapProvider) {
            logger.warn('OTPCommands: No CHEAP_PANEL provider available, tier system disabled');
            this.serviceCatalog = null;
            this.tierSelector = null;
            this.countryCatalog = null;
            return;
        }
        
        // Guard: ServiceCatalog requires a provider
        try {
            this.serviceCatalog = new ServiceCatalog(cheapProvider);
            
            // Wrap single provider in array for TierOperatorSelector
            this.tierSelector = new TierOperatorSelector([cheapProvider]);
            
            this.countryCatalog = new CountryCatalog(cheapProvider, this.tierSelector);
            
            logger.info('OTPCommands: Tier system initialized internally', { 
                hasProvider: true,
                providerKey: cheapProvider.providerKey
            });
        } catch (error) {
            logger.error('OTPCommands: Failed to initialize tier system', { error: error.message });
            this.serviceCatalog = null;
            this.tierSelector = null;
            this.countryCatalog = null;
        }
    }
                


         
        // ─── Auto-bind all handler methods ─────────────────────────────────────
    _bindAllHandlers() {
        const handlerNames = [
            'handleOTPCommand', 'handleMyNumberCommand', 'handleCancel',
            'handleFreeMode', 'handleCheapMode', 'handleVIPMode', 'handleBundleMode',
            'handleViewMyNumber', 'handleRequestOtpVip', 'handleBuyBundleOtp',
            'handleBundleQuantity', 'handleBundleQuantityCustom', 'handleConfirmBundlePurchase',
            'handleServiceSelect', 'handleCountrySelect',
            'handleBuyBundle', 'handleConfirmFreeMode', 'handleBuyVIP', 'handleConfirmBundle',
            'handleConfirmVIP', 'handleRevealOTP', 'handleCheckOTP', 'handleCheckDeposit',
            'handleDepositInfo', 'handleMenu', 'handleContactSupport',
            'handleCancelVipSubscription', 'handleConfirmVipCancel',
            'handleHistory', 'handleReferral', 'handleStats', 'handleQuickBuy',
            'handleProviderStatus', 'handleSettings', 'handleToggleNotifications',
            'handleFaq', 'handleTerms',  'handleOTPHub',
            'handleWatchAd', 'handleCheckCredits', 'handleFreeServiceSelected',
            'handleFreeCountrySelected', 'handleCheckFree',
            // NEW: Tier system handlers
            'handleTierSelect', 'handleTierCountrySelect',
            'handleTierSearchService', 'handleTierSearchCountry',
            'handleTierServicePage', 'handleCopyOTP', 'hasService', 'handleTierCountryPage'
        ];
        
        for (const name of handlerNames) {
            if (typeof this[name] === 'function') {
                this[name] = this[name].bind(this);
            } else {
                logger.warn(`Handler method ${name} not found during binding`);
            }
        }
    }
    

    // ═══════════════════════════════════════════════════════════════════════
    //  USER HELPERS
    // ═══════════════════════════════════════════════════════════════════════
    
    _canUseFree(user) {
    if (!user || typeof user !== 'object') return false;

    if (user.isAdmin === true) return true;

    const limit = config.limits?.freeDaily || 3;

    const used = Number.isFinite(user.freeUsedToday)
        ? user.freeUsedToday
        : 0;

    // FIX 15: Add debug logging for every limit check
    logger.info('FREE LIMIT CHECK', {
        userId: user.userId,
        used: used,
        limit: limit,
        canUse: used < limit
    });

    return used < limit;
}

_freeRemaining(user) {
    if (!user || typeof user !== 'object') return 0;

    if (user.isAdmin === true) return '∞';

    const limit = config.limits?.freeDaily || 3;

    const used = Number.isFinite(user.freeUsedToday)
        ? user.freeUsedToday
        : 0;

    return Math.max(0, limit - used);
}
        
    _canUseVip(user) {
        if (!this._isVipActive(user)) return false;
        const limit = config.limits?.vipDaily || 50;
        return (user.vipDailyUsed || 0) < limit;
    }

    _isVipActive(user) {
        return !!(user.vipExpiry && new Date(user.vipExpiry) > new Date());
    }

    _getAvailableBalance(user) {
        return (user.balance || 0) - (user.lockedBalance || 0);
    }

    _vipRemaining(user) {
        const limit = config.limits?.vipDaily || 50;
        return Math.max(0, limit - (user.vipDailyUsed || 0));
    }

    _vipDaysLeft(user) {
        if (!user.vipExpiry) return 0;
        const diff = new Date(user.vipExpiry) - new Date();
        return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    _getUserStats(user) {
        return {
            balance: user.balance || 0,
            available: this._getAvailableBalance(user),
            vipDays: this._vipDaysLeft(user),
            vipRemaining: this._vipRemaining(user),
            freeRemaining: this._freeRemaining(user),
            bundleRemaining: user.bundleRemaining || 0,
            totalOtps: user.totalOtps || 0,
            isVip: this._isVipActive(user)
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  VIP NUMBER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    async assignVipNumber(userId, country = 'US', preferredProvider = null) {
        try {
            if (!this.smsProviderManager?.numberPool) {
                logger.warn('No number pool for VIP assignment', { userId });
                return null;
            }

            const assignment = await this.smsProviderManager.numberPool.acquireNumber(
                country, 'VIP_SUBSCRIPTION', userId, preferredProvider
            );

            await User.updateOne(
                { userId },
                {
                    $set: {
                        vipNumberId: assignment.numberId,
                        vipPhoneNumber: assignment.phoneNumber,
                        vipProvider: assignment.provider,
                        vipNumberAssignedAt: new Date(),
                        vipNumberCountry: country
                    }
                }
            );

            logger.info('VIP number assigned', {
                userId, phone: assignment.phoneNumber, provider: assignment.provider
            });

            return assignment;
        } catch (error) {
            logger.error('VIP number assignment failed', { userId, error: error.message });
            return null;
        }
    }

    async releaseVipNumber(userId) {
        try {
            const user = await User.findOne({ userId }).lean();
            if (!user?.vipNumberId) return { success: true, note: 'No VIP number assigned' };

            if (this.smsProviderManager?.numberPool) {
                await this.smsProviderManager.numberPool.releaseNumber(user.vipNumberId, 'VIP_EXPIRED');
            }

            await User.updateOne(
                { userId },
                {
                    $set: {
                        vipNumberId: null,
                        vipPhoneNumber: null,
                        vipProvider: null,
                        vipNumberAssignedAt: null,
                        vipNumberCountry: null
                    }
                }
            );

            logger.info('VIP number released', { userId, phone: user.vipPhoneNumber });
            return { success: true };
        } catch (error) {
            logger.error('VIP number release failed', { userId, error: error.message });
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  DEPOSIT NOTIFICATION
    // ═══════════════════════════════════════════════════════════════════════

    async handleDepositNotification(userId, data) {
        try {
            const message = 
                '✅ <b>Deposit Confirmed!</b>\n\n' +
                '💵 Amount Credited: <code>' + formatCurrency(data.amount) + '</code>\n' +
                (data.trackingFee > 0 ? '🔧 Tracking Fee: <code>' + formatCurrency(data.trackingFee) + '</code>\n' : '') +
                '🔗 TX Hash: <code>' + data.txHash + '</code>\n\n' +
                'Your balance has been updated. Use /otp to request OTPs!';

            await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });
        } catch (error) {
            logger.error('Deposit notification failed', { userId, error: error.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COMMAND REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════
    
registerCommands() {
    // ═════════════════════════════════════════════════════════════════
    //  SLASH COMMANDS
    // ═════════════════════════════════════════════════════════════════
    this.bot.command('otp', this.handleOTPCommand);
    this.bot.command('mynumber', this.handleMyNumberCommand);
    this.bot.command('cancel', this.handleCancel);
    this.bot.command('history', this.handleHistory);
    this.bot.command('referral', this.handleReferral);
    this.bot.command('stats', this.handleStats);
    this.bot.command('status', this.handleProviderStatus);
    this.bot.command('settings', this.handleSettings);
    this.bot.command('faq', this.handleFaq);
    
    // ═════════════════════════════════════════════════════════════════
    //  MODE SELECTION
    // ═════════════════════════════════════════════════════════════════
    this.bot.action('mode_free', this.handleFreeMode);
    this.bot.action('mode_cheap', this.handleCheapMode);
    this.bot.action('mode_vip', this.handleVIPMode);
    this.bot.action('mode_bundle', this.handleBundleMode);
    
    // ═════════════════════════════════════════════════════════════════
    //  MY NUMBER & VIP ACTIONS
    // ═════════════════════════════════════════════════════════════════
    this.bot.action('view_my_number', this.handleViewMyNumber);
    this.bot.action('request_otp_vip', this.handleRequestOtpVip);
    this.bot.action('buy_bundle_otp', this.handleBuyBundleOtp);
    
    // ═════════════════════════════════════════════════════════════════
    //  BUNDLE QUANTITY ACTIONS
    // ═════════════════════════════════════════════════════════════════
    this.bot.action('bundle_qty_5', (ctx) => this.handleBundleQuantity(ctx, 5));
    this.bot.action('bundle_qty_10', (ctx) => this.handleBundleQuantity(ctx, 10));
    this.bot.action('bundle_qty_25', (ctx) => this.handleBundleQuantity(ctx, 25));
    this.bot.action('bundle_qty_50', (ctx) => this.handleBundleQuantity(ctx, 50));
    this.bot.action('bundle_qty_custom', this.handleBundleQuantityCustom);
    this.bot.action('confirm_bundle_purchase', this.handleConfirmBundlePurchase);
    
    // ═════════════════════════════════════════════════════════════════
    //  SERVICE SELECTION — NEW TIER FLOW
    // ═════════════════════════════════════════════════════════════════
    
    // Service selection (user taps a service name)
    this.bot.action(/service_select_(.+)/, async (ctx) => {
        try {
            const serviceName = ctx.match[1];
            // FIXED: Store in session for search context
            ctx.session.otpService = serviceName;
            ctx.session.selectedService = serviceName;
            await this.handleServiceSelect(ctx, serviceName);
            await ctx.answerCbQuery('✅ Service selected');
        } catch (error) {
            logger.error('service_select action error', { 
                error: error.message, 
                userId: ctx.from?.id,
                match: ctx.match 
            });
            ctx.answerCbQuery('❌ Error selecting service').catch(() => {});
        }
    });
    
   // In OTPCommands.registerCommands() or wherever you register actions
this.bot.action(/copy_otp_(.+)/, async (ctx) => {
    await this.handleCopyOTP(ctx);
});
                                                                 
    // Service page navigation (Next/Prev)
    this.bot.action(/service_page_(\d+)/, async (ctx) => {
        try {
            await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode, null, parseInt(ctx.match[1]));
            await ctx.answerCbQuery(`Page ${ctx.match[1]}`);
        } catch (error) {
            logger.error('service_page action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    });

    // Browse all services
    this.bot.action('service_browse_all', async (ctx) => {
        try {
            await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode, null, 1);
            await ctx.answerCbQuery('📋 Showing all services');
        } catch (error) {
            logger.error('service_browse_all error', { error: error.message });
        }
    });

    // ═════════════════════════════════════════════════════════════════
    //  TIER SELECTION
    // ═════════════════════════════════════════════════════════════════
    this.bot.action(/tier_(budget|standard|premium)/, async (ctx) => {
        try {
            const tierKey = ctx.match[1];
            // FIXED: Store in session for search context
            ctx.session.selectedTier = tierKey;
            await this.handleTierSelect(ctx, tierKey);
        } catch (error) {
            logger.error('tier_select action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Error selecting tier').catch(() => {});
        }
    });

    // ═════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTION — NEW TIER FLOW
    // ═════════════════════════════════════════════════════════════════
    
    // Country selection (user taps a country)
    this.bot.action(/country_select_(.+)/, async (ctx) => {
        try {
            const countryCode = ctx.match[1];
            // FIXED: Store in session for search context
            ctx.session.selectedCountry = countryCode;
            await this.handleCountrySelect(ctx, countryCode);
        } catch (error) {
            logger.error('country_select action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Error selecting country').catch(() => {});
        }
    });

    // Country page navigation
    this.bot.action(/country_page_(\d+)/, async (ctx) => {
        try {
            await this.handleTierCountryPage(ctx, parseInt(ctx.match[1]));
        } catch (error) {
            logger.error('country_page action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    });

    // Tier country selection (direct from tier flow)
    this.bot.action(/tier_country_(.+)/, async (ctx) => {
        try {
            await this.handleTierCountrySelect(ctx, ctx.match[1]);
        } catch (error) {
            logger.error('tier_country action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Error selecting country').catch(() => {});
        }
    });
    // Tier fallback operator
    this.bot.action(/tier_fallback_(.+)/, async (ctx) => {
        try {
            const operator = ctx.match[1];
            const country = ctx.session?.selectedCountry;
            const service = ctx.session?.otpService;
            const tierKey = ctx.session?.selectedTier;
            
            if (!country || !service || !tierKey) {
                return ctx.answerCbQuery('❌ Session expired', { show_alert: true });
            }
            
            // Store fallback operator in session
            ctx.session.fallbackOperator = operator;
            
            // FIXED: Call handleTierCountrySelect which will use the fallback operator
            await this.handleTierCountrySelect(ctx, country);
        } catch (error) {
            logger.error('tier_fallback action error', { error: error.message });
            ctx.answerCbQuery('❌ Error').catch(() => {});
        }
    });
    
    
    // Back buttons
    this.bot.action('tier_back_service', async (ctx) => {
        try {
            await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode);
            await ctx.answerCbQuery('🔙 Back to services');
        } catch (error) {
            logger.error('tier_back_service error', { error: error.message });
        }
    });

    this.bot.action('tier_back_tier', async (ctx) => {
        try {
            const service = ctx.session?.otpService;
            if (service) {
                await this.showTierSelection(ctx, service);
            } else {
                await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode);
            }
            await ctx.answerCbQuery('🔙 Back to tiers');
        } catch (error) {
            logger.error('tier_back_tier error', { error: error.message });
        }
    });

    // ═════════════════════════════════════════════════════════════════
    //  PURCHASE CONFIRMATIONS
    // ═════════════════════════════════════════════════════════════════
    this.bot.action('buy_bundle', this.handleBuyBundle);
    this.bot.action('confirm_free_mode', this.handleConfirmFreeMode);
    this.bot.action('buy_vip', this.handleBuyVIP);
    this.bot.action('confirm_bundle', this.handleConfirmBundle);
    this.bot.action('confirm_vip', this.handleConfirmVIP);
    
    // ═════════════════════════════════════════════════════════════════
    //  OTP HUB & ACTIONS
    // ═════════════════════════════════════════════════════════════════
    this.bot.action('otp_hub', this.handleOTPHub);
    this.bot.action(/reveal_(.+)/, this.handleRevealOTP);
    this.bot.action(/check_otp_(.+)/, this.handleCheckOTP);
    this.bot.action('check_deposit', this.handleCheckDeposit);
    this.bot.action('cancel_otp', (ctx) => this.handleCancel(ctx));
    this.bot.action('deposit', this.handleDepositInfo);
    this.bot.action('menu', this.handleMenu);
    this.bot.action('contact_support', this.handleContactSupport);
    this.bot.action('cancel_vip_subscription', this.handleCancelVipSubscription);
    this.bot.action('confirm_vip_cancel', this.handleConfirmVipCancel);
            // In registerCommands() or constructor, add
    this.bot.action(/free_service_(.+)/, this.handleFreeServiceSelected.bind(this));
    this.bot.action(/free_country_([A-Z]{2})_(.+)/, this.handleFreeCountrySelected.bind(this));
    
    // ═════════════════════════════════════════════════════════════════
    //  UTILITY ACTIONS
    // ═════════════════════════════════════════════════════════════════
    this.bot.action('history', this.handleHistory);
    this.bot.action('referral', this.handleReferral);
    this.bot.action('stats', this.handleStats);
    this.bot.action('quick_buy', this.handleQuickBuy);
    this.bot.action('provider_status', this.handleProviderStatus);
    this.bot.action('settings', this.handleSettings);
    this.bot.action('toggle_notifications', this.handleToggleNotifications);
    this.bot.action('faq', this.handleFaq);
    this.bot.action('terms', this.handleTerms);
    
    // ═════════════════════════════════════════════════════════════════
    //  FREE MODE ACTIONS (Legacy)
    // ═════════════════════════════════════════════════════════════════

    this.bot.action(/cancel_free_(.+)/, async (ctx) => {
        try {
            await this.handleCancel(ctx);
        } catch (error) {
            logger.error('cancel_free action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Cancel failed').catch(() => {});
        }
    });

    this.bot.action(/check_free_(.+)/, async (ctx) => {
        try {
            await this.handleCheckFree(ctx, ctx.match[1]);
        } catch (error) {
            logger.error('check_free action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Check failed').catch(() => {});
        }
    });

    // ═════════════════════════════════════════════════════════════════
    //  AD CREDIT SYSTEM ACTIONS
    // ═════════════════════════════════════════════════════════════════
    this.bot.action(/watch_ad_(.+)/, async (ctx) => {
        try {
            await this.handleWatchAd(ctx, ctx.match[1]);
        } catch (error) {
            logger.error('watch_ad action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Error loading ad').catch(() => {});
        }
    });

    this.bot.action('check_credits', async (ctx) => {
        try {
            await this.handleCheckCredits(ctx);
        } catch (error) {
            logger.error('check_credits action error', { error: error.message, userId: ctx.from?.id });
            ctx.answerCbQuery('❌ Error checking credits').catch(() => {});
        }
    });

    // ═════════════════════════════════════════════════════════════════
    //  SEARCH PROMPTS — ONLY REGISTERED HERE (removed from setupSearchHandlers)
    // ═════════════════════════════════════════════════════════════════
    this.bot.action('service_search_prompt', async (ctx) => {
        try {
            ctx.session.awaitingServiceSearch = true;
            ctx.session.awaitingCountrySearch = false;
            await ctx.reply('🔍 <b>Search for a service:</b>\n\nType the service name (e.g., "WhatsApp", "Telegram", "Netflix"):', {
                parse_mode: 'HTML',
                reply_markup: { force_reply: true, selective: true }
            });
            await ctx.answerCbQuery('🔍 Type service name');
        } catch (error) {
            logger.error('service_search_prompt error', { error: error.message });
        }
    });

    this.bot.action('country_search_prompt', async (ctx) => {
        try {
            ctx.session.awaitingCountrySearch = true;
            ctx.session.awaitingServiceSearch = false;
            await ctx.reply('🔍 <b>Search for a country:</b>\n\nType country name or ISO code (e.g., "USA", "United Kingdom", "Germany"):', {
                parse_mode: 'HTML',
                reply_markup: { force_reply: true, selective: true }
            });
            await ctx.answerCbQuery('🔍 Type country name');
        } catch (error) {
            logger.error('country_search_prompt error', { error: error.message });
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════
//  SEARCH TEXT HANDLER — SINGLE INSTANCE, CALLED IN CONSTRUCTOR
// ═══════════════════════════════════════════════════════════════════════
setupTextHandlers() {
    // CRITICAL FIX: Handle force reply text messages
    this.bot.on('text', async (ctx, next) => {
        // Skip commands
        if (ctx.message.text.startsWith('/')) return next();
        
        // Handle service search
  if (ctx.session?.awaitingServiceSearch) {
    ctx.session.awaitingServiceSearch = false;
    const query = ctx.message.text.trim();
    
    if (!query) {
        await ctx.reply('❌ Please enter a valid service name.');
        return;
    }

    try {
        const results = await this.tierIntegration?.searchServices(query, 30) 
            ?? await this.serviceCatalog?.searchServices(query, 30) 
            ?? [];
        
                if (!results || results.length === 0) {
                    await ctx.reply(`❌ No services found matching "${query}".\n\nTry: WhatsApp, Telegram, Facebook, Instagram, TikTok, etc.`, {
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔍 Search Again', 'service_search_prompt')],
                            [Markup.button.callback('🔙 Back to Menu', 'menu')]
                        ]).reply_markup
                    });
                    return;
                }

                // Show search results as inline keyboard
                const buttons = results.slice(0, 15).map(s => [
                    Markup.button.callback(
                        `${s.emoji || '📱'} ${s.name}`,
                        `service_select_${s.name}`
                    )
                ]);
                
                buttons.push([Markup.button.callback('🔍 Search Again', 'service_search_prompt')]);
                buttons.push([Markup.button.callback('🔙 Back to Menu', 'menu')]);

                await ctx.reply(
                    `🔍 <b>Search Results for "${query}"</b>\n\nFound ${results.length} services:\n<i>Select one:</i>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard(buttons).reply_markup
                    }
                );

            } catch (error) {
                logger.error('Service search failed', { query, error: error.message });
                await ctx.reply('❌ Search failed. Please try again.', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔍 Try Again', 'service_search_prompt')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]).reply_markup
                });
            }
            return;
        }

        // Handle country search
        if (ctx.session?.awaitingCountrySearch) {
            ctx.session.awaitingCountrySearch = false;
            const query = ctx.message.text.trim();
            
            if (!query) {
                await ctx.reply('❌ Please enter a valid country name or code.');
                return;
            }

            try {
                // Get current context from session
                const currentService = ctx.session.otpService || ctx.session.selectedService;
                const currentTier = ctx.session.selectedTier;

                if (!currentService || !currentTier) {
                    await ctx.reply('❌ Please select a service and tier first before searching for countries.', {
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('📱 Select Service', 'mode_cheap')],
                            [Markup.button.callback('🔙 Main Menu', 'menu')]
                        ]).reply_markup
                    });
                    return;
                }

                // Show loading
                const loadingMsg = await ctx.reply(`🔍 Searching countries for "${query}"...`);

                // Call country catalog search
                const result = await this.countryCatalog.getCountriesForService(
                    currentService,
                    currentTier,
                    {
                        page: 1,
                        perPage: 20,
                        searchQuery: query,
                        topOnly: false
                    }
                );

                // Delete loading message
                try {
                    await ctx.deleteMessage(loadingMsg.message_id);
                } catch (e) {}

                if (!result.countries || result.countries.length === 0) {
                    await ctx.reply(
                        `❌ No countries found matching "${query}" for ${currentService}.\n\nTry searching by ISO code (e.g., "US", "UK") or full country name.`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('🔍 Search Again', 'country_search_prompt')],
                                [Markup.button.callback('🔙 Back to Tiers', 'tier_back_tier')],
                                [Markup.button.callback('🔙 Main Menu', 'menu')]
                            ]).reply_markup
                        }
                    );
                    return;
                }

                // Build results message
                const tierInfo = this.tierSelector.getTierInfo(currentTier);
                let message = 
                    `🌍 <b>Search Results: "${query}"</b>\n` +
                    `📱 ${currentService} | ${tierInfo.emoji} ${tierInfo.label}\n\n` +
                    `Found ${result.countries.length} countries:\n\n`;

                const buttons = [];
                const COLUMNS = 3;

                for (let i = 0; i < result.countries.length; i += COLUMNS) {
                    const row = result.countries.slice(i, i + COLUMNS).map(country => {
                        const flag = country.flag || isoToFlag(country.code);
                        // FIXED: Apply profit margin to display price
                        const rawPrice = country.displayPrice || country.price;
                        const displayPrice = rawPrice ? applyProfitMargin(rawPrice) : null;
                        const priceText = displayPrice 
                            ? ` $${displayPrice.toFixed(2)}`
                            : '';
                        const stockText = country.stock > 0 ? ` ✅` : ' ❌';
                        
                        return Markup.button.callback(
                            `${flag} ${country.code}${priceText}${stockText}`,
                            `country_select_${country.code}`
                        );
                    });
                    buttons.push(row);
                }

                buttons.push([Markup.button.callback('🔍 New Search', 'country_search_prompt')]);
                buttons.push([Markup.button.callback('🔙 Back to Tiers', 'tier_back_tier')]);
                buttons.push([Markup.button.callback('🔙 Main Menu', 'menu')]);

                await ctx.reply(message, {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard(buttons).reply_markup
                });

            } catch (error) {
                logger.error('Country search failed', { query, error: error.message });
                await ctx.reply('❌ Country search failed. Please try again.', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔍 Try Again', 'country_search_prompt')],
                        [Markup.button.callback('🔙 Back', 'tier_back_tier')]
                    ]).reply_markup
                });
            }
            return;
        }

        // Not a search reply, pass to next handler
        return next();
    });
}      
    
    // ═══════════════════════════════════════════════════════════════════════
    //  UTILITY METHODS
    // ═══════════════════════════════════════════════════════════════════════

    async sendPhotoWithCaption(ctx, imageUrl, caption, keyboard = null, parseMode = 'HTML') {
        try {
            const payload = { caption: caption.trim(), parse_mode: parseMode };
            if (keyboard) payload.reply_markup = keyboard.reply_markup;
            return await ctx.replyWithPhoto(imageUrl, payload);
        } catch (error) {
            logger.error('Photo send failed', { error: error.message });
            return keyboard
                ? ctx.reply(caption, { parse_mode: parseMode, ...keyboard })
                : ctx.reply(caption, { parse_mode: parseMode });
        }
    }
    /**
     * Safely delete a message, ignoring errors.
     * @private
     */
    async _safeDeleteMessage(ctx, message) {
        if (!message?.message_id) return;
        try {
            await ctx.deleteMessage(message.message_id);
        } catch (err) {
            logger.debug('Failed to delete message', { error: err.message, messageId: message.message_id });
        }
    }
        
    async editOrSendPhoto(ctx, imageUrl, caption, keyboard = null, parseMode = 'HTML') {
        try {
            if (ctx.callbackQuery?.message?.photo) {
                await ctx.editMessageMedia(
                    { type: 'photo', media: imageUrl, caption: caption.trim(), parse_mode: parseMode },
                    { reply_markup: keyboard?.reply_markup }
                );
                return;
            }
            if (ctx.callbackQuery?.message) {
                await ctx.editMessageCaption(caption, {
                    parse_mode: parseMode,
                    reply_markup: keyboard?.reply_markup
                });
                return;
            }
        } catch (editError) {
            // Fallback to sending new message
        }
        return this.sendPhotoWithCaption(ctx, imageUrl, caption, keyboard, parseMode);
    }

    escapeTelegramText(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\*/g, '\\*')
            .replace(/_/g, '\\_')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/`/g, '\\`');
    }

    formatPollStatus(status) {
        if (status.status === 'POLLING') {
            return `⏳ *Checking inbox...*\n(${status.message || '...'})`;
        }
        if (status.status === 'RECEIVED') {
            return `🔍 *SMS detected! Processing...*`;
        }
        return `⚠️ ${this.escapeTelegramText(status.message || status.error || '...')}`;
    }

 
    async sendPollUpdate(ctx, status) {
        const message = this.formatPollStatus(status);
        try {
            if (ctx.session?.pollMessageId) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        ctx.session.pollMessageId,
                        undefined,
                        message,
                        { parse_mode: 'Markdown' }
                    );
                    return;
                } catch (editError) {
                    // Message too old or can't edit, fall through
                }
            }
            const sent = await ctx.reply(message, { parse_mode: 'Markdown' });
            if (sent?.message_id) {
                ctx.session = ctx.session || {};
                ctx.session.pollMessageId = sent.message_id;
            }
        } catch (error) {
            logger.debug('Poll update failed', { error: error.message });
        }
    }
    
    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SESSION MANAGEMENT HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    async _getActiveSession(userId) {
        return Session.findOne({ 
            userId, 
            status: { $in: ['WAITING', 'CHECKING', 'RECEIVED'] } 
        }).sort({ createdAt: -1 });
    }

    async _scheduleTimeoutNotification(userId, sessionId, originalMessageId, timeoutAt) {
        try {
            const delayMs = new Date(timeoutAt) - new Date();
            if (delayMs <= 0) return;

            if (!this._timeoutTimers) this._timeoutTimers = new Map();
            
            if (this._timeoutTimers.has(sessionId)) {
                clearTimeout(this._timeoutTimers.get(sessionId));
            }

            const timer = setTimeout(async () => {
                this._timeoutTimers?.delete(sessionId);

                logger.info('Timeout fired, calling SessionManager.handleTimeout', { sessionId, userId });

                try {
                    const result = await sessionManager.handleTimeout(sessionId);

                    if (!result) {
                        logger.info('Timeout: session already handled by SessionManager', { sessionId });
                        return;
                    }

                    const timeoutMessage =
                        `⏰ <b>OTP Request Timed Out</b>\n\n` +
                        `⏱ Your OTP request has expired.\n\n` +
                        `💰 Any locked funds have been returned to your balance.\n\n` +
                        `You can request a new OTP with /otp`;

                    await this.bot.telegram.sendMessage(userId, timeoutMessage, {
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔄 Request New OTP', 'menu')],
                            [Markup.button.callback('📞 Contact Support', 'contact_support')]
                        ]).reply_markup
                    });

                } catch (err) {
                    logger.error('Timeout handling failed', { sessionId, error: err.message });
                }
            }, Math.min(delayMs, 2147483647));

            this._timeoutTimers.set(sessionId, timer);

        } catch (error) {
            logger.error('Failed to schedule timeout', { userId, sessionId, error: error.message });
        }
    }

    async handleCancel(ctx, isTimeout = false) {
        const userId = ctx.from.id.toString();

        try {
            const activeSession = await Session.findOne({ 
                userId, 
                status: { $in: ['WAITING', 'CHECKING'] } 
            });
            
            if (!activeSession && isTimeout) {
                logger.info('Timeout: no active session to cancel', { userId });
                return;
            }

            if (!activeSession && !isTimeout) {
                const timedOutSession = await Session.findOne({
                    userId,
                    status: 'TIMEOUT'
                }).sort({ endTime: -1 });

                if (timedOutSession) {
                    return this.sendPhotoWithCaption(ctx, IMAGES.default,
                        '⏰ This session has already expired.\n\nYou can request a new OTP with /otp',
                        Markup.inlineKeyboard([
                            [Markup.button.callback('🔄 Request New OTP', 'menu')],
                            [Markup.button.callback('📞 Contact Support', 'contact_support')]
                        ]), 'HTML'
                    );
                }

                return this.sendPhotoWithCaption(ctx, IMAGES.default, 
                    '❌ No active session to cancel.',
                    KEYBOARDS.backToMenu(), 'HTML'
                );
            }

            const sessionId = activeSession.sessionId;

            if (this._timeoutTimers?.has(sessionId)) {
                clearTimeout(this._timeoutTimers.get(sessionId));
                this._timeoutTimers.delete(sessionId);
            }

            if (sessionManager && sessionManager.pollTimers?.has(sessionId)) {
                clearTimeout(sessionManager.pollTimers.get(sessionId));
                sessionManager.pollTimers.delete(sessionId);
            }
            if (sessionManager && sessionManager.activeSessions?.has(sessionId)) {
                sessionManager.activeSessions.delete(sessionId);
            }

            let providerCancelled = false;
            if (activeSession.mode === 'CHEAP' && activeSession.providerNumberId) {
                try {
                    await this.smsProviderManager.cancelCheapNumber(activeSession.providerNumberId);
                    providerCancelled = true;
                    logger.info('5SIM cancelled', { sessionId, activationId: activeSession.providerNumberId });
                } catch (err) {
                    if (err.response?.data === 'order not found' || err.message?.includes('order not found')) {
                        providerCancelled = true;
                        logger.info('5SIM already cancelled', { sessionId });
                    } else {
                        logger.warn('5SIM cancel failed', { sessionId, error: err.message });
                    }
                }
            }

            if (activeSession.mode === 'FREE' && activeSession.providerNumberId && this.smsProviderManager) {
                try {
                    await this.smsProviderManager.cancelNumber('FREE_PUBLIC', activeSession.providerNumberId);
                    providerCancelled = true;
                } catch (err) {
                    logger.warn('Free provider cancel failed', { sessionId });
                }
            }

            let cancelResult;
            try {
                cancelResult = await sessionManager.cancelSession(sessionId, userId);
                logger.info('Session cancelled', { sessionId, releasedAmount: cancelResult?.releasedAmount || 0 });
            } catch (err) {
                logger.error('cancelSession failed, forcing cleanup', { sessionId, error: err.message });
                await Session.updateOne(
                    { sessionId },
                    { $set: { status: 'CANCELLED', endTime: new Date(), providerReleased: providerCancelled } }
                );
                cancelResult = { releasedAmount: 0 };
            }

            const refundLine = cancelResult?.releasedAmount > 0
                ? `💰 Refunded: ${formatCurrency(cancelResult.releasedAmount)}\n`
                : (activeSession.mode === 'CHEAP' && providerCancelled)
                    ? `💰 Funds returned to balance\n`
                    : '';

            let message, keyboard;

            if (isTimeout) {
                message =
                    `⏰ <b>OTP Request Timed Out</b>\n\n` +
                    `📱 Number: <code>${activeSession.number}</code>\n` +
                    `🎯 Service: ${activeSession.service}\n` +
                    `⏱ Status: <b>Expired</b>\n\n` +
                    `${refundLine || '💰 Funds handled'}\n\n` +
                    `You can request a new OTP with /otp`;

                keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Request New OTP', 'menu')],
                    [Markup.button.callback('📞 Contact Support', 'contact_support')]
                ]);
            } else {
                message =
                    `✅ <b>Session Cancelled</b>\n\n` +
                    `📱 Number: <code>${activeSession.number}</code>\n` +
                    `🎯 Service: ${activeSession.service}\n` +
                    refundLine +
                    `\nAny used credits have been restored.\n` +
                    `You can start a new request now.`;

                keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('📱 New OTP Request', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]);
            }

            if (isTimeout) {
                await this.bot.telegram.sendMessage(userId, message, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard.reply_markup
                });
            } else {
                await this.sendPhotoWithCaption(ctx, IMAGES.default, message, keyboard, 'HTML');
            }

        } catch (error) {
            logger.error('Cancel failed', { userId, error: error.message });
            if (!isTimeout) {
                await this.sendPhotoWithCaption(ctx, IMAGES.default, 
                    '❌ Failed to cancel session. Please try again.',
                    KEYBOARDS.backToMenu(), 'HTML'
                );
            }
        }
    }


                      // ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 2: Main Menu, My Number, Mode Handlers, Selection
//  INTEGRATED: Tier-based operator selection system for CHEAP mode
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  MAIN MENU & MY NUMBER
    // ═══════════════════════════════════════════════════════════════════════

    async handleOTPCommand(ctx) {
        const user = ctx.state.user;
        const isVip = this._isVipActive(user);
        const hasBundle = (user.bundleRemaining || 0) > 0;

        let message = '📱 <b>Request OTP</b>\n\nSelect your preferred mode:';
        
        const buttons = [
            [Markup.button.callback('🆓 FREE', 'mode_free'), Markup.button.callback('💰 CHEAP', 'mode_cheap')]
        ];

        if (hasBundle || isVip) {
            buttons.push([
                Markup.button.callback('📦 Bundle', 'mode_bundle'),
                Markup.button.callback('👑 VIP', 'mode_vip')
            ]);
        } else {
            buttons.push([
                Markup.button.callback('📦 Buy Bundle', 'buy_bundle'),
                Markup.button.callback('👑 Upgrade VIP', 'buy_vip')
            ]);
        }

        if (isVip && user.vipPhoneNumber) {
            buttons.push([Markup.button.callback('📱 View My Number', 'view_my_number')]);
        }

        buttons.push([Markup.button.callback('🔙 Back to OTP Hub', 'otp_hub')]);

        const keyboard = Markup.inlineKeyboard(buttons);
        await this.sendPhotoWithCaption(ctx, IMAGES.otpMenu, message, keyboard, 'HTML');
    }
             
    async handleViewMyNumber(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return this.sendPhotoWithCaption(
                ctx, IMAGES.vipFirst,
                '❌ <b>Not a VIP User</b>\n\nYou need an active VIP subscription to have a dedicated number.\n\nUpgrade to VIP now?',
                Markup.inlineKeyboard([
                    [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );
        }

        if (!user.vipPhoneNumber) {
            const assignment = await this.assignVipNumber(user.userId, 'US');
            if (!assignment) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.vipFirst,
                    '⚠️ <b>Number Assignment Pending</b>\n\nWe\'re assigning your VIP number. Please try again in a moment.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry', 'view_my_number')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }
            user.vipPhoneNumber = assignment.phoneNumber;
            user.vipNumberId = assignment.numberId;
            user.vipProvider = assignment.provider;
        }

        const daysLeft = this._vipDaysLeft(user);
        const vipRemaining = this._vipRemaining(user);
        const bundleRemaining = user.bundleRemaining || 0;

        const message = 
            `📱 <b>Your VIP Number</b>\n\n` +
            `📞 <b>Number:</b> <code>${user.vipPhoneNumber}</code>\n` +
            `🏢 <b>Provider:</b> ${user.vipProvider}\n` +
            `🌍 <b>Country:</b> ${user.vipNumberCountry || 'US'}\n\n` +
            `⏰ <b>VIP Status</b>\n` +
            `• Expires: <code>${user.vipExpiry ? new Date(user.vipExpiry).toLocaleDateString() : 'N/A'}</code>\n` +
            `• Days Left: <code>${daysLeft}</code> day${daysLeft !== 1 ? 's' : ''}\n` +
            `• Daily OTPs: <code>${vipRemaining}</code> remaining today\n\n` +
            `📦 <b>Bundle Credits</b>\n` +
            `• Available: <code>${bundleRemaining}</code> OTPs\n\n` +
            `<i>Your number is dedicated to you. Use it for any service.</i>`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔢 Request OTP', 'request_otp_vip')],
            [Markup.button.callback('📦 Buy More OTPs', 'buy_bundle_otp')],
            [Markup.button.callback('❌ Cancel VIP', 'cancel_vip_subscription')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.myNumber, message, keyboard, 'HTML');
    }
    
    async handleMyNumberCommand(ctx) {
        return this.handleViewMyNumber(ctx);
    }
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
}


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
}

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
}
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
}


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
}

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
}

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
}
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
                    '📱 <b>Free Number 
