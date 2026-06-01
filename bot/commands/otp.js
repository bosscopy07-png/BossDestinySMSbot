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
            'handleFaq', 'handleTerms', 'handleOTPHub',
            'handleWatchAd', 'handleCheckCredits', 'handleFreeServiceSelected',
            'handleFreeCountrySelected', 'handleCheckFree',
            // NEW: Tier system handlers
            'handleTierSelect', 'handleTierCountrySelect',
            'handleTierSearchService', 'handleTierSearchCountry',
            'handleTierServicePage', 'hasService', 'handleTierCountryPage'
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
                                                                 }
       
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
}
        
        
    // ═══════════════════════════════════════════════════════════════════════
    //  CHEAP MODE — NEW TIER-BASED FLOW
    //  Steps: Service Selection → Tier Selection → Country Selection → Auto Purchase
    // ═══════════════════════════════════════════════════════════════════════

    async handleCheapMode(ctx) {
        const user = ctx.state.user;
        
        try {
            if (!this.tierSelector || !this.countryCatalog) {
                logger.warn('Tier system not available, falling back to legacy CHEAP flow');
                return this._handleCheapModeLegacy(ctx);
            }

            const minEntryPrice = TIER_CONFIG.budget.priceMultiplier * 0.05;
            if (this._getAvailableBalance(user) < minEntryPrice) {
                const message = 
                    `💰 <b>Insufficient Balance</b>\n\n` +
                    `CHEAP mode requires at least ${formatCurrency(minEntryPrice)}.\n` +
                    `Available: ${formatCurrency(this._getAvailableBalance(user))}\n\n` +
                    `Please deposit first.`;
                    
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]);
                
                return this.sendPhotoWithCaption(ctx, IMAGES.cheapMode, message, keyboard, 'HTML');
            }

            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'CHEAP';

            await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode);
            
        } catch (error) {
            logger.error('handleCheapMode failed', { userId: user.userId, error: error.message });
            return this._handleCheapModeLegacy(ctx);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  LEGACY CHEAP MODE (Fallback)
    // ═══════════════════════════════════════════════════════════════════════

    async _handleCheapModeLegacy(ctx) {
        const user = ctx.state.user;
        
        try {
            let displayPrice = config.prices?.cheapOtp || 0.05;

            if (this.smsProviderManager) {
                try {
                    const priceInfo = await this.smsProviderManager.getCheapPrice('US', 'Any');
                    if (priceInfo && priceInfo.displayPrice) {
                        displayPrice = priceInfo.displayPrice;
                    }
                } catch (priceError) {
                    logger.warn('Failed to get dynamic CHEAP price, using fallback', { 
                        error: priceError.message 
                    });
                }
            }

            if (this._getAvailableBalance(user) < displayPrice) {
                const message = 
                    `💰 <b>Insufficient Balance</b>\n\n` +
                    `Required: ${formatCurrency(displayPrice)}\n` +
                    `Available: ${formatCurrency(this._getAvailableBalance(user))}\n\n` +
                    `Please deposit first.`;
                    
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]);
                
                return this.sendPhotoWithCaption(ctx, IMAGES.cheapMode, message, keyboard, 'HTML');
            }

            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'CHEAP';
            ctx.session.cheapDisplayPrice = displayPrice;

            await this._showLegacyServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode, displayPrice);
            
        } catch (error) {
            logger.error('Legacy cheap mode failed', { userId: user.userId, error: error.message });
            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'CHEAP';
            await this._showLegacyServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode);
        }
    }

    async handleBundleMode(ctx) {
        const user = ctx.state.user;
        
        if (!user.bundleRemaining || user.bundleRemaining <= 0) {
            return this.handleBuyBundle(ctx);
        }

        if (this._isVipActive(user) && user.vipPhoneNumber) {
            ctx.session = ctx.session || {};
            ctx.session.otpMode = 'BUNDLE';
            ctx.session.useVipNumber = true;
            return this._showLegacyServiceSelection(ctx, 'BUNDLE (VIP Number)', IMAGES.bundleOther);
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'BUNDLE';
        ctx.session.useVipNumber = false;
        await this._showLegacyServiceSelection(ctx, 'BUNDLE', IMAGES.bundleOther);
    }

    async handleVIPMode(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            const message = 
                `👑 <b>VIP Required</b>\n\n` +
                `You need an active VIP subscription.\n\n` +
                `Price: ${formatCurrency(config.prices?.vipSubscription || 5.00)}/month\n` +
                `✅ 50 OTPs per day\n` +
                `⚡ Dedicated number\n` +
                `🚀 Priority routing\n\n` +
                `Upgrade now?`;
                
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('👑 Upgrade VIP', 'buy_vip')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            
            return this.sendPhotoWithCaption(ctx, IMAGES.vipFirst, message, keyboard, 'HTML');
        }
        
        if (!this._canUseVip(user)) {
            const message = 
                '⚠️ <b>VIP Daily Limit Reached</b>\n\n' +
                `You've used ${config.limits?.vipDaily || 50}/${config.limits?.vipDaily || 50} VIP OTPs today.\n` +
                'Resets at midnight UTC.\n\n' +
                'Buy bundle OTPs to continue:';
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📦 Buy Bundle OTPs', 'buy_bundle_otp')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);
            
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, keyboard, 'HTML');
        }
        
        if (!user.vipPhoneNumber) {
            const assignment = await this.assignVipNumber(user.userId, 'US');
            if (!assignment) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.vipOther,
                    '⚠️ <b>Number Assignment Pending</b>\n\nWe\'re setting up your VIP number. Please try again shortly.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry', 'mode_vip')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }
            user.vipPhoneNumber = assignment.phoneNumber;
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        ctx.session.useVipNumber = true;
        await this._showLegacyServiceSelection(ctx, 'VIP', IMAGES.vipOther);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OTP HUB — Central OTP services screen
    // ═══════════════════════════════════════════════════════════════════════

    async handleOTPHub(ctx) {
        const user = ctx.state.user;
        const stats = this._getUserStats(user);
        const isVip = stats.isVip;
        const hasBundle = stats.bundleRemaining > 0;

        let message = 
            `📱 <b>OTP Services</b>\n\n` +
            `👤 <b>Quick Stats:</b>\n` +
            `💰 Balance: <code>${formatCurrency(stats.balance)}</code>\n` +
            `🆓 Free Today: <code>${stats.freeRemaining}</code> left\n`;
        
        if (isVip) {
            message += `👑 VIP: <code>${stats.vipRemaining}</code> left (${stats.vipDays} days)\n`;
        }
        if (hasBundle) {
            message += `📦 Bundle: <code>${stats.bundleRemaining}</code> OTPs\n`;
        }
        
        message += `\nChoose an option:`;

        const buttons = [
            [Markup.button.callback('🆓 FREE OTP', 'mode_free'), Markup.button.callback('💰 CHEAP OTP', 'mode_cheap')]
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
            buttons.push([Markup.button.callback('📱 My VIP Number', 'view_my_number')]);
        }

        buttons.push([
            Markup.button.callback('⚡ Quick Buy', 'quick_buy'),
            Markup.button.callback('📊 My Stats', 'stats')
        ]);

        buttons.push([
            Markup.button.callback('📜 History', 'history'),
            Markup.button.callback('👥 Referral', 'referral')
        ]);

        buttons.push([
            Markup.button.callback('⚙️ Settings', 'settings'),
            Markup.button.callback('❓ FAQ', 'faq')
        ]);

        buttons.push([
            Markup.button.callback('🔌 Status', 'provider_status'),
            Markup.button.callback('📞 Support', 'contact_support')
        ]);

        buttons.push([Markup.button.callback('🔙 Back to Main Menu', 'menu')]);

        const keyboard = Markup.inlineKeyboard(buttons);
        await this.sendPhotoWithCaption(ctx, IMAGES.otpMenu, message, keyboard, 'HTML');
    }
    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Service Selection with Search, Popular, Pagination
    //  FIXED: Async calls, shows service names with emojis, no category groups
    // ═══════════════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════
    //  SERVICE SELECTION — Auto-edit with proper fallback
    // ═══════════════════════════════════════════════════════════════════════

    async showServiceSelection(ctx, mode, imageUrl, displayPrice = null, page = 1) {
        if (!this.serviceCatalog || mode !== 'CHEAP') {
            return this._showLegacyServiceSelection(ctx, mode, imageUrl, displayPrice);
        }

        try {
            let services = [];
            let totalPages = 1;
            let isPopularPage = false;

            if (page === 1) {
                const popular = await this.serviceCatalog.getPopularServices(15);
                services = popular;
                isPopularPage = true;
                
                const allServices = await this.serviceCatalog.getServicesPage(1, 1000);
                const remainingCount = Math.max(0, allServices.pagination.total - 15);
                totalPages = 1 + Math.ceil(remainingCount / 15);
            } else {
                const allPage = page - 1;
                const allServices = await this.serviceCatalog.getServicesPage(allPage, 15);
                services = allServices.services;
                const totalAll = allServices.pagination.total;
                totalPages = 1 + Math.ceil(Math.max(0, totalAll - 15) / 15);
            }

            const priceText = displayPrice ? `\n💰 Starting from ${formatCurrency(displayPrice)}` : '';
            let message = `📱 <b>${mode} Mode</b>${priceText}\n\n`;
            
            if (isPopularPage) {
                message += `🔥 <b>Popular Services</b> (Top 15)\n`;
                message += `<i>Most used worldwide</i>\n\n`;
            } else {
                message += `📋 <b>All Services</b> (A-Z) — Page ${page}/${totalPages}\n\n`;
            }
            
            message += `<i>Select a service:</i>`;

            const buttons = [];
            const serviceEmojis = {
                'WhatsApp': '💬', 'Telegram': '✈️', 'Facebook': '👤', 'Instagram': '📸',
                'Twitter': '🐦', 'TikTok': '🎵', 'Binance': '💰', 'Coinbase': '₿',
                'Gmail': '📧', 'Outlook': '📨', 'Netflix': '🎬', 'Amazon': '📦',
                'PayPal': '💳', 'Snapchat': '👻', 'Discord': '🎮', 'Spotify': '🎧',
                'Uber': '🚗', 'Airbnb': '🏠', 'WeChat': '💬', 'Signal': '🔒',
                'LinkedIn': '💼', 'Tinder': '🔥', 'Google': '🔍', 'Microsoft': '🪟',
                'Apple': '🍎', 'Viber': '📞', 'Line': '📱', 'KakaoTalk': '💬',
                'Imo': '📹', 'Zalo': '💬', 'Badoo': '❤️', 'Yahoo': '📧',
                'Yandex': '🔍', 'Mail.ru': '📧', 'Odnoklassniki': '👥', 'VK': '🔷',
                'Avito': '📰', 'OLX': '📰', 'Alibaba': '📦', 'Taobao': '📦',
                'JD': '📦', 'Weibo': '📱', 'QQ': '💬', 'Baidu': '🔍',
                'DingTalk': '💬', 'Meituan': '🍔', 'Douyin': '🎵', 'Kuaishou': '🎥',
                'Pinduoduo': '🛒', 'Xiaohongshu': '📕', 'Tantan': '❤️', 'Momo': '💬',
                'Hepsiburada': '🛒', 'Trendyol': '🛒', 'N11': '🛒', 'Gittigidiyor': '🛒',
                'Letgo': '📱', 'OfferUp': '📱', 'Mercari': '📦', 'Rakuten': '🛒',
                'Shopee': '🛒', 'Lazada': '🛒', 'Tokopedia': '🛒', 'Bukalapak': '🛒',
                'Flipkart': '🛒', 'Snapdeal': '🛒', 'Myntra': '👕', 'Zomato': '🍔',
                'Swiggy': '🍔', 'Ola': '🚗', 'Grab': '🚗', 'Gojek': '🚗',
                'Bolt': '🚗', 'Careem': '🚗', 'Pathao': '🚗', 'Foodpanda': '🍔',
                'Deliveroo': '🍔', 'UberEats': '🍔', 'DoorDash': '🍔', 'Grubhub': '🍔'
            };

            for (let i = 0; i < services.length; i += 3) {
                const row = services.slice(i, i + 3).map(s => {
                    const emoji = serviceEmojis[s.name] || '📱';
                    const popularMark = s.isGlobalTop ? '🔥' : (s.isPopular ? '⭐' : '');
                    return Markup.button.callback(
                        `${emoji} ${s.name}${popularMark}`,
                        `service_select_${s.name}`
                    );
                });
                buttons.push(row);
            }

            const navRow = [];
            if (page > 1) {
                navRow.push(Markup.button.callback('◀️ Prev', `service_page_${page - 1}`));
            }
            navRow.push(Markup.button.callback('🔍 Search', 'service_search_prompt'));
            if (page < totalPages) {
                navRow.push(Markup.button.callback('Next ▶️', `service_page_${page + 1}`));
            }
            if (navRow.length > 0) buttons.push(navRow);

            if (page === 1 && totalPages > 1) {
                buttons.push([Markup.button.callback('📋 Browse All A-Z', 'service_page_2')]);
            }
            buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

            const keyboard = Markup.inlineKeyboard(buttons);

            const editSuccess = await this._tryEditMessage(ctx, message, keyboard);
            
            if (!editSuccess) {
                await this._fallbackSendMessage(ctx, message, keyboard, imageUrl);
            }

        } catch (error) {
            logger.error('showServiceSelection failed', { error: error.message, page, stack: error.stack });
            ctx.reply('❌ Error loading services. Please try /otp again.').catch(() => {});
        }
    }

    
