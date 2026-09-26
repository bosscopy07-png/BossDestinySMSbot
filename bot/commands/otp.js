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
        } catch (