/**
 * Try to edit the existing message.
 * Uses editMessageCaption for photos, editMessageText for text messages.
 * Returns true if successful, false if should fallback.
 */
async _tryEditMessage(ctx, message, keyboard) {
    try {
        // Determine if current message has a photo (caption) or is text-only
        const msg = ctx.callbackQuery?.message || ctx.message;
        const hasPhoto = msg?.photo && msg.photo.length > 0;
        
        const options = {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        };

        if (hasPhoto) {
            await ctx.editMessageCaption(message, options);
        } else {
            await ctx.editMessageText(message, options);
        }
        
        return true;
    } catch (error) {
        // Expected errors when edit is not possible:
        // - message not modified (same content)
        // - message is not a photo (for caption)
        // - message to edit not found
        // - message can't be edited
        const isExpectedError = [
            'message is not modified',
            'message to edit not found',
            'there is no caption in the message',
            "message can't be edited",
            'MESSAGE_NOT_MODIFIED',
            'MESSAGE_ID_INVALID',
            ' Bad Request: message is not modified'
        ].some(errMsg => error.message?.includes(errMsg) || error.description?.includes(errMsg));

        if (!isExpectedError) {
            logger.warn('Unexpected edit error', { error: error.message, userId: ctx.from?.id });
        }
        
        return false;
    }
}

/**
 * Fallback: delete old message and send new one.
 */
async _fallbackSendMessage(ctx, message, keyboard, imageUrl) {
    try {
        await ctx.deleteMessage();
    } catch (delErr) {
        // Message already deleted or can't delete — ignore
    }

    try {
        if (imageUrl) {
            await ctx.replyWithPhoto(imageUrl, {
                caption: message,
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        } else {
            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        }
    } catch (sendErr) {
        logger.error('Fallback send failed', { error: sendErr.message, userId: ctx.from?.id });
        // Last resort
        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        }).catch(() => {});
    }
}


    // ═══════════════════════════════════════════════════════════════════════
    //  LEGACY: Old service selection (all services at once)
    // ═══════════════════════════════════════════════════════════════════════

        async _showLegacyServiceSelection(ctx, mode, imageUrl, displayPrice = null) {
        const priceText = displayPrice ? `\n💰 Starting from ${formatCurrency(displayPrice)}` : '';
        const message = `📱 <b>${mode} Mode</b>${priceText}\n\nChoose the service you need OTP for:`;
        const buttons = [];
        
        // Mode-specific callback prefix
        const callbackPrefix = mode === 'FREE' ? 'free_service_' :
                               mode === 'CHEAP' ? 'cheap_service_' :
                               mode === 'BUNDLE' ? 'bundle_service_' :
                               mode === 'VIP' ? 'vip_service_' :
                               'service_';
        
        for (let i = 0; i < SERVICES.length; i += 3) {
            const row = SERVICES.slice(i, i + 3).map(s => 
                Markup.button.callback(s, `${callbackPrefix}${s}`)
            );
            buttons.push(row);
        }
        
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, imageUrl, message, Markup.inlineKeyboard(buttons), 'HTML');
        }
        

    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Tier Selection (Step 2 of CHEAP flow)
    // ═══════════════════════════════════════════════════════════════════════

    async showTierSelection(ctx, service) {
        const tierInfos = this.tierSelector.getAllTierInfos();
        
        let message = 
            `📱 <b>${service}</b>\n\n` +
            `Choose Number Quality:\n\n`;

        const buttons = [];

        for (const tier of tierInfos) {
            const emoji = tier.emoji;
            const label = tier.label;
            const badge = tier.badge;
            
            let priceText = '';
            try {
                const baseline = await this.tierSelector.selectOperator(
                    tier.key, 'US', service, { timeoutMs: 5000 }
                ).catch(() => null);
                
                if (baseline?.displayPrice) {
                    priceText = ` — from ${formatCurrency(baseline.displayPrice)}`;
                }
            } catch (e) {
                // Ignore price fetch errors
            }

            const badgeText = badge ? ` [${badge.toUpperCase()}]` : '';
            
            message += `${emoji} <b>${label}</b>${badgeText}\n`;
            message += `   ${tier.description}${priceText}\n\n`;

            buttons.push([Markup.button.callback(
                `${emoji} ${label}${badgeText}${priceText}`,
                `tier_${tier.key}`
            )]);
        }

        buttons.push([Markup.button.callback('🔙 Back to Services', 'tier_back_service')]);

        await this.sendPhotoWithCaption(ctx, IMAGES.cheapMode, message, Markup.inlineKeyboard(buttons), 'HTML');
    }

    async handleTierSelect(ctx, tierKey) {
        const service = ctx.session?.otpService;
        
        if (!service) {
            return ctx.answerCbQuery('❌ Session expired. Start over.', { show_alert: true });
        }

        const tierInfo = this.tierSelector.getTierInfo(tierKey);
        if (!tierInfo) {
            return ctx.answerCbQuery('❌ Invalid tier selected');
        }

        ctx.session = ctx.session || {};
        ctx.session.selectedTier = tierKey;

        await ctx.answerCbQuery(`✅ ${tierInfo.label} selected`);

        await this.showTierCountrySelection(ctx, service, tierKey, 1);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Country Selection with Tier-Aware Live Pricing (Step 3)
    // ═════
            

    async showTierCountrySelection(ctx, service, tierKey, page = 1, searchQuery = null) {
        const tierInfo = this.tierSelector.getTierInfo(tierKey);
        
        try {
            // Try to edit loading message
            try {
                await ctx.editMessageCaption(
                    `🌍 <b>Loading ${tierInfo.emoji} ${tierInfo.label} countries...</b>`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                // Not a caption message or can't edit
            }

            const result = await this.countryCatalog.getCountriesForService(
                service, 
                tierKey, 
                { 
                    page, 
                    perPage: 12,
                    searchQuery,
                    topOnly: false
                }
            );

            if (!result.countries || result.countries.length === 0) {
                const noStockMessage = 
                    `⚠️ <b>No ${tierInfo.label} Numbers Available</b>\n\n` +
                    `No ${tierInfo.label.toLowerCase()} numbers available for <b>${service}</b> currently.\n\n` +
                    `Try:\n` +
                    `• Another tier\n` +
                    `• Another service\n` +
                    `• Search for a specific country`;

                const fallbackButtons = [];
                const otherTiers = this.tierSelector.getAllTierInfos().filter(t => t.key !== tierKey);
                for (const t of otherTiers) {
                    fallbackButtons.push([Markup.button.callback(
                        `${t.emoji} Try ${t.label}`,
                        `tier_${t.key}`
                    )]);
                }
                fallbackButtons.push([Markup.button.callback('🔙 Back to Tiers', 'tier_back_tier')]);
                fallbackButtons.push([Markup.button.callback('🔙 Main Menu', 'menu')]);

                return this.sendPhotoWithCaption(
                    ctx, IMAGES.otpFailed, noStockMessage, 
                    Markup.inlineKeyboard(fallbackButtons), 'HTML'
                );
            }

            let message = 
                `🌍 <b>Select Country for ${service}</b>\n` +
                `${tierInfo.emoji} <b>${tierInfo.label} Tier</b>\n\n`;

            if (searchQuery) {
                message += `🔍 Search: "${searchQuery}"\n`;
            }

            message += `Showing ${result.countries.length} countries (cheapest first):\n\n`;

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
                        : (country.price ? ` ~$${applyProfitMargin(country.price).toFixed(2)}` : '');
                        const stockText = country.stock > 0 ? ` ✅` : ' ❌';
                    
                    const label = `${flag} ${country.code}${priceText}${stockText}`;
                    
                    return Markup.button.callback(label, `country_select_${country.code}`);
                });
                buttons.push(row);
            }

            const navRow = [];
            if (result.pagination.hasPrev) {
                navRow.push(Markup.button.callback('◀️ Prev', `country_page_${page - 1}`));
            }
            navRow.push(Markup.button.callback('🔍 Search', 'country_search_prompt'));
            if (result.pagination.hasNext) {
                navRow.push(Markup.button.callback('Next ▶️', `country_page_${page + 1}`));
            }
            if (navRow.length > 0) buttons.push(navRow);

            buttons.push([Markup.button.callback('🔙 Back to Tiers', 'tier_back_tier')]);
            buttons.push([Markup.button.callback('🔙 Main Menu', 'menu')]);

            const keyboard = Markup.inlineKeyboard(buttons);

            // FIXED: Robust auto-edit
            const editSuccess = await this._tryEditMessage(ctx, message, keyboard);
            
            if (!editSuccess) {
                await this._fallbackSendMessage(ctx, message, keyboard, IMAGES.countrySelect);
            }

        } catch (error) {
            logger.error('Tier country selection failed', { 
                service, tierKey, page, error: error.message 
            });
            
            return this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed,
                `❌ <b>Error Loading Countries</b>\n\n${error.message}\n\nPlease try again.`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Retry', `tier_${tierKey}`)],
                    [Markup.button.callback('🔙 Back', 'tier_back_tier')]
                ]),
                'HTML'
            );
        }
        }
                            
                                                                  
                  
    async handleTierCountrySelect(ctx, countryCode) {
    const userId = ctx.from.id.toString();
    const service = ctx.session?.otpService;
    const tierKey = ctx.session?.selectedTier;
    
    // FIXED: Check if user selected a fallback operator from the alternatives list
    const fallbackOperator = ctx.session?.fallbackOperator;

    if (!service || !tierKey) {
        return ctx.answerCbQuery('❌ Session expired. Start over.', { show_alert: true });
    }

    await ctx.answerCbQuery('⏳ Purchasing number...');

    let loadingMsg = null;
    let selection = null;
    
    try {
        loadingMsg = await ctx.reply('⏳ Finding best operator and purchasing number...');

        // FIXED: If fallback operator was selected by user, use it directly
        // instead of calling selectOperator() again which would return the same failed operator
        if (fallbackOperator) {
            logger.info('Using fallback operator from session', {
                userId,
                fallbackOperator,
                tierKey,
                service,
                country: countryCode
            });
            
            // Get fallback operators list and find the selected one
            const fallbackOps = await this.tierSelector.getFallbackOperators(
                tierKey, countryCode, service, null
            );
            
            selection = fallbackOps.find(op => op.operator === fallbackOperator);
            
            if (!selection) {
                // Fallback operator no longer available, clear and error
                delete ctx.session.fallbackOperator;
                throw new Error('FALLBACK_EXPIRED: Selected operator no longer available');
            }
        } else {
            // Normal flow: select best operator from tier
            selection = await this.tierSelector.selectOperator(tierKey, countryCode, service, {
                timeoutMs: 15000
            });
        }

        logger.info('Tier operator selected', {
            userId,
            tier: tierKey,
            service,
            country: countryCode,
            operator: selection.operator,
            price: selection.price,
            displayPrice: selection.displayPrice,
            stock: selection.stock,
            score: selection.score,
            isFallback: !!fallbackOperator
        });

        const user = ctx.state.user;
        if (this._getAvailableBalance(user) < selection.displayPrice) {
            try {
                if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
            } catch (delErr) {}

            const message = 
                `💰 <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(selection.displayPrice)}\n` +
                `Available: ${formatCurrency(this._getAvailableBalance(user))}\n\n` +
                `Price varies by operator quality. Please deposit more.`;
                
            return this.sendPhotoWithCaption(
                ctx, IMAGES.cheapMode, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', `tier_${tierKey}`)]
                ]), 'HTML'
            );
        }

        const cheapProvider = this.smsProviderManager?.getProvider('CHEAP_PANEL');
        if (!cheapProvider) {
            throw new Error('CHEAP_PROVIDER_NOT_AVAILABLE');
                                                                   }
            
        // FIXED: Use the selected operator (could be fallback) for purchase
        const cheapResult = await cheapProvider.getNumber(countryCode, service, selection.operator);

        try {
            if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
        } catch (delErr) {
            logger.debug('Failed to delete loading message', { error: delErr.message });
        }

                // FIXED: Pass operator and routedProvider to session
        const session = await sessionManager.createSessionWithNumber(
            userId, 
            'CHEAP', 
            service, 
            countryCode,
            cheapResult.phoneNumber,
            cheapResult.provider,
            cheapResult.providerNumberId,
            cheapResult.displayCost || selection.displayPrice,
            selection.operator,           // ← FIXED: Pass selected operator
            selection.providerKey         // ← FIXED: Pass provider key (5sim/smspool/etc)
        );

        // ═══════════════════════════════════════════════════════════════════════
        //  AUTO-OTP: Start polling immediately after purchase
        //  This checks every 5 seconds and auto-sends OTP when received
        // ═══════════════════════════════════════════════════════════════════════
        if (this.sessionManager && session?.sessionId) {
            this.startAutoOTPCheck(session.sessionId, ctx, 5000);
            logger.info('Auto OTP polling started', { 
                sessionId: session.sessionId, 
                userId,
                interval: '5s' 
            });
        }

    
        // FIXED: Store session info for auto-OTP delivery
        ctx.session.tierOperator = selection.operator;
        ctx.session.tierKey = tierKey;
        ctx.session.selectedCountry = countryCode;
        
        // FIXED: Clear fallback operator after successful purchase
        delete ctx.session.fallbackOperator;

        const message = 
            `📱 <b>OTP Request Started</b>\n\n` +
            `🌍 Mode: CHEAP (${tierKey.toUpperCase()})\n` +
            `📱 Number: <code>${session.number}</code>\n` +
            `🎯 Service: ${service}\n` +
            `🏢 Operator: <code>${selection.operator}</code>\n` +
            `⏳ Status: Waiting for OTP...\n` +
            `💰 Cost: ${formatCurrency(session.cost)}\n` +
            `⭐ Quality Score: ${selection.score.toFixed(2)}\n` +
            `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
            `⚠️ Funds locked. Will be deducted on delivery.\n` +
            `Cancel anytime to get full refund.`;

        const keyboard = KEYBOARDS.otpActions(session.sessionId);
        const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

        // FIXED: Store message info for auto-OTP delivery editing
        if (sentMessage?.message_id) {
            ctx.session.lastOtpMessageId = sentMessage.message_id;
            ctx.session.lastOtpChatId = ctx.chat?.id;
            
            await this._scheduleTimeoutNotification(
                userId, session.sessionId, sentMessage.message_id, session.timeoutAt
            );
        }

    } catch (error) {
        try {
            if (loadingMsg?.message_id) await ctx.deleteMessage(loadingMsg.message_id);
        } catch (delErr) {}

        logger.error('Tier country purchase failed', {
            userId, tierKey, countryCode, service, error: error.message
        });

        // FIXED: Clear fallback operator on any error so next attempt starts fresh
        delete ctx.session.fallbackOperator;

        if (error.message?.includes('NO_NUMBERS') || error.message?.includes('NOT_AVAILABLE') || error.message?.includes('FALLBACK_EXPIRED')) {
            try {
                // FIXED: Pass the failed operator to exclude it from fallback suggestions
                const failedOperator = selection?.operator || fallbackOperator;
                
                const fallbackOps = await this.tierSelector.getFallbackOperators(
                    tierKey, countryCode, service, failedOperator
                );
                
                if (fallbackOps && fallbackOps.length > 0) {
                    const message = 
                        `⚠️ <b>Primary Operator Unavailable</b>\n\n` +
                        `Operator <code>${failedOperator || 'unknown'}</code> ran out of stock.\n\n` +
                        `Available alternatives in ${tierKey} tier:`;

                    const buttons = fallbackOps.slice(0, 3).map(op => [
                        Markup.button.callback(
                            `🏢 ${op.operator} — ${formatCurrency(op.displayPrice || op.price)}`,
                            `tier_fallback_${op.operator}`
                        )
                    ]);

                    buttons.push([Markup.button.callback('🔙 Back to Countries', `tier_${tierKey}`)]);
                    
                    return this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, message, Markup.inlineKeyboard(buttons), 'HTML');
                }
            } catch (fallbackError) {
                logger.error('Fallback display failed', { error: fallbackError.message });
            }
        }

        const errorMessages = {
            NO_NUMBERS: '❌ No numbers available for this operator. Try another country or tier.',
            NO_BALANCE: '💰 Provider balance insufficient. Contact support.',
            NOT_AVAILABLE: '❌ Service not available in this country for selected tier.',
            TIMEOUT: '⏱ Operator selection timed out. Please try again.',
            INSUFFICIENT_BALANCE: '💰 Your balance is too low for this selection.',
            FALLBACK_EXPIRED: '❌ Selected operator is no longer available. Please try again.'
        };

        const errorKey = Object.keys(errorMessages).find(key => error.message?.includes(key));
        const displayMessage = errorMessages[errorKey] || `❌ Error: ${error.message}`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.otpFailed, 
            displayMessage,
            Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Retry', `tier_country_${countryCode}`)],
                [Markup.button.callback('🔙 Back to Countries', `tier_${tierKey}`)],
                [Markup.button.callback('📞 Support', 'contact_support')]
            ]), 'HTML'
        );
    }
            }
            /**
     * Start automatic OTP polling for a session
     * Checks every few seconds and auto-sends OTP when received
     */
    startAutoOTPCheck(sessionId, ctx, intervalMs = 5000) {
        let checkCount = 0;
        const maxChecks = 36; // 3 minutes (36 * 5s)
        
        const checkInterval = setInterval(async () => {
            checkCount++;
            
            try {
                // Use this.sessionManager (the injected one)
                const status = await this.sessionManager.checkSessionStatus(sessionId);
                
                if (status.status === 'RECEIVED' && status.otpCode) {
                    clearInterval(checkInterval);
                    
                    // Auto-send OTP message to user
                    const message = 
                        `🔓 <b>OTP Received!</b>\n\n` +
                        `📱 Number: <code>${status.number}</code>\n` +
                        `🎯 Service: ${status.service}\n` +
                        `🔢 OTP: <code>${status.otpCode}</code>\n` +
                        `🕐 Delivered: ${new Date().toLocaleTimeString()}\n\n` +
                        `⚠️ Do not share this code with anyone.`;

                    await ctx.telegram.sendMessage(ctx.from.id, message, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔙 Back to Menu', callback_data: 'menu' }]
                            ]
                        }
                    });
                    
                    logger.info('Auto OTP delivered via polling', { 
                        sessionId, 
                        userId: ctx.from.id,
                        checks: checkCount 
                    });
                    return;
                }

                // Stop if session is no longer active
                if (!['WAITING', 'CHECKING'].includes(status.status)) {
                    clearInterval(checkInterval);
                    logger.debug('Auto OTP polling stopped (session ended)', { 
                        sessionId, 
                        status: status.status 
                    });
                    return;
                }

                // Max checks reached (timeout)
                if (checkCount >= maxChecks) {
                    clearInterval(checkInterval);
                    logger.info('Auto OTP polling stopped (timeout)', { sessionId });
                }

            } catch (error) {
                logger.error('Auto OTP check error', { sessionId, error: error.message });
                // Don't clear interval on error — keep trying
            }
        }, intervalMs);
    }
    

    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Pagination Handlers
    // ═══════════════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════
    //  SERVICE PAGE NAVIGATION — Edit existing message
    // ═══════════════════════════════════════════════════════════════════════

    async handleTierServicePage(ctx, page) {
        try {
            await ctx.answerCbQuery(`Page ${page}`);
            
            // Just call showServiceSelection which handles editing
            await this.showServiceSelection(ctx, 'CHEAP', IMAGES.cheapMode, null, page);
            
        } catch (error) {
            logger.error('handleTierServicePage failed', { error: error.message, page });
            ctx.answerCbQuery('❌ Error loading page').catch(() => {});
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY PAGE NAVIGATION — Edit existing message
    // ═══════════════════════════════════════════════════════════════════════

    async handleTierCountryPage(ctx, page) {
        const service = ctx.session?.otpService;
        const tierKey = ctx.session?.selectedTier;

        if (!service || !tierKey) {
            return ctx.answerCbQuery('❌ Session expired', { show_alert: true });
        }

        try {
            await ctx.answerCbQuery(`Page ${page}`);
            await this.showTierCountrySelection(ctx, service, tierKey, page);
        } catch (error) {
            logger.error('handleTierCountryPage failed', { error: error.message, page, service, tierKey });
            ctx.answerCbQuery('❌ Error loading page').catch(() => {});
        }
    }
        
    // ═══════════════════════════════════════════════════════════════════════
    //  NEW: Search Handlers
    //  FIXED: Async calls to searchServices()
    // ═══════════════════════════════════════════════════════════════════════
    async handleTierSearchService(ctx, query) {
        if (!query || query.trim().length < 2) {
            return ctx.reply('❌ Please enter at least 2 characters to search.');
        }

        const results = await this.serviceCatalog.searchServices(query);
        
        if (results.length === 0) {
            return ctx.reply(
                `❌ No services found for "${query}"\n\nTry another search term.`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔍 Search Again', 'service_search_prompt')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ])
            );
        }

        let message = `🔍 <b>Search Results for "${query}"</b>\n\nFound ${results.length} services:\n\n`;
        const buttons = [];

        const serviceEmojis = {
            'WhatsApp': '💬', 'Telegram': '✈️', 'Facebook': '👤', 'Instagram': '📸',
            'Twitter': '🐦', 'TikTok': '🎵', 'Binance': '💰', 'Coinbase': '₿',
            'Gmail': '📧', 'Outlook': '📨', 'Netflix': '🎬', 'Amazon': '📦',
            'PayPal': '💳', 'Snapchat': '👻', 'Discord': '🎮', 'Spotify': '🎧',
            'Uber': '🚗', 'Airbnb': '🏠', 'WeChat': '💬', 'Signal': '🔒',
            'LinkedIn': '💼', 'Tinder': '🔥', 'Google': '🔍', 'Microsoft': '🪟',
            'Apple': '🍎', 'Viber': '📞', 'Line': '📱', 'KakaoTalk': '💬',
            'Imo': '📹', 'Zalo': '💬', 'Badoo': '❤️'
        };

        // 3 columns
        for (let i = 0; i < results.length && i < 15; i += 3) {
            const row = results.slice(i, i + 3).map(r => {
                const emoji = serviceEmojis[r.name] || '📱';
                return Markup.button.callback(
                    `${emoji} ${r.name}`,
                    `service_select_${r.name}`
                );
            });
            buttons.push(row);
        }

        buttons.push([Markup.button.callback('🔍 New Search', 'service_search_prompt')]);
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);

        // Try to edit, fallback to reply
        try {
            await ctx.editMessageCaption(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
        } catch (e) {
            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
        }
                            }
        
    

    async handleTierSearchCountry(ctx, query) {
        const service = ctx.session?.otpService;
        const tierKey = ctx.session?.selectedTier;

        if (!service || !tierKey) {
            return ctx.reply('❌ Session expired. Please start over with /otp');
        }

        // countryCatalog.searchCountries is synchronous (returns array)
        const matches = this.countryCatalog.searchCountries(query);
        
        if (matches.length === 0) {
            return ctx.reply(
                `❌ No countries found for "${query}"\n\nTry country name or ISO code (e.g., US, UK).`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔍 Search Again', 'country_search_prompt')],
                    [Markup.button.callback('🔙 Back', `tier_${tierKey}`)]
                ])
            );
        }

        await this.showTierCountrySelection(ctx, service, tierKey, 1, query);
    }
        
    
            // ═══════════════════════════════════════════════════════════════════════
    //  SERVICE & COUNTRY SELECTION
    //  FIXED: Uses dynamic catalog, no hardcoded SERVICES/COUNTRIES
    // ═══════════════════════════════════════════════════════════════════════
          /**
     * Check if a service exists in dynamic catalog
     * FIXED: Added type guard to prevent non-string inputs
     */
    async hasService(serviceName) {
        await this._ensureLoaded();
        
        // FIXED: Type guard — ensure serviceName is a string
        if (!serviceName || typeof serviceName !== 'string') {
            logger.warn('hasService called with invalid type', { 
                serviceName, 
                type: typeof serviceName 
            });
            return false;
        }
        
        return this._serviceMap.has(serviceName.toLowerCase());
    }
        
            async handleServiceSelect(ctx, serviceName = null) {
        // FIXED: Ensure serviceName is a string
        let service = serviceName;
        
        if (!service && ctx.message?.text) {
            service = ctx.message.text.trim();
        }
        
        // Guard against non-string inputs (function, object, number, etc.)
        if (!service || typeof service !== 'string') {
            logger.warn('handleServiceSelect: invalid service input', { 
                service, 
                type: typeof service,
                serviceName,
                match: ctx.match?.[1],
                matchType: typeof ctx.match
            });
            return ctx.answerCbQuery('❌ Invalid service').catch(() => {});
        }
        
        const isValid = await this.serviceCatalog.hasService(service);
        if (!isValid) {
            logger.warn('Invalid service selected', { service });
            return ctx.answerCbQuery('❌ Invalid service').catch(() => {});
        }
        
        ctx.session = ctx.session || {};
        ctx.session.otpService = service;
        
        const mode = ctx.session?.otpMode;

        if (mode === 'CHEAP' && this.tierSelector) {
            return this.showTierSelection(ctx, service);
        }

        if (mode === 'CHEAP') {
            return this._showCheapCountrySelectionLegacy(ctx, service);
        }
        
        // For non-CHEAP modes
        const message = `🌍 <b>Select Country</b>\n\nChoose number country for <b>${service}</b>:`;
        
        const availableCountries = await this.countryCatalog.getCountriesForService(service, 'standard', {
            topOnly: true,
            perPage: 20
        });
        
        const buttons = availableCountries.countries.map(c => [
            Markup.button.callback(
                `${c.flag} ${c.name}${c.displayPrice ? ` (${formatCurrency(c.displayPrice)})` : ''}`, 
                `country_select_${c.code}`
            )
        ]);
        
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        await this.sendPhotoWithCaption(ctx, IMAGES.countrySelect, message, Markup.inlineKeyboard(buttons), 'HTML');
            }
        
        
        
                                                                                                      
        /**
     * Legacy country selection with CHEAP provider prices.
     * FIXED: Uses dynamic country catalog as fallback instead of hardcoded COUNTRIES
     * 
     * @param {Object} ctx - Telegraf context
     * @param {string} service - Service code (e.g., 'wa', 'ig')
     * @returns {Promise<void>}
     */
    async _showCheapCountrySelectionLegacy(ctx, service) {
        const userId = ctx.from?.id?.toString();
        if (!userId) {
            logger.error('Missing user ID in country selection');
            return ctx.reply('❌ Authentication error. Please try /start').catch(() => {});
        }

        let loadingMsg = null;
        
        try {
            loadingMsg = await ctx.reply('🌍 Fetching available countries...');
            
            if (!this.smsProviderManager) {
                throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
            }

            const countriesResult = await this.smsProviderManager.getCheapCountries(service);
            
            if (!countriesResult || countriesResult.length === 0) {
                await this._safeDeleteMessage(ctx, loadingMsg);
                
                return this.sendPhotoWithCaption(
                    ctx, 
                    IMAGES.otpFailed,
                    `❌ <b>No Countries Available</b>\n\nNo countries have stock for <b>${service}</b> right now.\n\nTry another service or check back later.`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Another Service', 'menu')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }

            // Fetch prices in parallel with concurrency limit
            const countriesWithPrices = await this._fetchPricesParallel(
                countriesResult.slice(0, 20), 
                service
            );

            // Sort by display price ascending
            countriesWithPrices.sort((a, b) => (a.displayPrice ?? Infinity) - (b.displayPrice ?? Infinity));

            await this._safeDeleteMessage(ctx, loadingMsg);

            const message = `🌍 <b>Select Country for ${service}</b>\n\nPrices include service fee. Cheapest shown first:`;
            const buttons = this._buildCountryButtons(countriesWithPrices);
            buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
            
            await this.sendPhotoWithCaption(
                ctx, 
                IMAGES.countrySelect, 
                message, 
                Markup.inlineKeyboard(buttons), 
                'HTML'
            );

        } catch (error) {
            await this._safeDeleteMessage(ctx, loadingMsg);

            logger.error('Failed to fetch CHEAP countries', { userId, service, error: error.message });
            
            // FIXED: Use dynamic country catalog fallback instead of hardcoded COUNTRIES
            const fallbackCountries = await this.countryCatalog.getCountriesForService(service, 'standard', {
                topOnly: true,
                perPage: 20
            });

            const message = `🌍 <b>Select Country</b>\n\n⚠️ Live prices unavailable. Showing available countries for <b>${service}</b>:`;
            
            const buttons = fallbackCountries.countries.map(c => [
                Markup.button.callback(
                    `${c.flag} ${c.name}${c.displayPrice ? ` (${formatCurrency(c.displayPrice)})` : ''}`, 
                    `country_${c.code}`
                )
            ]);
            
            buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
            
            await this.sendPhotoWithCaption(
                ctx, 
                IMAGES.countrySelect, 
                message, 
                Markup.inlineKeyboard(buttons), 
                'HTML'
            );
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

    /**
     * Fetch prices in parallel with error resilience.
     * @private
     */
    async _fetchPricesParallel(countries, service) {
        const pricePromises = countries.map(async (country) => {
            try {
                const priceInfo = await this.smsProviderManager.getCheapPrice(country.code, service);
                return {
                    ...country,
                    simPrice: priceInfo.simPrice,
                    displayPrice: priceInfo.displayPrice,
                    stock: priceInfo.stock
                };
            } catch (priceErr) {
                return {
                    ...country,
                    simPrice: null,
                    displayPrice: null,
                    stock: country.stock || 0
                };
            }
        });

        return Promise.all(pricePromises);
    }

    /**
     * Build inline keyboard rows for country selection.
     * @private
     */
    _buildCountryButtons(countriesWithPrices) {
        const buttons = [];
        
        for (let i = 0; i < countriesWithPrices.length; i += 2) {
            const row = countriesWithPrices.slice(i, i + 2).map(c => {
                const priceText = c.displayPrice 
                    ? ` $${c.displayPrice.toFixed(2)}`
                    : (c.simPrice ? ` ~$${(c.simPrice + 0.20).toFixed(2)}` : '');
                const stockText = c.stock > 5 ? '' : ` (${c.stock} left)`;
                
                return Markup.button.callback(
                    `${this._getFlag(c.code)} ${c.name}${priceText}${stockText}`,
                    `country_${c.code}`
                );
            });
            buttons.push(row);
        }

        return buttons;
    }
        
    /**
     * Get emoji flag for country code.
     * FIXED: Uses isoToFlag utility instead of hardcoded map
     * @private
     */
    _getFlag(code) {
        // Use the same utility as CountryCatalog for consistency
        if (!code || typeof code !== 'string' || code.length !== 2) return '🌍';
        const cc = code.toUpperCase();
        const OFFSET = 127397;
        try {
            return (
                String.fromCodePoint(cc.charCodeAt(0) + OFFSET) +
                String.fromCodePoint(cc.charCodeAt(1) + OFFSET)
            );
        } catch {
            return '🌍';
        }
    }
        
    /**
     * Get popular services, with global top 15 first, then config, then A-Z backfill
     * FIXED: Prioritizes actually popular services (WhatsApp, Telegram, etc.)
     */
    async getPopularServices(minCount = 15) {
        await this._ensureLoaded();

        if (this._allServices.size === 0) {
            return [];
        }

        const result = [];
        const added = new Set();

        // FIXED: Hardcoded global top 15 most popular services worldwide
        const GLOBAL_TOP_15 = [
            'WhatsApp', 'Telegram', 'Facebook', 'Instagram', 'Twitter',
            'TikTok', 'Gmail', 'Google', 'Netflix', 'Amazon',
            'PayPal', 'Snapchat', 'Discord', 'Spotify', 'Uber'
        ];

        // Step 1: Add global top 15 that exist in catalog
        for (const name of GLOBAL_TOP_15) {
            const normalized = name.toLowerCase();
            if (this._serviceMap.has(normalized)) {
                const displayName = this._serviceMap.get(normalized);
                if (!added.has(displayName)) {
                    result.push({
                        name: displayName,
                        category: this._getServiceCategory(displayName),
                        isPopular: true,
                        isGlobalTop: true
                    });
                    added.add(displayName);
                }
            }
        }

        // Step 2: Add from POPULAR_SERVICES config (excluding already added)
        for (const name of POPULAR_SERVICES) {
            if (added.size >= minCount) break;
            const normalized = name.toLowerCase();
            if (this._serviceMap.has(normalized)) {
                const displayName = this._serviceMap.get(normalized);
                if (!added.has(displayName)) {
                    result.push({
                        name: displayName,
                        category: this._getServiceCategory(displayName),
                        isPopular: true,
                        isGlobalTop: false
                    });
                    added.add(displayName);
                }
            }
        }

        // Step 3: Backfill from catalog A-Z until minCount reached
        const needed = minCount - result.length;
        if (needed > 0) {
            const remaining = Array.from(this._allServices)
                .filter(s => !added.has(s))
                .sort((a, b) => a.localeCompare(b)); // A-Z sort

            for (const name of remaining.slice(0, needed)) {
                result.push({
                    name,
                    category: this._getServiceCategory(name),
                    isPopular: false,
                    isGlobalTop: false
                });
                added.add(name);
            }
        }

        logger.debug('Popular services', {
            globalTop: result.filter(s => s.isGlobalTop).length,
            configPopular: result.filter(s => s.isPopular && !s.isGlobalTop).length,
            backfill: result.filter(s => !s.isPopular).length,
            total: result.length
        });

        return result;
    }
        
                            
// ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 3: Core Purchase Logic, Polling, Check OTP, Cancel
//  INTEGRATED: Tier-based operator selection for CHEAP mode
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTED — ACQUIRE NUMBER (CORE LOGIC)
    // ═══════════════════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════════════════
    //  COUNTRY SELECTED — ACQUIRE NUMBER (CORE LOGIC)
    //  MERGED: Handles both tier-based and legacy flows
    // ═══════════════════════════════════════════════════════════════════════

    async handleCountrySelect(ctx, countryCode = null) {
        const country = countryCode || ctx.match?.[1];
        const userId = ctx.from?.id?.toString();
        const mode = ctx.session?.otpMode;
        const service = ctx.session?.otpService;
        const useVipNumber = ctx.session?.useVipNumber;

        // ── Validation ──
        if (!country) {
            return ctx.answerCbQuery('❌ Invalid country').catch(() => {});
        }

        if (!mode || !service) {
            return this.sendPhotoWithCaption(ctx, IMAGES.default, 
                '❌ Session expired. Please start over with /otp',
                KEYBOARDS.backToMenu(), 'HTML'
            );
        }

        // Validate country exists in dynamic catalog
        const hasCountry = this.countryCatalog?.hasCountry(country);
        if (!hasCountry && mode === 'CHEAP' && this.tierSelector) {
            return ctx.answerCbQuery('🌍 Invalid country selected. Please try again.', { show_alert: true });
        }

        // ── Route to tier-based flow if applicable ──
        if (mode === 'CHEAP' && this.tierSelector && ctx.session?.selectedTier) {
            return this.handleTierCountrySelect(ctx, country);
        }

        // ── Check existing session ──
        const existingSession = await this._getActiveSession(userId);
        if (existingSession && existingSession.status !== 'RECEIVED') {
            return this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed,
                '⏳ <b>Active Session Exists</b>\n\nYou already have an active OTP request.\n\nCancel it first to start a new one.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔍 Check Status', `check_otp_${existingSession.sessionId}`)],
                    [Markup.button.callback('❌ Cancel Session', 'cancel_otp')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );
        }

        let loadingMsg = null;
        
        try {
            loadingMsg = await ctx.reply('⏳ Assigning number...');

            // ═════════════════════════════════════════════════════════════════
            //  VIP/BUNDLE with VIP number — uses NumberPool ONLY
            // ═════════════════════════════════════════════════════════════════
            if (useVipNumber && this._isVipActive(ctx.state.user) && ctx.state.user.vipPhoneNumber) {
                const user = ctx.state.user;
                
                if (mode === 'VIP') {
                    await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });
                } else if (mode === 'BUNDLE') {
                    await User.updateOne({ userId }, { $inc: { bundleRemaining: -1 } });
                }

                await this._safeDeleteMessage(ctx, loadingMsg);

                const costText = mode === 'VIP' ? 'VIP (daily quota)' : 'BUNDLE (1 credit)';

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: ${mode}\n` +
                    `📱 Number: <code>${user.vipPhoneNumber}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: ${costText}\n\n` +
                    `⚠️ Your dedicated VIP number. OTP will arrive shortly.`;

                const keyboard = KEYBOARDS.otpActions(`vip_${userId}_${Date.now()}`);
                
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                const session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    user.vipPhoneNumber, user.vipProvider
                );

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // ═════════════════════════════════════════════════════════════════
            //  BUNDLE without VIP number — uses NumberPool ONLY
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'BUNDLE') {
                const user = await User.findOne({ userId });
                if (!user?.bundleRemaining || user.bundleRemaining <= 0) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    
                    return this.sendPhotoWithCaption(
                        ctx, IMAGES.bundleFirst,
                        '❌ <b>No Bundle Credits</b>\n\nYour bundle OTPs have been exhausted. Buy a new bundle to continue.',
                        Markup.inlineKeyboard([
                            [Markup.button.callback('📦 Buy Bundle', 'buy_bundle')],
                            [Markup.button.callback('🔙 Back', 'menu')]
                        ]),
                        'HTML'
                    );
                }
                
                await User.updateOne({ userId }, { $inc: { bundleRemaining: -1 } });

                if (!this.smsProviderManager) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const bundleResult = await this.smsProviderManager.getVipNumber(country, service, userId);

                await this._safeDeleteMessage(ctx, loadingMsg);

                const session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    bundleResult.phoneNumber, bundleResult.provider,
                    bundleResult.providerNumberId || bundleResult.numberId
                );

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: BUNDLE\n` +
                    `📱 Number: <code>${session.number}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: BUNDLE (1 credit used)\n` +
                    `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                    `⚠️ Bundle credit used. No additional charge.`;

                const keyboard = KEYBOARDS.otpActions(session.sessionId);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // ═════════════════════════════════════════════════════════════════
            //  FREE tier — uses FreeProvider ONLY
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'FREE') {
                if (!this.smsProviderManager) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const freeResult = await this.smsProviderManager.getFreeNumber(country, service);

                await this._safeDeleteMessage(ctx, loadingMsg);

                const session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    freeResult.phoneNumber, 'FREE_PUBLIC',
                    freeResult.sessionId
                );

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: FREE\n` +
                    `📱 Number: <code>${session.number}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: FREE\n` +
                    `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                    `⚠️ Shared number. OTP not guaranteed.`;

                const keyboard = KEYBOARDS.otpActions(session.sessionId);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                this.startFreePolling(ctx, userId, freeResult.sessionId, session.sessionId);

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // ═════════════════════════════════════════════════════════════════
            //  CHEAP tier — LEGACY PATH (when tier system NOT used)
            //  New tier flow bypasses this via handleTierCountrySelect
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'CHEAP') {
                if (!this.smsProviderManager) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                let priceInfo = null;
                let displayPrice = ctx.session?.cheapDisplayPrice || config.prices?.cheapOtp || 0.05;
                
                try {
                    priceInfo = await this.smsProviderManager.getCheapPrice(country, service);
                    if (priceInfo?.displayPrice) {
                        displayPrice = priceInfo.displayPrice;
                        logger.info('Dynamic price fetched for CHEAP', {
                            country, service, simPrice: priceInfo.simPrice, displayPrice
                        });
                    }
                } catch (priceError) {
                    logger.warn('Dynamic price check failed, using fallback', { 
                        country, service, error: priceError.message, fallbackPrice: displayPrice 
                    });
                }

                const user = ctx.state.user;
                if (this._getAvailableBalance(user) < displayPrice) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    
                    const message = 
                        `💰 <b>Insufficient Balance</b>\n\n` +
                        `Required: ${formatCurrency(displayPrice)}\n` +
                        `Available: ${formatCurrency(this._getAvailableBalance(user))}\n\n` +
                        `Price varies by country. Please deposit more.`;
                        
                    return this.sendPhotoWithCaption(
                        ctx, IMAGES.cheapMode, message,
                        Markup.inlineKeyboard([
                            [Markup.button.callback('💳 Deposit', 'deposit')],
                            [Markup.button.callback('🔙 Back', 'menu')]
                        ]), 'HTML'
                    );
                }

                const cheapResult = await this.smsProviderManager.getCheapNumber(country, service);

                await this._safeDeleteMessage(ctx, loadingMsg);

                const session = await sessionManager.createSessionWithNumber(
                    userId, 
                    mode, 
                    service, 
                    country,
                    cheapResult.phoneNumber,
                    cheapResult.provider,
                    cheapResult.providerNumberId,
                    cheapResult.displayCost || cheapResult.cost
                );

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: CHEAP\n` +
                    `📱 Number: <code>${session.number}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: ${formatCurrency(session.cost)}\n` +
                    `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                    `⚠️ Funds locked. Will be deducted on delivery.\n` +
                    `Cancel anytime to get full refund.`;

                const keyboard = KEYBOARDS.otpActions(session.sessionId);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            // ═════════════════════════════════════════════════════════════════
            //  VIP tier (without dedicated number) — uses NumberPool ONLY
            // ═════════════════════════════════════════════════════════════════
            if (mode === 'VIP') {
                if (!this.smsProviderManager) {
                    await this._safeDeleteMessage(ctx, loadingMsg);
                    throw new Error('SMS_PROVIDER_NOT_AVAILABLE');
                }

                const user = ctx.state.user;
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: 1 } });

                const vipResult = await this.smsProviderManager.getVipNumber(country, service, userId);

                await this._safeDeleteMessage(ctx, loadingMsg);

                const session = await sessionManager.createSessionWithNumber(
                    userId, mode, service, country,
                    vipResult.phoneNumber, vipResult.provider,
                    vipResult.providerNumberId || vipResult.numberId
                );

                const message = 
                    `📱 <b>OTP Request Started</b>\n\n` +
                    `🌍 Mode: VIP\n` +
                    `📱 Number: <code>${session.number}</code>\n` +
                    `🎯 Service: ${service}\n` +
                    `⏳ Status: Waiting for OTP...\n` +
                    `💰 Cost: VIP (daily quota)\n` +
                    `⏱ Timeout: ${Math.floor((session.timeoutAt - new Date()) / 1000)}s\n\n` +
                    `⚠️ Priority delivery enabled.`;

                const keyboard = KEYBOARDS.otpActions(session.sessionId);
                const sentMessage = await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, message, keyboard, 'HTML');

                if (sentMessage?.message_id) {
                    await this._scheduleTimeoutNotification(
                        userId, session.sessionId, sentMessage.message_id, session.timeoutAt
                    );
                }

                return;
            }

            await this._safeDeleteMessage(ctx, loadingMsg);
            throw new Error(`UNKNOWN_MODE: ${mode}`);

        } catch (error) {
            await this._safeDeleteMessage(ctx, loadingMsg);

            logger.error('OTP session creation failed', { userId, mode, service, country, error: error.message });

            // Restore credits on failure
            if (mode === 'BUNDLE') {
                await User.updateOne({ userId }, { $inc: { bundleRemaining: 1 } }).catch(() => {});
            } else if (mode === 'VIP') {
                await User.updateOne({ userId }, { $inc: { vipDailyUsed: -1 } }).catch(() => {});
            }

            const errorMessages = {
                ACTIVE_SESSION_EXISTS: '⏳ You already have an active session. Use /cancel first.',
                INSUFFICIENT_BALANCE: '💰 Insufficient balance. Deposit first with /deposit',
                FREE_LIMIT_REACHED: '🆓 Free limit reached for today.',
                USER_BLACKLISTED: '🚫 Your account is suspended.',
                VIP_EXPIRED: '👑 VIP expired. Renew your subscription.',
                VIP_DAILY_LIMIT_REACHED: '⚠️ VIP daily limit (50) reached.',
                BUNDLE_EMPTY: '📦 No bundle credits left. Buy a bundle first.',
                CHEAP_PROVIDER_INACTIVE: '💰 CHEAP provider is not available. Please try FREE or upgrade to VIP.',
                CHEAP_NO_NUMBERS: '💰 No CHEAP numbers available for this country. Try another country or FREE mode.',
                CHEAP_PROVIDER_NOT_FOUND: '💰 CHEAP service not configured. Contact support.',
                FREE_PROVIDER_INACTIVE: '🆓 Free provider is not available. Please try CHEAP or VIP.',
                FREE_NO_NUMBERS: '🆓 No free numbers available. Try again later.',
                FREE_PROVIDER_NOT_FOUND: '🆓 Free service not configured. Contact support.',
                POOL_NOT_AVAILABLE: '👑 VIP pool not configured. Contact support.',
                POOL_EMPTY: '👑 No VIP numbers available. Contact support to restock.',
                SMS_PROVIDER_NOT_AVAILABLE: '🔌 SMS service temporarily unavailable. Try again later.',
                INVALID_COUNTRY: '🌍 Invalid country selected. Please try again.',
                ALL_PROVIDERS_FAILED: '❌ Service temporarily unavailable. Try again later or different country.',
                NO_PROVIDERS_AVAILABLE: '❌ No providers available. Check /status.',
                NUMBER_UNAVAILABLE: '❌ No numbers available for this country/service. Try another.',
                TIMEOUT: '⏱ Request timed out. Please try again.'
            };

            const errorKey = Object.keys(errorMessages).find(key => error.message?.includes(key));
            const displayMessage = errorMessages[errorKey] || `❌ Error: ${error.message}`;

            await this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed, 
                displayMessage,
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
                    }
                    
    
                    
        

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

    // ═══════════════════════════════════════════════════════════════════════
    //  CHECK OTP
    // ═══════════════════════════════════════════════════════════════════════

    async handleCheckOTP(ctx) {
        const userId = ctx.from.id.toString();
        const matchId = ctx.match[1];
        
        try {
            let query = { 
                userId, 
                status: { $in: ['WAITING', 'CHECKING', 'RECEIVED'] } 
            };
            
            if (!matchId.startsWith('vip_')) {
                query = { sessionId: matchId, userId };
            }
            
            const activeSession = await Session.findOne(query).sort({ createdAt: -1 });

            if (!activeSession) {
                return ctx.answerCbQuery('❌ No active OTP session found');
            }

            if (activeSession.status === 'RECEIVED' && activeSession.otpCode) {
                await ctx.answerCbQuery('✅ OTP received!');
                
                const message = 
                    `🔓 <b>OTP Received!</b>\n\n` +
                    `📱 Number: <code>${activeSession.number}</code>\n` +
                    `🎯 Service: ${activeSession.service}\n` +
                    `🔢 OTP: <code>${activeSession.otpCode}</code>\n` +
                    `🕐 Delivered: ${activeSession.endTime ? new Date(activeSession.endTime).toLocaleTimeString() : 'Just now'}\n\n` +
                    `⚠️ Do not share this code with anyone.`;

                await this.sendPhotoWithCaption(
                    ctx, IMAGES.otpReceived, message,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back to Menu', 'menu')],
                        [Markup.button.callback('📱 Request Another', 'menu')]
                    ]),
                    'HTML'
                );
                return;
            }

            const status = await sessionManager.checkSessionStatus(activeSession.sessionId);
            
            if (status.status === 'RECEIVED' && status.otpCode) {
                await Session.updateOne(
                    { sessionId: activeSession.sessionId },
                    { $set: { status: 'RECEIVED', otpCode: status.otpCode, endTime: new Date() } }
                );

                await User.updateOne({ userId }, { $inc: { totalOtps: 1 } });

                await ctx.answerCbQuery('✅ OTP received!');
                
                const message = 
                    `🔓 <b>OTP Received!</b>\n\n` +
                    `📱 Number: <code>${activeSession.number}</code>\n` +
                    `🎯 Service: ${activeSession.service}\n` +
                    `🔢 OTP: <code>${status.otpCode}</code>\n\n` +
                    `⚠️ Do not share this code with anyone.`;

                await this.sendPhotoWithCaption(
                    ctx, IMAGES.otpReceived, message,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back to Menu', 'menu')]
                    ]),
                    'HTML'
                );
                return;
            }

            const timeLeft = activeSession.timeoutAt 
                ? Math.max(0, Math.floor((new Date(activeSession.timeoutAt) - new Date()) / 1000)) 
                : 0;
            
            await ctx.answerCbQuery(`⏳ Still waiting... ${timeLeft}s left`);
            
            const costText = activeSession.mode === 'FREE' ? 'FREE' : 
                            activeSession.mode === 'BUNDLE' ? 'BUNDLE (1 credit used)' : 
                            activeSession.mode === 'VIP' ? 'VIP (daily quota)' :
                            formatCurrency(activeSession.cost);

            const updatedMessage = 
                `📱 <b>OTP Request In Progress</b>\n\n` +
                `🌍 Mode: ${activeSession.mode}\n` +
                `📱 Number: <code>${activeSession.number}</code>\n` +
                `🎯 Service: ${activeSession.service}\n` +
                `⏳ Status: <b>Still waiting...</b>\n` +
                `💰 Cost: ${costText}\n` +
                `⏱ Time Left: <code>${timeLeft}s</code>\n\n` +
                `🔍 Last checked: ${new Date().toLocaleTimeString()}`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔍 Check Again', `check_otp_${activeSession.sessionId}`)],
                [Markup.button.callback('❌ Cancel', 'cancel_otp')]
            ]);

            try {
                await this.editOrSendPhoto(ctx, IMAGES.otpRequested, updatedMessage, keyboard, 'HTML');
            } catch (editError) {
                await this.sendPhotoWithCaption(ctx, IMAGES.otpRequested, updatedMessage, keyboard, 'HTML');
            }

        } catch (error) {
            logger.error('Check OTP failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error checking OTP status');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  BUNDLE PURCHASES
    // ═══════════════════════════════════════════════════════════════════════

    async handleBuyBundle(ctx) {
        const user = ctx.state.user;
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;
        
        const message = 
            `📦 <b>Buy OTP Bundle</b>\n\n` +
            `💰 Price: ${formatCurrency(bundlePrice)}\n` +
            `📦 Includes: ${bundleCount} OTPs\n` +
            `✅ Never expires\n` +
            `💡 Best value for regular users\n\n` +
            `Your Balance: ${formatCurrency(user.balance)}`;
            
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_bundle')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);
        
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleFirst, message, keyboard, 'HTML');
    }

    async handleConfirmBundle(ctx) {
        const user = ctx.state.user;
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;
        
        if (user.balance < bundlePrice) {
            const message = 
                `❌ <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(bundlePrice)}\n` +
                `Available: ${formatCurrency(user.balance)}\n\n` +
                `Deposit first with /deposit`;
            return this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, null, 'HTML');
        }
        
        try {
            await User.updateOne(
                { userId: user.userId }, 
                { $inc: { balance: -bundlePrice, bundleRemaining: bundleCount } }
            );
            
            await Transaction.create({
                txId: `BUNDLE_MAIN_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'BUNDLE_PURCHASE',
                amount: -bundlePrice,
                status: 'COMPLETED',
                metadata: { 
                    quantity: bundleCount, 
                    pricePerOtp: bundlePrice / bundleCount,
                    source: 'MAIN_BUNDLE_MENU'
                },
                createdAt: new Date()
            });
            
            const message = 
                `✅ <b>Bundle Purchased!</b>\n\n` +
                `📦 ${bundleCount} OTPs added\n` +
                `💰 ${formatCurrency(bundlePrice)} deducted\n` +
                `📦 Total Available: ${(user.bundleRemaining || 0) + bundleCount} OTPs\n\n` +
                `Use /otp to start requesting.`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('Bundle purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, 
                '❌ Purchase failed. Please try again.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  VIP PURCHASES
    // ═══════════════════════════════════════════════════════════════════════

    async handleBuyVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        const currentVip = this._isVipActive(user);
        
        let message = 
            `👑 <b>Upgrade to VIP</b>\n\n`;
            
        if (currentVip) {
            message += 
                `✅ You already have VIP active!\n` +
                `⏰ Expires: ${new Date(user.vipExpiry).toLocaleDateString()}\n` +
                `📞 Number: ${user.vipPhoneNumber || 'Assigning...'}\n\n` +
                `Extend your subscription?`;
        } else {
            message += 
                `💰 Price: ${formatCurrency(vipPrice)}/month\n` +
                `✅ 50 OTPs per day\n` +
                `📞 Dedicated phone number\n` +
                `⚡ Priority routing\n` +
                `🚀 Fastest delivery\n\n` +
                `Your Balance: ${formatCurrency(user.balance)}`;
        }
            
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(currentVip ? '⏰ Extend VIP' : '✅ Confirm Upgrade', 'confirm_vip')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);
        
        await this.sendPhotoWithCaption(ctx, IMAGES.vipFirst, message, keyboard, 'HTML');
    }

    async handleConfirmVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        
        if (user.balance < vipPrice) {
            const message = 
                `❌ <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(vipPrice)}\n` +
                `Available: ${formatCurrency(user.balance)}\n\n` +
                `Deposit first with /deposit`;
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, 
                KEYBOARDS.depositOrBack(), 'HTML'
            );
        }
        
        const expiryDate = new Date();
        if (this._isVipActive(user) && user.vipExpiry) {
            expiryDate.setTime(new Date(user.vipExpiry).getTime());
        }
        expiryDate.setMonth(expiryDate.getMonth() + 1);
        
        try {
            await User.updateOne(
                { userId: user.userId },
                {
                    $inc: { balance: -vipPrice },
                    $set: { 
                        mode: 'VIP', 
                        vipExpiry: expiryDate, 
                        vipDailyUsed: 0, 
                        vipDailyReset: new Date() 
                    }
                }
            );

            await Transaction.create({
                txId: `VIP_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'VIP_SUBSCRIPTION',
                amount: -vipPrice,
                status: 'COMPLETED',
                metadata: { expiryDate, source: 'VIP_MENU' },
                createdAt: new Date()
            });

            const assignment = await this.assignVipNumber(user.userId, 'US');
            
            let numberText = '';
            if (assignment) {
                numberText = `\n\n📱 <b>Your VIP Number:</b> <code>${assignment.phoneNumber}</code>\n🏢 Provider: ${assignment.provider}`;
            } else {
                numberText = '\n\n⚠️ Your VIP number is being assigned. Use /mynumber to check.';
            }

            const message = 
                `👑 <b>VIP Activated!</b>\n\n` +
                `⏰ Valid until: ${expiryDate.toLocaleDateString()}\n` +
                `✅ 50 OTPs per day\n` +
                `⚡ Priority delivery enabled${numberText}\n\n` +
                `Enjoy premium service!`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 My Number', 'view_my_number')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('VIP purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, 
                '❌ VIP upgrade failed. Please try again.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    }

    async handleCancelVipSubscription(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return ctx.answerCbQuery('❌ No active VIP subscription');
        }

        const message = 
            `❌ <b>Cancel VIP Subscription?</b>\n\n` +
            `📞 Your number: <code>${user.vipPhoneNumber || 'N/A'}</code>\n` +
            `⏰ Expires: <code>${user.vipExpiry ? new Date(user.vipExpiry).toLocaleDateString() : 'N/A'}</code>\n\n` +
            `⚠️ <b>Warning:</b> Your dedicated number will be released immediately.\n\n` +
            `Are you sure?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Yes, Cancel VIP', 'confirm_vip_cancel')],
            [Markup.button.callback('❌ No, Keep VIP', 'view_my_number')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, keyboard, 'HTML');
    }

    async handleConfirmVipCancel(ctx) {
        const userId = ctx.from.id.toString();
        const user = ctx.state.user;
        
        try {
            await this.releaseVipNumber(userId);
            
            await User.updateOne(
                { userId },
                { 
                    $set: { 
                        vipExpiry: new Date(0), 
                        vipDailyUsed: 0,
                        mode: 'FREE'
                    } 
                }
            );

            const message = 
                `✅ <b>VIP Cancelled</b>\n\n` +
                `Your VIP subscription has been cancelled.\n` +
                `📞 Your dedicated number has been released.\n\n` +
                `You can still use FREE and CHEAP modes.`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('VIP cancel failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Failed to cancel VIP');
        }
    }
    // ═══════════════════════════════════════════════════════════════════════
    //  BUNDLE QUANTITY HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    async handleBuyBundleOtp(ctx) {
        const user = ctx.state.user;
        const prices = config.prices?.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        
        let message = `📦 <b>Buy Bundle OTPs</b>\n\nSelect quantity:\n\n`;
        const buttons = [];
        
        for (const [qty, price] of Object.entries(prices)) {
            message += `• <code>${qty}</code> OTPs — <code>${formatCurrency(price)}</code>\n`;
            buttons.push([Markup.button.callback(`📦 ${qty} OTPs (${formatCurrency(price)})`, `bundle_qty_${qty}`)]);
        }
        
        message += `\n💰 Your Balance: <code>${formatCurrency(user.balance)}</code>`;
        
        buttons.push(
            [Markup.button.callback('✏️ Custom Amount', 'bundle_qty_custom')],
            [Markup.button.callback('🔙 Back', 'view_my_number')]
        );
        
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleFirst, message, Markup.inlineKeyboard(buttons), 'HTML');
    }

    async handleBundleQuantity(ctx, quantity) {
        const user = ctx.state.user;
        const prices = config.prices?.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        const price = prices[quantity] || (quantity * 0.10);
        
        if (user.balance < price) {
            return this.sendPhotoWithCaption(
                ctx, IMAGES.bundleOther,
                `❌ <b>Insufficient Balance</b>\n\nRequired: <code>${formatCurrency(price)}</code>\nAvailable: <code>${formatCurrency(user.balance)}</code>\n\nDeposit first with /deposit`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'buy_bundle_otp')]
                ]),
                'HTML'
            );
        }

        ctx.session = ctx.session || {};
        ctx.session.bundlePurchase = { quantity, price };

        const message = 
            `📦 <b>Confirm Bundle Purchase</b>\n\n` +
            `Quantity: <code>${quantity}</code> OTPs\n` +
            `Price: <code>${formatCurrency(price)}</code>\n` +
            `Balance After: <code>${formatCurrency(user.balance - price)}</code>\n\n` +
            `These OTPs never expire and can be used with your VIP number.`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_bundle_purchase')],
            [Markup.button.callback('❌ Cancel', 'buy_bundle_otp')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, keyboard, 'HTML');
    }

    async handleBundleQuantityCustom(ctx) {
        ctx.session = ctx.session || {};
        ctx.session.awaitingBundleQuantity = true;
        
        await this.sendPhotoWithCaption(
            ctx, IMAGES.bundleOther,
            '✏️ <b>Custom Bundle Quantity</b>\n\nSend the number of OTPs you want to purchase:\n\n<i>Minimum: 5 | Price: $0.10 per OTP</i>',
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', 'buy_bundle_otp')]
            ]),
            'HTML'
        );
    }

    async handleConfirmBundlePurchase(ctx) {
        const user = ctx.state.user;
        const purchase = ctx.session?.bundlePurchase;
        
        if (!purchase) {
            return ctx.answerCbQuery('❌ Session expired. Please start over.');
        }

        try {
            await User.updateOne(
                { userId: user.userId },
                { $inc: { balance: -purchase.price, bundleRemaining: purchase.quantity } }
            );

            await Transaction.create({
                txId: `BUNDLE_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'BUNDLE_PURCHASE',
                amount: -purchase.price,
                status: 'COMPLETED',
                metadata: { 
                    quantity: purchase.quantity, 
                    pricePerOtp: purchase.price / purchase.quantity,
                    source: 'BUNDLE_OTP_MENU'
                },
                createdAt: new Date()
            });

            ctx.session.bundlePurchase = null;

            const message = 
                `✅ <b>Bundle Purchased!</b>\n\n` +
                `📦 <code>${purchase.quantity}</code> OTPs added\n` +
                `💰 <code>${formatCurrency(purchase.price)}</code> deducted\n` +
                `📦 Total Available: <code>${(user.bundleRemaining || 0) + purchase.quantity}</code> OTPs\n\n` +
                `Use /otp to start requesting.`;

            await this.sendPhotoWithCaption(
                ctx, IMAGES.bundleOther, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 View My Number', 'view_my_number')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );

        } catch (error) {
            logger.error('Bundle purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed,
                '❌ <b>Purchase Failed</b>\n\nPlease try again or contact support.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  REQUEST OTP VIP (direct from My Number screen)
    // ═══════════════════════════════════════════════════════════════════════

    async handleRequestOtpVip(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return ctx.answerCbQuery('❌ VIP required');
        }
        
        if (!this._canUseVip(user)) {
            return ctx.answerCbQuery('❌ Daily limit reached');
        }
        
        if (!user.vipPhoneNumber) {
            const assignment = await this.assignVipNumber(user.userId, 'US');
            if (!assignment) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.vipOther,
                    '⚠️ <b>Number Assignment Pending</b>\n\nPlease try again shortly.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry', 'request_otp_vip')],
                        [Markup.button.callback('🔙 Back', 'view_my_number')]
                    ]),
                    'HTML'
                );
            }
            user.vipPhoneNumber = assignment.phoneNumber;
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        ctx.session.useVipNumber = true;
        
        await this.showServiceSelection(ctx, 'VIP', IMAGES.vipOther);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SUPPORT & UTILITY HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    async handleContactSupport(ctx) {
        await ctx.reply(
            '📞 <b>Contact Support</b>\n\nNeed help? Contact us at @swiftsmssupport_bot\n\nOur team is available 24/7.',
            { 
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('📞 Contact @swiftsmssupport_bot', 'https://t.me/swiftsmssupport_bot')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]).reply_markup
            }
        );
    }

    async handleRevealOTP(ctx) {
        const sessionId = ctx.match[1];
        const userId = ctx.from.id.toString();
        
        try {
            const session = await Session.findOne({ sessionId, userId });
            if (!session || session.status !== 'RECEIVED') {
                return ctx.answerCbQuery('❌ OTP not available');
            }
            
            await ctx.answerCbQuery();
            
            const message = 
                `🔓 <b>Full OTP Revealed</b>\n\n` +
                `📱 Number: <code>${session.number}</code>\n` +
                `🔢 OTP: <code>${session.otpCode}</code>\n` +
                `🕐 Delivered: ${session.endTime ? new Date(session.endTime).toLocaleTimeString() : 'N/A'}\n\n` +
                `⚠️ Do not share this code with anyone.`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.otpReceived, message, null, 'HTML');
            
        } catch (error) {
            await ctx.answerCbQuery('❌ Error revealing OTP');
        }
    }

    async handleCheckDeposit(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const result = await this.walletService.checkDeposit(userId);
            
            if (!result.found) {
                const message = 
                    '⏳ <b>No Deposit Found</b>\n\n' +
                    'Your deposit hasn\'t been detected yet.\n\n' +
                    'Make sure you:\n' +
                    '1️⃣ Sent to the correct address\n' +
                    '2️⃣ Sent exactly the shown amount\n' +
                    '3️⃣ Used BSC (BEP-20) network\n\n' +
                    '⏱ Check again in 1-2 minutes.';
                
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.default, message,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Check Again', 'check_deposit')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }
            
            if (result.status === 'CONFIRMING') {
                const message = 
                    `⏳ <b>Deposit Confirming</b>\n\n` +
                    `Amount: ${formatCurrency(result.amount)}\n` +
                    `Confirmations: ${result.confirmations || 0}/${config.blockchain?.blockConfirmations || 12}\n\n` +
                    `Please wait for full confirmation.`;
                return this.sendPhotoWithCaption(ctx, IMAGES.default, message, null, 'HTML');
            }
            
            if (result.status === 'CONFIRMED' || result.status === 'CREDITED') {
                const message = 
                    `✅ <b>Deposit Confirmed!</b>\n\n` +
                    `Amount Credited: ${formatCurrency(result.amount)}\n` +
                    (result.trackingFee > 0 ? `Tracking Fee: ${formatCurrency(result.trackingFee)}\n` : '') +
                    `TX Hash: <code>${result.txHash}</code>\n\n` +
                    `Your balance has been updated.`;
                return this.sendPhotoWithCaption(ctx, IMAGES.depositConfirmed, message, null, 'HTML');
            }
        } catch (error) {
            logger.error('Check deposit failed', { userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ Error checking deposit. Please try again.');
        }
    }

    async handleDepositInfo(ctx) {
        const message = 
            '💳 <b>Deposit Information</b>\n\n' +
            'Send USDT (BEP-20) to your deposit address.\n\n' +
            'Your deposit will be credited automatically after confirmation.\n\n' +
            'Use /check_deposit to check status.';
        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, null, 'HTML');
    }

    async handleMenu(ctx) {
        return this.handleOTPCommand(ctx);
        }



            // ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 5: NEW FEATURES
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  HISTORY — View past OTP sessions
    // ═══════════════════════════════════════════════════════════════════════

    async handleHistory(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const sessions = await Session.find({ userId })
                .sort({ createdAt: -1 })
                .limit(10)
                .lean();

            if (!sessions.length) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.history,
                    '📜 <b>No History</b>\n\nYou haven\'t requested any OTPs yet.\n\nUse /otp to get started!',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('📱 Request OTP', 'menu')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }

            let message = '📜 <b>Recent OTP History</b>\n\n';
            
            for (const s of sessions) {
                const statusEmoji = {
                    RECEIVED: '✅',
                    TIMEOUT: '⏰',
                    CANCELLED: '❌',
                    WAITING: '⏳',
                    CHECKING: '🔍'
                }[s.status] || '❓';
                
                const date = new Date(s.createdAt).toLocaleDateString();
                const time = new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                
                message += `${statusEmoji} <b>${s.service}</b> — ${date} ${time}\n`;
                message += `   📱 ${this.maskPhone(s.number)} | ${s.mode}`;
                if (s.otpCode) message += ` | 🔢 ${s.otpCode}`;
                message += '\n\n';
            }

            await this.sendPhotoWithCaption(
                ctx, IMAGES.history, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );
        } catch (error) {
            logger.error('History fetch failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error loading history');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  REFERRAL — Invite friends, earn credits
    // ═══════════════════════════════════════════════════════════════════════

    async handleReferral(ctx) {
        const user = ctx.state.user;
        const botUsername = ctx.botInfo?.username || 'SwiftSMSBot';
        const referralLink = `https://t.me/${botUsername}?start=ref_${user.userId}`;
        
        const referralBonus = config.referral?.bonus || 0.50;
        const referralCount = user.referrals?.length || 0;
        const referralEarnings = user.referralEarnings || 0;

        const message = 
            `👥 <b>Referral Program</b>\n\n` +
            `Invite friends and earn <code>${formatCurrency(referralBonus)}</code> per signup!\n\n` +
            `📊 <b>Your Stats:</b>\n` +
            `• Invited: <code>${referralCount}</code> users\n` +
            `• Earned: <code>${formatCurrency(referralEarnings)}</code>\n\n` +
            `🔗 <b>Your Link:</b>\n<code>${referralLink}</code>\n\n` +
            `<i>Share this link with friends. When they make their first deposit, you get paid!</i>`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.referral, message,
            Markup.inlineKeyboard([
                [Markup.button.url('📤 Share Link', `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Get OTPs instantly with SwiftSMS!')}`)],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  STATS — User statistics dashboard
    // ═══════════════════════════════════════════════════════════════════════

    async handleStats(ctx) {
        const user = ctx.state.user;
        const stats = this._getUserStats(user);

        const totalSessions = await Session.countDocuments({ userId: user.userId });
        const successfulSessions = await Session.countDocuments({ userId: user.userId, status: 'RECEIVED' });
        const successRate = totalSessions > 0 ? Math.round((successfulSessions / totalSessions) * 100) : 0;

        const message = 
            `📊 <b>Your Statistics</b>\n\n` +
            `👤 <b>Account</b>\n` +
            `• Balance: <code>${formatCurrency(stats.balance)}</code>\n` +
            `• Available: <code>${formatCurrency(stats.available)}</code>\n\n` +
            `📱 <b>OTP Usage</b>\n` +
            `• Total Requests: <code>${totalSessions}</code>\n` +
            `• Successful: <code>${successfulSessions}</code>\n` +
            `• Success Rate: <code>${successRate}%</code>\n\n` +
            `👑 <b>VIP Status</b>\n` +
            `• Active: ${stats.isVip ? '✅ Yes' : '❌ No'}\n` +
            `• Days Left: <code>${stats.vipDays}</code>\n` +
            `• Daily Remaining: <code>${stats.vipRemaining}</code>\n\n` +
            `📦 <b>Credits</b>\n` +
            `• Free Today: <code>${stats.freeRemaining}</code>\n` +
            `• Bundle Left: <code>${stats.bundleRemaining}</code>`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.stats, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('📜 Full History', 'history')],
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  QUICK BUY — One-tap cheapest option
    // ═══════════════════════════════════════════════════════════════════════

    async handleQuickBuy(ctx) {
        const user = ctx.state.user;
        const stats = this._getUserStats(user);

        let message = '⚡ <b>Quick Buy</b>\n\n';
        const buttons = [];

        if (stats.freeRemaining > 0) {
            message += `🆓 Free OTPs available: <code>${stats.freeRemaining}</code>\n`;
            buttons.push([Markup.button.callback('🆓 Use Free OTP', 'mode_free')]);
        }

        if (stats.bundleRemaining > 0) {
            message += `📦 Bundle credits: <code>${stats.bundleRemaining}</code>\n`;
            buttons.push([Markup.button.callback('📦 Use Bundle Credit', 'mode_bundle')]);
        }

        if (stats.isVip && stats.vipRemaining > 0) {
            message += `👑 VIP daily: <code>${stats.vipRemaining}</code> left\n`;
            buttons.push([Markup.button.callback('👑 Use VIP', 'mode_vip')]);
        }

        const cheapPrice = config.prices?.cheapOtp || 0.05;
        if (stats.available >= cheapPrice) {
            message += `💰 CHEAP OTP: <code>${formatCurrency(cheapPrice)}</code>\n`;
            buttons.push([Markup.button.callback('💰 Buy CHEAP OTP', 'mode_cheap')]);
        }

        if (!buttons.length) {
            message += '❌ No credits available and insufficient balance.\n\nDeposit to continue.';
            buttons.push([Markup.button.callback('💳 Deposit', 'deposit')]);
        }

        buttons.push([Markup.button.callback('🔙 Main Menu', 'menu')]);

        await this.sendPhotoWithCaption(
            ctx, IMAGES.otpMenu, message,
            Markup.inlineKeyboard(buttons), 'HTML'
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PROVIDER STATUS — Check system health
    // ═══════════════════════════════════════════════════════════════════════

    async handleProviderStatus(ctx) {
        try {
            let statusMessage = '🔌 <b>System Status</b>\n\n';
            
            if (this.smsProviderManager) {
                const providers = await this.smsProviderManager.getProviderStatus?.() || [];
                
                for (const p of providers) {
                    const emoji = p.healthy ? '🟢' : '🔴';
                    statusMessage += `${emoji} <b>${p.name}</b>: ${p.healthy ? 'Online' : 'Offline'}`;
                    if (p.balance !== undefined) statusMessage += ` | Balance: ${formatCurrency(p.balance)}`;
                    statusMessage += '\n';
                }
            } else {
                statusMessage += '⚠️ Provider manager not available\n';
            }

            statusMessage += '\n📊 <b>General:</b>\n';
            statusMessage += `• Uptime: <code>99.9%</code>\n`;
            statusMessage += `• Avg Delivery: <code>12s</code>\n`;
            statusMessage += `• Queue: <code>Normal</code>`;

            await this.sendPhotoWithCaption(
                ctx, IMAGES.default, statusMessage,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'provider_status')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );
        } catch (error) {
            logger.error('Provider status failed', { error: error.message });
            await ctx.answerCbQuery('❌ Error checking status');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SETTINGS — User preferences
    // ═══════════════════════════════════════════════════════════════════════

    async handleSettings(ctx) {
        const user = ctx.state.user;
        
        const message = 
            `⚙️ <b>Settings</b>\n\n` +
            `🔔 Notifications: ${user.notifications !== false ? '✅ On' : '❌ Off'}\n` +
            `🌐 Language: <code>English</code>\n` +
            `💱 Currency: <code>USD</code>\n\n` +
            `Manage your preferences:`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback(`${user.notifications !== false ? '🔕' : '🔔'} Toggle Notifications`, 'toggle_notifications')],
                [Markup.button.callback('📜 Terms of Service', 'terms')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }

    async handleToggleNotifications(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const user = await User.findOne({ userId });
            const newState = !(user.notifications !== false);
            
            await User.updateOne({ userId }, { $set: { notifications: newState } });
            
            await ctx.answerCbQuery(newState ? '🔔 Notifications enabled' : '🔕 Notifications disabled');
            return this.handleSettings(ctx);
        } catch (error) {
            logger.error('Toggle notifications failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error updating settings');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FAQ — Frequently asked questions
    // ═══════════════════════════════════════════════════════════════════════

    async handleFaq(ctx) {
        const message = 
            `❓ <b>Frequently Asked Questions</b>\n\n` +
            `<b>Q: How long do I wait for an OTP?</b>\n` +
            `A: Usually 5-30 seconds. VIP/CHEAP are fastest. Free may take longer.\n\n` +
            `<b>Q: What if I don't receive my OTP?</b>\n` +
            `A: Free mode has no guarantee. For CHEAP/VIP, contact support if timed out.\n\n` +
            `<b>Q: Can I reuse my VIP number?</b>\n` +
            `A: Yes! Your VIP number is dedicated to you for the subscription period.\n\n` +
            `<b>Q: Do bundle OTPs expire?</b>\n` +
            `A: No, bundle OTPs never expire.\n\n` +
            `<b>Q: What payment methods?</b>\n` +
            `A: We accept USDT (BEP-20) on Binance Smart Chain.\n\n` +
            `<b>Q: Is there a refund policy?</b>\n` +
            `A: Free mode: no refunds. Paid modes: refunded if provider fails.\n\n` +
            `Need more help? Contact @Swiftsmssupport`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('📞 Contact Support', 'contact_support')],
                [Markup.button.callback('📜 Terms', 'terms')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TERMS — Terms of service
    // ═══════════════════════════════════════════════════════════════════════

    async handleTerms(ctx) {
        const message = 
            `📜 <b>Terms of Service</b>\n\n` +
            `By using this bot, you agree to:\n\n` +
            `1️⃣ <b>Legal Use Only</b>\n` +
            `OTP services must be used for legitimate purposes only.\n\n` +
            `2️⃣ <b>No Abuse</b>\n` +
            `Spam, harassment, or fraudulent use will result in permanent ban.\n\n` +
            `3️⃣ <b>Service Availability</b>\n` +
            `We do not guarantee 100% uptime. Free tier is best-effort.\n\n` +
            `4️⃣ <b>Refunds</b>\n` +
            `Refunds are issued only for provider failures, not user error.\n\n` +
            `5️⃣ <b>Data</b>\n` +
            `We store minimal data required for service operation.\n\n` +
            `6️⃣ <b>Changes</b>\n` +
            `Terms may change. Continued use means acceptance.\n\n` +
            `Violation of these terms may result in account suspension.`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('❓ FAQ', 'faq')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }
}

export default OTPCommands;
                
