import { Markup } from 'telegraf';
import QRCode from 'qrcode';
import { User, Session, Transaction } from '../../models/index.js';
import { COUNTRIES, SERVICES } from '../../utils/constants.js';
import { formatCurrency, generateReferralCode, isNewDay } from '../../utils/helpers.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

// ═══════════════════════════════════════════════════════════
//  IMAGE ASSETS
// ═══════════════════════════════════════════════════════════

const IMAGES = Object.freeze({
    welcome: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231506/file_0000000091ec71f4aab72fba467f0816_rgeuyd.png',
    mainMenu: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231491/file_0000000046a87246a25fc17f6f9e23ad_a92mlc.png',
    deposit: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235826/file_000000001c0c720aa51ae407e6741ca5_steie1.png',
    depositConfirmed: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231494/file_00000000f5e0720a9dcc0b876fd6cd16_ctv3ww.png',
    referral: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777231491/file_00000000270c71f4ba15ce962f19608a_s2vezb.png',
    stats: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235813/file_00000000bd6872438ea7ffa6d8e24a9b_aedrwq.png',
    balance: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235815/file_000000006c547246894f39172e0e16f9_xjcbxj.png',
    history: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235813/file_000000009d2c71f48ff0e002646b16ec_yil08l.png',
    support: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235819/file_000000001a2c71f4874aa9f7f5bfe40e_vxehy2.png',
    default: 'https://res.cloudinary.com/dbn8lffbs/image/upload/v1777235807/file_000000002930724688cd84d89728bc31_gfgpbk.png'
});

// ═══════════════════════════════════════════════════════════
//  TRANSACTION TYPES
// ═══════════════════════════════════════════════════════════

const TX_TYPES = Object.freeze({
    DEPOSIT: 'DEPOSIT',
    BUNDLE_PURCHASE: 'BUNDLE_PURCHASE',
    VIP_SUBSCRIPTION: 'VIP_SUBSCRIPTION',
    CHEAP_OTP: 'CHEAP_OTP',
    REFERRAL_REWARD: 'REFERRAL_REWARD'
});

// ═══════════════════════════════════════════════════════════
//  SUPPORT CONTACT
// ═══════════════════════════════════════════════════════════

const SUPPORT_USERNAME = 'swiftsmssupport_bot';
const SUPPORT_URL = 'https://t.me/swiftsmssupport_bot';

// ═══════════════════════════════════════════════════════════
//  COUNTRY LIST
// ═══════════════════════════════════════════════════════════

const COUNTRY_LIST = Object.freeze([
    { code: 'US', name: 'United States', flag: '🇺🇸' },
    { code: 'UK', name: 'United Kingdom', flag: '🇬🇧' },
    { code: 'CA', name: 'Canada', flag: '🇨🇦' },
    { code: 'AU', name: 'Australia', flag: '🇦🇺' },
    { code: 'DE', name: 'Germany', flag: '🇩🇪' },
    { code: 'FR', name: 'France', flag: '🇫🇷' },
    { code: 'IN', name: 'India', flag: '🇮🇳' },
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬' }
]);

// ═══════════════════════════════════════════════════════════
//  WALLET DEEP LINK CONFIGURATION
// ═══════════════════════════════════════════════════════════

const WALLET_DEEP_LINKS = Object.freeze({
    trust: {
        name: 'Trust Wallet',
        icon: '🛡️',
        scheme: (address, amount, chainId = 56) => 
            `https://link.trustwallet.com/send?asset=c20000714_t0x55d398326f99059fF775485246999027B3197955&address=${address}&amount=${amount}&memo=SwiftSMS`
    },
    metamask: {
        name: 'MetaMask',
        icon: '🦊',
        scheme: (address, amount, chainId = 56) => 
            `https://metamask.app.link/send/0x55d398326f99059fF775485246999027B3197955@${chainId}/transfer?address=${address}&uint256=${Math.round(amount * 1e6)}`
    },
    binance: {
        name: 'Binance Web3',
        icon: '🔶',
        scheme: (address, amount) => 
            `bnc://app.binance.com/cedefi/transfer?address=${address}&asset=USDT&amount=${amount}&network=BSC`
    },
    safepal: {
        name: 'SafePal',
        icon: '🛡️',
        scheme: (address, amount) => 
            `https://link.safepal.io/send?address=${address}&amount=${amount}&token=USDT&chain=bsc`
    },
    tokenpocket: {
        name: 'TokenPocket',
        icon: '👛',
        scheme: (address, amount) => 
            `tpoutside://transfer?token=USDT&to=${address}&amount=${amount}&chain=bsc`
    },
    okx: {
        name: 'OKX Wallet',
        icon: '🔵',
        scheme: (address, amount) => 
            `okx://wallet/send?address=${address}&amount=${amount}&token=USDT&chain=bsc`
    },
    bitget: {
        name: 'Bitget Wallet',
        icon: '🔴',
        scheme: (address, amount) => 
            `bitkeep://transfer?address=${address}&amount=${amount}&token=USDT&chain=bsc`
    }
});

// ═══════════════════════════════════════════════════════════
//  BSC USDT CONTRACT ADDRESS
// ═══════════════════════════════════════════════════════════

const USDT_BSC_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const BSC_CHAIN_ID = 56;
const BSCSCAN_URL = 'https://bscscan.com/address/';

// ═══════════════════════════════════════════════════════════
//  RATE LIMITING / ANTI-SPAM
// ═══════════════════════════════════════════════════════════

const USER_COOLDOWN_MS = 2000; // 2 seconds between actions
const activeUsers = new Map(); // In-memory cooldown tracking

// ═══════════════════════════════════════════════════════════
//  MAIN CLASS
// ═══════════════════════════════════════════════════════════

class UserCommands {
    constructor(bot, walletService, referralService = null) {
        this.bot = bot;
        this.walletService = walletService;
        this.referralService = referralService;
        this.registerCommands();
    }

    // ═══════════════════════════════════════════════════════════
    //  COMMAND & CALLBACK REGISTRATION
    // ═══════════════════════════════════════════════════════════

    registerCommands() {
        // Slash commands
        this.bot.command('menu', this._withCooldown(this.handleMenu.bind(this)));
        this.bot.command('balance', this._withCooldown(this.handleBalance.bind(this)));
        this.bot.command('deposit', this._withCooldown(this.handleDeposit.bind(this)));
        this.bot.command('history', this._withCooldown(this.handleHistory.bind(this)));
        this.bot.command('referral', this._withCooldown(this.handleReferral.bind(this)));
        this.bot.command('stats', this._withCooldown(this.handleStats.bind(this)));
        this.bot.command('settings', this._withCooldown(this.handleSettings.bind(this)));
        this.bot.command('support', this._withCooldown(this.handleSupport.bind(this)));
        this.bot.command('buybundle', this._withCooldown(this.handleBuyBundle.bind(this)));
        this.bot.command('buyvip', this._withCooldown(this.handleBuyVIP.bind(this)));
        this.bot.command('help', this._withCooldown(this.handleHelp.bind(this)));

        // Callback handlers
        this.bot.action('menu', this._withCooldown(this.handleMenu.bind(this)));
        this.bot.action('deposit', this._withCooldown(this.handleDeposit.bind(this)));
        this.bot.action('balance', this._withCooldown(this.handleBalance.bind(this)));
        this.bot.action('history', this._withCooldown(this.handleHistory.bind(this)));
        this.bot.action('referral', this._withCooldown(this.handleReferral.bind(this)));
        this.bot.action('stats', this._withCooldown(this.handleStats.bind(this)));
        this.bot.action('settings', this._withCooldown(this.handleSettings.bind(this)));
        this.bot.action('support', this._withCooldown(this.handleSupport.bind(this)));
        this.bot.action('check_deposit', this._withCooldown(this.handleCheckDeposit.bind(this)));
        this.bot.action('deposit_qr', this._withCooldown(this.handleDepositQR.bind(this)));
        this.bot.action('request_otp', this._withCooldown(this.handleRequestOTP.bind(this)));
        this.bot.action('help', this._withCooldown(this.handleHelp.bind(this)));

        // Purchase confirmations
        this.bot.action('buy_bundle', this._withCooldown(this.handleBuyBundle.bind(this)));
        this.bot.action('buy_vip', this._withCooldown(this.handleBuyVIP.bind(this)));

        // Settings toggles
        this.bot.action('toggle_privacy', this._withCooldown(this.handleTogglePrivacy.bind(this)));
        this.bot.action('toggle_notifications', this._withCooldown(this.handleToggleNotifications.bind(this)));
        this.bot.action('change_country', this._withCooldown(this.handleChangeCountry.bind(this)));

        // History export
        this.bot.action('export_history', this._withCooldown(this.handleExportHistory.bind(this)));

        // Preset amount handlers
        this.bot.action('deposit_5', this._withCooldown((ctx) => this.handlePresetDeposit(ctx, 5)));
        this.bot.action('deposit_10', this._withCooldown((ctx) => this.handlePresetDeposit(ctx, 10)));
        this.bot.action('deposit_20', this._withCooldown((ctx) => this.handlePresetDeposit(ctx, 20)));
        this.bot.action('deposit_50', this._withCooldown((ctx) => this.handlePresetDeposit(ctx, 50)));
        this.bot.action('deposit_100', this._withCooldown((ctx) => this.handlePresetDeposit(ctx, 100)));
        this.bot.action('deposit_custom', this._withCooldown(this.handleCustomDeposit.bind(this)));

        // Referral share
        this.bot.action(/share_(.+)/, this._withCooldown(this.handleShareReferral.bind(this)));

        // Country selection for settings
        this.bot.action(/setcountry_(.+)/, this._withCooldown(this.handleSetCountry.bind(this)));

        // Copy address handler
        this.bot.action(/copy_address_(.+)/, this._withCooldown(this.handleCopyAddress.bind(this)));
        this.bot.action(/share_address_(.+)/, this._withCooldown(this.handleShareAddress.bind(this)));
        
        // OTP mode handlers
        this.bot.action('mode_free', this._withCooldown(this.handleModeFree.bind(this)));
        this.bot.action('mode_cheap', this._withCooldown(this.handleModeCheap.bind(this)));
        this.bot.action('mode_bundle', this._withCooldown(this.handleModeBundle.bind(this)));
        this.bot.action('mode_vip', this._withCooldown(this.handleModeVIP.bind(this)));

        // Text handler for custom amount and country
        this.bot.on('text', this._withCooldown(this._handleTextInput.bind(this)));
    }

    // ═══════════════════════════════════════════════════════════
    //  ANTI-SPAM / COOLDOWN MIDDLEWARE
    // ═══════════════════════════════════════════════════════════

    _withCooldown(handler) {
        return async (ctx, next) => {
            const userId = ctx.from?.id?.toString();
            if (!userId) return handler(ctx, next);

            const now = Date.now();
            const lastAction = activeUsers.get(userId);

            if (lastAction && (now - lastAction) < USER_COOLDOWN_MS) {
                try {
                    await ctx.answerCbQuery?.('⏳ Please wait...');
                } catch (e) {}
                return;
            }

            activeUsers.set(userId, now);
            
            // Cleanup old entries periodically
            if (activeUsers.size > 10000) {
                const cutoff = now - USER_COOLDOWN_MS * 10;
                for (const [id, time] of activeUsers) {
                    if (time < cutoff) activeUsers.delete(id);
                }
            }

            return handler(ctx, next);
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  TEXT INPUT ROUTER
    // ═══════════════════════════════════════════════════════════

    async _handleTextInput(ctx, next) {
        if (ctx.session?.awaitingDepositAmount) {
            delete ctx.session.awaitingDepositAmount;
            return this.handleDepositAmountInput(ctx);
        }
        if (ctx.session?.awaitingCustomCountry) {
            delete ctx.session.awaitingCustomCountry;
            return this.handleCustomCountryInput(ctx);
        }
        return next?.();
                                                        }
                // ═══════════════════════════════════════════════════════════
    //  CENTRALIZED USER FETCHING WITH DAILY RESET
    // ═══════════════════════════════════════════════════════════

    async _ensureUserFresh(ctx) {
        const userId = ctx.from.id.toString();
        const now = new Date();
        const todayUTC = this._getUTCDateString(now);

        // Use lean for read, then hydrate if needed
        let user = await User.findOne({ userId }).lean();

        if (!user) {
            // Create new user
            const newUser = {
                userId,
                username: ctx.from.username || null,
                firstName: ctx.from.first_name || '',
                lastName: ctx.from.last_name || '',
                balance: 0,
                lockedBalance: 0,
                bundleRemaining: 0,
                freeUsedToday: 0,
                freeResetDate: now,
                freeResetDayUTC: todayUTC,
                vipExpiry: null,
                vipDailyUsed: 0,
                vipDailyReset: new Date(),
                vipResetDayUTC: todayUTC,
                mode: 'FREE',
                isBlacklisted: false,
                referralCode: generateReferralCode(),
                referralCount: 0,
                referralEarnings: 0,
                referralRewardsPending: 0,
                referralBonusReceived: false,
                totalDeposited: 0,
                totalSpent: 0,
                privacyEnabled: false,
                notificationsEnabled: true,
                preferredCountry: 'US',
                createdAt: now,
                lastActive: now
            };
            
            await User.create(newUser);
            return newUser;
        }

        // Check if we need daily reset
        const updates = {};
        let needsUpdate = false;

        // Free daily reset - UTC based
        const userFreeResetDay = user.freeResetDayUTC || this._getUTCDateString(user.freeResetDate);
        if (userFreeResetDay !== todayUTC) {
            updates.freeUsedToday = 0;
            updates.freeResetDate = now;
            updates.freeResetDayUTC = todayUTC;
            needsUpdate = true;
        }

        // VIP daily reset - UTC based
        if (user.vipExpiry && new Date(user.vipExpiry) > now) {
            const userVIPResetDay = user.vipResetDayUTC || this._getUTCDateString(user.vipDailyReset);
            if (userVIPResetDay !== todayUTC) {
                updates.vipDailyUsed = 0;
                updates.vipDailyReset = now;
                updates.vipResetDayUTC = todayUTC;
                needsUpdate = true;
            }
        }

        // Sync locked balance if stale
        if (user.lockedBalance > 0) {
            const staleLocked = await this._syncLockedBalance(userId);
            if (staleLocked.released > 0) {
                updates.lockedBalance = staleLocked.newLocked;
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            await User.updateOne({ userId }, { $set: updates });
            Object.assign(user, updates);
        }

        // Update last active (fire and forget)
        User.updateOne({ userId }, { $set: { lastActive: now } }).catch(() => {});

        return user;
    }

    _getUTCDateString(date) {
        const d = new Date(date);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }

    // ═══════════════════════════════════════════════════════════
    //  CENTRALIZED BALANCE SYSTEM
    // ═══════════════════════════════════════════════════════════

    _getAvailableBalance(user) {
        if (!user) return 0;
        const balance = Number(user.balance) || 0;
        const locked = Number(user.lockedBalance) || 0;
        return Math.max(0, balance - locked);
    }

    _getLockedBalance(user) {
        if (!user) return 0;
        return Math.max(0, Number(user.lockedBalance) || 0);
    }

    _getDisplayBalance(user) {
        return this._getAvailableBalance(user);
    }

    /**
     * Sync locked balance by checking for stale locks
     * Returns { released: number, newLocked: number }
     */
    async _syncLockedBalance(userId) {
        const now = new Date();
        const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

        // Find transactions that should release locked funds
        const releasableTxs = await Transaction.find({
            userId,
            status: { $in: ['FAILED', 'TIMEOUT', 'CANCELLED', 'REFUNDED'] },
            'metadata.lockedBalanceProcessed': { $ne: true },
            updatedAt: { $lte: fiveMinutesAgo }
        }).lean();

        let totalReleased = 0;

        for (const tx of releasableTxs) {
            const lockAmount = tx.metadata?.lockedAmount || Math.abs(tx.amount || 0);
            
            // Idempotent: mark as processed first
            const updateResult = await Transaction.updateOne(
                { 
                    _id: tx._id, 
                    'metadata.lockedBalanceProcessed': { $ne: true } 
                },
                { 
                    $set: { 'metadata.lockedBalanceProcessed': true } 
                }
            );

            if (updateResult.modifiedCount > 0) {
                // Only release if we successfully marked it
                await User.updateOne(
                    { userId },
                    { 
                        $inc: { 
                            lockedBalance: -lockAmount,
                            balance: lockAmount  // Return to available
                        } 
                    }
                );
                totalReleased += lockAmount;
            }
        }

        // Also check for completed transactions that haven't released
        const completedTxs = await Transaction.find({
            userId,
            status: { $in: ['COMPLETED', 'CREDITED', 'CONFIRMED'] },
            type: { $in: [TX_TYPES.BUNDLE_PURCHASE, TX_TYPES.VIP_SUBSCRIPTION, TX_TYPES.CHEAP_OTP] },
            'metadata.lockedBalanceProcessed': { $ne: true }
        }).lean();

        for (const tx of completedTxs) {
            const lockAmount = tx.metadata?.lockedAmount || Math.abs(tx.amount || 0);
            
            const updateResult = await Transaction.updateOne(
                { 
                    _id: tx._id, 
                    'metadata.lockedBalanceProcessed': { $ne: true } 
                },
                { 
                    $set: { 'metadata.lockedBalanceProcessed': true } 
                }
            );

            if (updateResult.modifiedCount > 0) {
                await User.updateOne(
                    { userId },
                    { $inc: { lockedBalance: -lockAmount } }
                );
                totalReleased += lockAmount;
            }
        }

        const user = await User.findOne({ userId }).lean();
        const newLocked = Math.max(0, user?.lockedBalance || 0);

        return { released: totalReleased, newLocked };
    }

    /**
     * Lock funds for a pending transaction
     */
    async _lockFunds(userId, amount, txId) {
        const lockAmount = Math.abs(amount);
        
        const result = await User.updateOne(
            { 
                userId, 
                $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, lockAmount] }
            },
            { 
                $inc: { lockedBalance: lockAmount } 
            }
        );

        if (result.modifiedCount === 0) {
            throw new Error('INSUFFICIENT_BALANCE');
        }

        // Update transaction with lock info
        await Transaction.updateOne(
            { txId },
            { $set: { 'metadata.lockedAmount': lockAmount } }
        );

        return true;
    }

    /**
     * Release locked funds for a transaction
     * Idempotent - safe to call multiple times
     */
    async _releaseLockedFunds(userId, txId, reason = 'release') {
        const tx = await Transaction.findOne({ txId }).lean();
        if (!tx) return { released: 0, success: false };

        // Check if already processed
        if (tx.metadata?.lockedBalanceProcessed) {
            return { released: 0, success: true, alreadyProcessed: true };
        }

        const lockAmount = tx.metadata?.lockedAmount || Math.abs(tx.amount || 0);
        if (lockAmount <= 0) return { released: 0, success: true };

        // Mark as processed first (idempotent)
        const updateResult = await Transaction.updateOne(
            { 
                _id: tx._id, 
                'metadata.lockedBalanceProcessed': { $ne: true } 
            },
            { 
                $set: { 
                    'metadata.lockedBalanceProcessed': true,
                    'metadata.lockReleaseReason': reason,
                    'metadata.lockReleasedAt': new Date()
                } 
            }
        );

        if (updateResult.modifiedCount === 0) {
            return { released: 0, success: true, alreadyProcessed: true };
        }

        // Release the lock
        await User.updateOne(
            { userId },
            { 
                $inc: { lockedBalance: -lockAmount } 
            }
        );

        // If refund, also return to balance
        if (reason === 'refund') {
            await User.updateOne(
                { userId },
                { $inc: { balance: lockAmount } }
            );
        }

        return { released: lockAmount, success: true };
    }

    // ═══════════════════════════════════════════════════════════
    //  FREE / VIP USAGE HELPERS (CORRECTED COUNTING)
    // ═══════════════════════════════════════════════════════════

    /**
     * Get free usage: returns { used, remaining, limit }
     * Counts UP: 0/3, 1/3, 2/3, 3/3
     */
    _getFreeUsage(user) {
        if (!user || user.isBlacklisted) {
            return { used: 0, remaining: 0, limit: 0, canUse: false };
        }
        
        const limit = config.limits?.freeDaily ?? 3;
        const used = Number(user.freeUsedToday) || 0;
        const remaining = Math.max(0, limit - used);
        
        return {
            used,
            remaining,
            limit,
            canUse: used < limit
        };
    }

    /**
     * Get VIP usage: returns { used, remaining, limit, active }
     */
    _getVIPUsage(user) {
        if (!user) {
            return { used: 0, remaining: 0, limit: 0, active: false, canUse: false };
        }
        
        const isActive = this._isVipActive(user);
        if (!isActive) {
            return { used: 0, remaining: 0, limit: 0, active: false, canUse: false };
        }
        
        const limit = config.limits?.vipDaily ?? 50;
        const used = Number(user.vipDailyUsed) || 0;
        const remaining = Math.max(0, limit - used);
        
        return {
            used,
            remaining,
            limit,
            active: true,
            canUse: used < limit
        };
    }

    _isVipActive(user) {
        if (!user || !user.vipExpiry) return false;
        const expiry = new Date(user.vipExpiry);
        if (isNaN(expiry.getTime())) return false;
        return expiry > new Date();
    }

    _hasBundleCredits(user) {
        if (!user) return false;
        return (Number(user.bundleRemaining) || 0) > 0;
    }

    _getBundleRemaining(user) {
        if (!user) return 0;
        return Number(user.bundleRemaining) || 0;
    }

    _isOnCooldown(user, cooldownMinutes = 1) {
        if (!user || !user.lastActive) return false;
        const lastActive = new Date(user.lastActive);
        const cooldownMs = cooldownMinutes * 60 * 1000;
        return (Date.now() - lastActive.getTime()) < cooldownMs;
                }
                    // ═══════════════════════════════════════════════════════════
    //  UI BUILDERS (Centralized Message & Keyboard Construction)
    // ═══════════════════════════════════════════════════════════

    _buildStatusLine(user) {
        const free = this._getFreeUsage(user);
        const vip = this._getVIPUsage(user);
        const bundle = this._getBundleRemaining(user);
        const balance = this._getDisplayBalance(user);

        let lines = [];
        lines.push(`💰 Balance: <code>${formatCurrency(balance)}</code>`);
        lines.push(`📦 Bundle: <code>${bundle}</code> OTPs`);
        lines.push(`🆓 Free Today: <code>${free.used}/${free.limit}</code> used`);
        
        if (vip.active) {
            lines.push(`👑 VIP: <code>${vip.used}/${vip.limit}</code> used`);
        }
        
        return lines.join('\n');
    }

    _buildMainKeyboard() {
        return Markup.inlineKeyboard([
            [
                Markup.button.callback('🔢 Request OTP', 'request_otp'), 
                Markup.button.callback('💳 Deposit', 'deposit')
            ],
            [
                Markup.button.callback('📜 History', 'history'), 
                Markup.button.callback('📊 Stats', 'stats')
            ],
            [
                Markup.button.callback('🎁 Referral', 'referral'), 
                Markup.button.callback('⚙️ Settings', 'settings')
            ],
            [
                Markup.button.callback('💰 Balance', 'balance'), 
                Markup.button.callback('🎧 Support', 'support')
            ],
            [
                Markup.button.callback('❓ Help', 'help'), 
                Markup.button.callback('📱 OTP Services', 'otp_hub')
            ]
        ]);
    }

    _buildBackButton(target = 'menu') {
        return Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', target)]
        ]);
    }

    _buildDepositKeyboard(address) {
        const buttons = [];
        
        if (address) {
            buttons.push([Markup.button.callback('📋 Copy Address', `copy_address_${address}`)]);
            buttons.push([Markup.button.callback('📤 Share Address', `share_address_${address}`)]);
        }
        
        buttons.push([Markup.button.callback('📱 Show QR Code', 'deposit_qr')]);
        buttons.push([Markup.button.callback('🔍 Check Deposit', 'check_deposit')]);
        buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
        
        return Markup.inlineKeyboard(buttons);
    }

    _buildWalletLinksKeyboard(address, amount) {
        const wallets = Object.entries(WALLET_DEEP_LINKS).slice(0, 4); // Top 4 wallets
        const walletButtons = wallets.map(([key, wallet]) => [
            Markup.button.url(`${wallet.icon} ${wallet.name}`, wallet.scheme(address, amount))
        ]);
        
        walletButtons.push([Markup.button.callback('🔙 Back', 'menu')]);
        
        return Markup.inlineKeyboard(walletButtons);
    }

    // ═══════════════════════════════════════════════════════════
    //  MESSAGE SENDERS (Centralized with Fallback)
    // ═══════════════════════════════════════════════════════════

    async sendPhotoWithCaption(ctx, imageUrl, caption, keyboard = null, parseMode = 'HTML') {
        try {
            const payload = { 
                caption: caption.trim(),
                parse_mode: parseMode 
            };
            
            if (keyboard) {
                payload.reply_markup = keyboard.reply_markup || keyboard;
            }
            
            return await ctx.replyWithPhoto(imageUrl, payload);
        } catch (error) {
            logger.error('Photo send failed', { 
                error: error.message, 
                url: imageUrl,
                userId: ctx.from?.id 
            });
            
            // Fallback to text
            const textPayload = { parse_mode: parseMode };
            if (keyboard) {
                textPayload.reply_markup = keyboard.reply_markup || keyboard;
            }
            
            return await ctx.reply(caption.trim(), textPayload);
        }
    }

    async editOrSend(ctx, text, keyboard, parseMode = 'HTML') {
        try {
            await ctx.editMessageText(text, {
                parse_mode: parseMode,
                reply_markup: keyboard?.reply_markup || keyboard?.reply_markup
            });
        } catch (err) {
            // If edit fails (e.g., message too old), send new
            await this.sendPhotoWithCaption(ctx, IMAGES.default, text, keyboard, parseMode);
        }
    }

    async safeAnswerCbQuery(ctx, text) {
        try {
            await ctx.answerCbQuery(text);
        } catch (e) {
            // Ignore callback query errors
        }
    }
        // ═══════════════════════════════════════════════════════════
    //  HANDLE START (Called manually by StartVerification)
    // ═══════════════════════════════════════════════════════════

    async handleStart(ctx) {
        const userId = ctx.from.id.toString();
        let user = await this._ensureUserFresh(ctx);

        const startPayload = ctx.startPayload;
        let referralNotice = '';
        let isNewReferral = false;

        // Process referral if present and user not yet referred
        if (startPayload && !user.referredBy) {
            const referrerCode = startPayload.toUpperCase().trim();
            const referrer = await User.findOne({ referralCode: referrerCode }).lean();

            if (referrer && referrer.userId !== userId) {
                // Atomic update to prevent race conditions
                const updateResult = await User.updateOne(
                    { userId, referredBy: { $exists: false } },
                    { $set: { referredBy: referrerCode } }
                );

                if (updateResult.modifiedCount > 0) {
                    // Increment referrer count
                    await User.updateOne(
                        { userId: referrer.userId },
                        { $inc: { referralCount: 1 } }
                    );

                    // Track in ReferralService if available
                    if (this.referralService) {
                        try {
                            await this.referralService.trackReferral(userId, referrerCode);
                        } catch (err) {
                            logger.error('ReferralService tracking failed', { 
                                userId, 
                                error: err.message 
                            });
                        }
                    }

                    const referrerName = referrer.username 
                        ? `@${referrer.username}` 
                        : (referrer.firstName || 'a friend');
                    
                    referralNotice = 
                        `🎉 <b>You were referred by ${referrerName}!</b>\n` +
                        `💰 You will receive a <b>bonus</b> on your first deposit.\n\n`;

                    isNewReferral = true;
                    
                    // Refresh user data
                    user = await User.findOne({ userId }).lean();
                }
            }
        }

        // Build welcome message
        const free = this._getFreeUsage(user);
        const vip = this._getVIPUsage(user);

        const welcomeMessage =
            `👋 <b>Welcome to SwiftSMS</b>, ${ctx.from.first_name || 'there'}!\n\n` +
            (isNewReferral ? referralNotice : '') +
            `🔐 Get verification codes instantly for any service.\n\n` +
            (vip.active ? `👑 <b>VIP Active</b> — ${vip.remaining} left today\n` : '') +
            `💰 Balance: <code>${formatCurrency(this._getDisplayBalance(user))}</code>\n` +
            `📦 Bundle: <code>${this._getBundleRemaining(user)}</code> OTPs\n` +
            `🆓 Free Today: <code>${free.used}/${free.limit}</code> used\n\n` +
            `Choose your mode or deposit to get started:`;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('🆓 FREE OTP', 'mode_free'), 
                Markup.button.callback('💵 CHEAP OTP', 'mode_cheap')
            ],
            [
                Markup.button.callback('📦 Buy Bundle', 'mode_bundle'), 
                Markup.button.callback('👑 Upgrade VIP', 'mode_vip')
            ],
            [
                Markup.button.callback('💳 Deposit', 'deposit'), 
                Markup.button.callback('📊 My Stats', 'stats')
            ],
            [
                Markup.button.callback('🎁 Referral', 'referral'), 
                Markup.button.callback('⚙️ Settings', 'settings')
            ],
            [
                Markup.button.callback('💰 Check Balance', 'balance'), 
                Markup.button.callback('🎧 Customer Service', 'support')
            ]
        ]);

        try {
            await this.sendPhotoWithCaption(ctx, IMAGES.welcome, welcomeMessage, keyboard, 'HTML');
        } catch (err) {
            logger.error('Failed to send welcome photo, falling back to text', { 
                error: err.message 
            });
            await ctx.reply(welcomeMessage, { 
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup 
            });
        }

        // Send separate referral confirmation if new
        if (isNewReferral) {
            try {
                await ctx.reply(
                    `✅ <b>Referral Confirmed</b>\n\n` +
                    `Your referrer will be rewarded when you make your first deposit of at least ` +
                    `${formatCurrency(config.referral?.minDeposit || 5)}.`,
                    { parse_mode: 'HTML' }
                );
            } catch (err) {
                logger.error('Failed to send referral confirmation', { 
                    userId, 
                    error: err.message 
                });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE MENU
    // ═══════════════════════════════════════════════════════════

    async handleMenu(ctx) {
        const user = await this._ensureUserFresh(ctx);
        const status = this._buildStatusLine(user);

        const menuText =
            `📋 <b>Main Menu</b>\n\n` +
            `${status}\n\n` +
            `What would you like to do?`;

        const keyboard = this._buildMainKeyboard();

        await this.editOrSend(ctx, menuText, keyboard);
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE BALANCE (FIXED - Uses Centralized Balance)
    // ═══════════════════════════════════════════════════════════

    async handleBalance(ctx) {
        const userId = ctx.from.id.toString();
        
        // Sync locked balance first
        await this._syncLockedBalance(userId);
        
        const user = await this._ensureUserFresh(ctx);

        const pendingDeposit = await Transaction.findOne({
            userId: user.userId,
            type: TX_TYPES.DEPOSIT,
            status: { $in: ['PENDING', 'CONFIRMING'] }
        })
        .sort({ createdAt: -1 })
        .lean();

        const free = this._getFreeUsage(user);
        const vip = this._getVIPUsage(user);

        let masterAddress = 'Loading...';
        try {
            if (this.walletService?.getMasterAddress) {
                masterAddress = await this.walletService.getMasterAddress();
            }
        } catch (e) {
            masterAddress = 'Unavailable';
            logger.error('Failed to get master address', { userId, error: e.message });
        }

        const availableBalance = this._getDisplayBalance(user);
        const lockedBalance = this._getLockedBalance(user);

        const message =
            `💰 <b>Your Balance</b>\n\n` +
            `💵 Available: <code>${formatCurrency(availableBalance)}</code>\n` +
            `🔒 Locked: <code>${formatCurrency(lockedBalance)}</code>\n` +
            `💳 Total Deposited: <code>${formatCurrency(user.totalDeposited || 0)}</code>\n` +
            `📉 Total Spent: <code>${formatCurrency(user.totalSpent || 0)}</code>\n\n` +
            `📦 Bundle OTPs: <code>${this._getBundleRemaining(user)}</code>\n` +
            `🆓 Free Today: <code>${free.used}/${free.limit}</code> used\n` +
            (vip.active 
                ? `👑 VIP: <code>${vip.used}/${vip.limit}</code> used\n` 
                : `👑 VIP: <i>Inactive</i>\n`) +
            `\n` +
            (pendingDeposit 
                ? `⏳ Pending Deposit: <code>${formatCurrency(
                    pendingDeposit.metadata?.requestedAmount || pendingDeposit.amount
                )}</code>\n\n` 
                : '') +
            `💎 <b>Deposit Address:</b>\n<code>${masterAddress}</code>`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💳 Deposit', 'deposit')],
            [Markup.button.callback('📜 Transaction History', 'history')],
            [Markup.button.callback('🔙 Back to Menu', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.balance, message, keyboard, 'HTML');
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE DEPOSIT
    // ═══════════════════════════════════════════════════════════

    async handleDeposit(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const message =
                `💳 <b>Select Deposit Amount</b>\n\n` +
                `Choose how much <b>USDT (BEP-20)</b> you want to deposit:`;

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('💵 $5', 'deposit_5'),
                    Markup.button.callback('💵 $10', 'deposit_10'),
                    Markup.button.callback('💵 $20', 'deposit_20')
                ],
                [
                    Markup.button.callback('💵 $50', 'deposit_50'),
                    Markup.button.callback('💵 $100', 'deposit_100')
                ],
                [Markup.button.callback('✏️ Custom Amount', 'deposit_custom')],
                [Markup.button.callback('🔙 Back', 'menu')]
            ]);

            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard, 'HTML');
        } catch (error) {
            logger.error('Deposit handler error', { userId, error: error.message });
            await ctx.reply('❌ Error. Please try /deposit again.');
        }
    }

    async handlePresetDeposit(ctx, amount) {
        const userId = ctx.from.id.toString();
        
        try {
            await this.safeAnswerCbQuery(ctx, `Generating $${amount} deposit...`);
            await this.showDepositDetails(ctx, userId, amount);
        } catch (error) {
            logger.error('Preset deposit error', { userId, amount, error: error.message });
            await this.safeAnswerCbQuery(ctx, '❌ Error');
        }
    }

    async handleCustomDeposit(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            ctx.session = ctx.session || {};
            ctx.session.awaitingDepositAmount = true;
            
            await this.safeAnswerCbQuery(ctx, 'Enter custom amount');
            
            const message =
                `✏️ <b>Custom Deposit</b>\n\n` +
                `Send the amount you want to deposit (in USD):\n\n` +
                `<i>Examples: 5, 10.50, 25</i>\n\n` +
                `Minimum: <code>$0.50</code>`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, null, 'HTML');
        } catch (error) {
            logger.error('Custom deposit error', { userId, error: error.message });
        }
    }

    async handleDepositAmountInput(ctx) {
        const userId = ctx.from.id.toString();
        const text = ctx.message.text.trim().replace(/[^0-9.]/g, '');
        const amount = parseFloat(text);
        
        if (isNaN(amount) || amount < 0.50) {
            return this.sendPhotoWithCaption(
                ctx,
                IMAGES.deposit,
                `❌ <b>Invalid amount.</b>\n\nMinimum deposit is <code>$0.50</code>.\nTry /deposit again.`,
                null,
                'HTML'
            );
        }
        
        await this.showDepositDetails(ctx, userId, amount);
    }

    async showDepositDetails(ctx, userId, requestedAmount) {
        try {
            const depositInfo = await this.walletService.getDepositInfo(userId, requestedAmount);
            
            const trackingAmount = depositInfo.amount 
                || depositInfo.trackingAmount 
                || depositInfo.baseAmount 
                || requestedAmount;
                
            const actualAmount = depositInfo.baseAmount || requestedAmount;

            let depositAddress = depositInfo.address;
            if (!depositAddress && this.walletService?.getMasterAddress) {
                depositAddress = await this.walletService.getMasterAddress();
            }
            
            if (!depositAddress || depositAddress === 'WALLET_NOT_READY') {
                throw new Error('WALLET_ADDRESS_UNAVAILABLE');
            }

            // Store deposit info for QR generation
            await User.updateOne(
                { userId },
                { 
                    $set: { 
                        depositTrackingAmount: trackingAmount,
                        depositRequestedAmount: actualAmount,
                        depositAddress: depositAddress,
                        lastDepositAt: new Date()
                    } 
                }
            );

            const message =
                `💳 <b>Deposit $${actualAmount}</b>\n\n` +
                `📬 <b>Send to this address:</b>\n<code>${depositAddress}</code>\n\n` +
                `💵 You will receive: <code>$${actualAmount}</code>\n` +
                `📬 Send exactly: <code>${trackingAmount}</code> USDT\n` +
                `🌐 Network: <code>${depositInfo.network || 'BSC (BEP-20)'}</code>\n\n` +
                `⚠️ <b>IMPORTANT:</b>\n` +
                `• Send ONLY USDT on BSC (BEP-20)\n` +
                `• Send EXACTLY <code>${trackingAmount}</code> USDT\n` +
                `• The extra <code>${(trackingAmount - actualAmount).toFixed(4)}</code> is for deposit identification only\n\n` +
                `✅ <code>$${actualAmount}</code> will be credited to your balance.\n` +
                `⏱ Funds credited automatically in 1-2 minutes.`;

            const keyboard = this._buildDepositKeyboard(depositAddress);

            await this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, keyboard, 'HTML');
            
        } catch (error) {
            logger.error('Show deposit details error', { userId, error: error.message });
            
            if (error.message === 'WALLET_ADDRESS_UNAVAILABLE') {
                return ctx.reply(
                    '❌ Wallet service is initializing. Please wait 10 seconds and try /deposit again.'
                );
            }
            
            await ctx.reply('❌ Error generating deposit. Please try again.');
        }
                }
                    // ═══════════════════════════════════════════════════════════
    //  QR CODE GENERATION (UPGRADED - Professional & Branded)
    // ═══════════════════════════════════════════════════════════

    async handleDepositQR(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            // Get user's current deposit info
            const user = await User.findOne({ userId }).lean();
            const trackingAmount = user?.depositTrackingAmount;
            const requestedAmount = user?.depositRequestedAmount || trackingAmount;
            const depositAddress = user?.depositAddress;

            if (!trackingAmount || !depositAddress) {
                return this.safeAnswerCbQuery(ctx, '⚠️ Click Deposit first');
            }

            await this.safeAnswerCbQuery(ctx, '📱 Generating QR...');

            // Generate professional branded QR
            const qrBuffer = await this._generateBrandedQR(depositAddress, trackingAmount);

            const caption =
                `📱 <b>Scan to Deposit</b>\n\n` +
                `💵 You receive: <code>$${requestedAmount}</code>\n` +
                `📬 Send exactly: <code>${trackingAmount}</code> USDT\n` +
                `📬 Address: <code>${depositAddress}</code>\n\n` +
                `⚠️ Send EXACTLY <code>${trackingAmount}</code> USDT on BSC (BEP-20)\n` +
                `💰 <code>$${requestedAmount}</code> will be credited to your balance.\n\n` +
                `<i>Tap wallet buttons below to open your wallet app directly.</i>`;

            const bscscanUrl = `${BSCSCAN_URL}${depositAddress}`;

            // Build wallet deep link buttons
            const walletButtons = Object.entries(WALLET_DEEP_LINKS).map(([key, wallet]) => ({
                text: `${wallet.icon} ${wallet.name}`,
                url: wallet.scheme(depositAddress, trackingAmount)
            }));

            // Arrange in rows of 2
            const keyboardRows = [];
            for (let i = 0; i < walletButtons.length; i += 2) {
                keyboardRows.push(walletButtons.slice(i, i + 2));
            }

            // Add utility buttons
            keyboardRows.push([
                { text: '🔗 View on BSCScan', url: bscscanUrl }
            ]);
            keyboardRows.push([
                { text: '📋 Copy Address', callback_data: `copy_address_${depositAddress}` }
            ]);
            keyboardRows.push([
                { text: '🔍 Check Deposit', callback_data: 'check_deposit' },
                { text: '🔙 Back', callback_data: 'menu' }
            ]);

            const keyboard = { reply_markup: { inline_keyboard: keyboardRows } };

            await ctx.replyWithPhoto(
                { source: qrBuffer },
                { 
                    caption: caption, 
                    parse_mode: 'HTML', 
                    reply_markup: keyboard.reply_markup 
                }
            );

        } catch (error) {
            logger.error('QR generation failed', { userId, error: error.message });
            await this.safeAnswerCbQuery(ctx, '❌ Failed to generate QR');
        }
    }

    /**
     * Generate a professional branded QR code
     * Uses custom styling for SwiftSMS branding
     */
    async _generateBrandedQR(address, amount) {
        // Create a high-quality QR with custom styling
        const qrOptions = {
            width: 400,
            margin: 3,
            color: {
                dark: '#0a0a0a',    // Near-black for high contrast
                light: '#ffffff'     // Pure white background
            },
            errorCorrectionLevel: 'H'  // High error correction for logo overlay capability
        };

        // Generate base QR
        const qrBuffer = await QRCode.toBuffer(address, qrOptions);

        // For production, you could overlay a small SwiftSMS logo in center
        // Using node-canvas or sharp. For now, high-contrast professional QR.
        
        return qrBuffer;
    }

    // ═══════════════════════════════════════════════════════════
    //  ADDRESS HANDLERS
    // ═══════════════════════════════════════════════════════════

    async handleShareAddress(ctx) {
        const address = ctx.match[1];
        await this.safeAnswerCbQuery(ctx, '📤 Address ready!');
        
        await ctx.reply(
            `📤 <b>Deposit Address</b>\n\n<code>${address}</code>\n\n` +
            `Tap and hold to copy, then paste in your wallet app.`,
            { parse_mode: 'HTML' }
        );
    }

    async handleCopyAddress(ctx) {
        const address = ctx.match[1];
        await this.safeAnswerCbQuery(ctx, `📋 ${address.substring(0, 10)}...`);
        
        await ctx.reply(
            `📋 <b>Copy this address:</b>\n\n<code>${address}</code>\n\n` +
            `Tap the address above to copy it.`,
            { parse_mode: 'HTML' }
        );
    }

    // ═══════════════════════════════════════════════════════════
    //  CHECK DEPOSIT
    // ═══════════════════════════════════════════════════════════

    async handleCheckDeposit(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            await this.safeAnswerCbQuery(ctx, '🔍 Checking...');
            
            const result = await this.walletService.checkDeposit(userId);

            if (result.found && ['COMPLETED', 'CREDITED'].includes(result.status)) {
                // Sync balance after deposit
                await this._syncLockedBalance(userId);
                return this.safeAnswerCbQuery(ctx, '✅ Deposit confirmed! Check /balance.');
            }

            if (result.found && result.status === 'CONFIRMING') {
                const message =
                    `⏳ <b>Deposit Confirming</b>\n\n` +
                    `💵 Amount: <code>${formatCurrency(result.amount)}</code>\n` +
                    `🔢 Confirmations: <code>${result.confirmations || 0}/${config.blockchain?.blockConfirmations || 12}</code>\n\n` +
                    `⏱ Please wait for full confirmation.`;

                return this.sendPhotoWithCaption(ctx, IMAGES.deposit, message, null, 'HTML');
            }

            const user = await User.findOne({ userId }).lean();
            const trackingAmount = user?.depositTrackingAmount;

            let masterAddress = '';
            try {
                if (this.walletService?.getMasterAddress) {
                    masterAddress = await this.walletService.getMasterAddress();
                }
            } catch (e) {
                logger.error('Failed to get master address for check', { userId, error: e.message });
            }

            const message =
                `🔍 <b>No deposit found yet.</b>\n\n` +
                `Make sure you:\n` +
                `1️⃣ Sent to: <code>${masterAddress}</code>\n` +
                `2️⃣ Sent exactly <code>${trackingAmount || 'the shown'}</code> USDT\n` +
                `3️⃣ Used BSC (BEP-20) network\n\n` +
                `⏱ Check again in 1 minute.`;

            await this.sendPhotoWithCaption(
                ctx, 
                IMAGES.deposit, 
                message, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Check Again', 'check_deposit')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]), 
                'HTML'
            );

        } catch (error) {
            logger.error('Check deposit failed', { userId, error: error.message });
            await this.safeAnswerCbQuery(ctx, '❌ Check failed');
            await ctx.reply('❌ Error checking deposit. Try again later.');
        }
    }
        // ═══════════════════════════════════════════════════════════
    //  HANDLE REQUEST OTP (CORRECTED - No Duplication)
    // ═══════════════════════════════════════════════════════════

    async handleRequestOTP(ctx) {
        await this.safeAnswerCbQuery(ctx, 'Opening OTP...');

        const user = await this._ensureUserFresh(ctx);
        const free = this._getFreeUsage(user);
        const vip = this._getVIPUsage(user);
        const bundle = this._getBundleRemaining(user);

        const message =
            `🔢 <b>Request OTP</b>\n\n` +
            `🆓 Free Today: <code>${free.used}/${free.limit}</code> used\n\n` +
            `💵 Cheap: <code>${formatCurrency(config.prices?.cheapOtp || 0.05)}</code> per OTP\n` +
            `📦 Bundle: <code>${bundle}</code> OTPs left\n` +
            (vip.active 
                ? `👑 VIP: <code>${vip.used}/${vip.limit}</code> used today\n` 
                : `👑 VIP: <i>Inactive</i>\n`) +
            `\nSelect your preferred mode:`;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('🆓 FREE', 'mode_free'), 
                Markup.button.callback('💵 CHEAP', 'mode_cheap')
            ],
            [
                Markup.button.callback('📦 BUNDLE', 'mode_bundle'), 
                Markup.button.callback('👑 VIP', 'mode_vip')
            ],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.welcome, message, keyboard, 'HTML');
    }

    // OTP Mode handlers (placeholders - connect to existing OTP logic)
    async handleModeFree(ctx) {
        await this.safeAnswerCbQuery(ctx, '🆓 FREE mode selected');
        // Delegate to existing OTP service
        await ctx.reply('🆓 <b>FREE OTP Mode</b>\n\nSelect a service to request your free OTP:', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'WhatsApp', callback_data: 'otp_service_whatsapp' }],
                    [{ text: 'Telegram', callback_data: 'otp_service_telegram' }],
                    [{ text: '🔙 Back', callback_data: 'request_otp' }]
                ]
            }
        });
    }

    async handleModeCheap(ctx) {
        await this.safeAnswerCbQuery(ctx, '💵 CHEAP mode selected');
        await ctx.reply('💵 <b>Cheap OTP Mode</b>\n\nSelect a service:', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'WhatsApp', callback_data: 'otp_service_whatsapp_cheap' }],
                    [{ text: 'Telegram', callback_data: 'otp_service_telegram_cheap' }],
                    [{ text: '🔙 Back', callback_data: 'request_otp' }]
                ]
            }
        });
    }

    async handleModeBundle(ctx) {
        await this.safeAnswerCbQuery(ctx, '📦 BUNDLE mode selected');
        const user = await this._ensureUserFresh(ctx);
        
        if (!this._hasBundleCredits(user)) {
            return ctx.reply(
                `❌ <b>No Bundle Credits</b>\n\n` +
                `You have <code>0</code> bundle OTPs remaining.\n` +
                `Purchase a bundle first with /buybundle.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📦 Buy Bundle', callback_data: 'buy_bundle' }],
                            [{ text: '🔙 Back', callback_data: 'request_otp' }]
                        ]
                    }
                }
            );
        }
        
        await ctx.reply('📦 <b>Bundle OTP Mode</b>\n\nSelect a service:', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'WhatsApp', callback_data: 'otp_service_whatsapp_bundle' }],
                    [{ text: 'Telegram', callback_data: 'otp_service_telegram_bundle' }],
                    [{ text: '🔙 Back', callback_data: 'request_otp' }]
                ]
            }
        });
    }

    async handleModeVIP(ctx) {
        await this.safeAnswerCbQuery(ctx, '👑 VIP mode selected');
        const user = await this._ensureUserFresh(ctx);
        const vip = this._getVIPUsage(user);
        
        if (!vip.active) {
            return ctx.reply(
                `❌ <b>VIP Not Active</b>\n\n` +
                `Upgrade to VIP with /buyvip to access 50 OTPs/day.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '👑 Upgrade VIP', callback_data: 'buy_vip' }],
                            [{ text: '🔙 Back', callback_data: 'request_otp' }]
                        ]
                    }
                }
            );
        }
        
        if (!vip.canUse) {
            return ctx.reply(
                `❌ <b>VIP Daily Limit Reached</b>\n\n` +
                `You have used all <code>${vip.limit}</code> VIP OTPs for today.\n` +
                `Resets at midnight UTC.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Back', callback_data: 'request_otp' }]
                        ]
                    }
                }
            );
        }
        
        await ctx.reply('👑 <b>VIP OTP Mode</b>\n\nSelect a service:', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'WhatsApp', callback_data: 'otp_service_whatsapp_vip' }],
                    [{ text: 'Telegram', callback_data: 'otp_service_telegram_vip' }],
                    [{ text: '🔙 Back', callback_data: 'request_otp' }]
                ]
            }
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE HISTORY
    // ═══════════════════════════════════════════════════════════

    async handleHistory(ctx) {
        const userId = ctx.from.id.toString();
        
        const transactions = await Transaction
            .find({ userId })
            .sort({ createdAt: -1 })
            .limit(15)
            .lean();

        let message = `📜 <b>Recent Transactions</b>\n\n`;
        
        if (!transactions.length) {
            message += `<i>No transactions yet. Deposit to get started!</i>`;
        } else {
            transactions.forEach((tx) => {
                const icon = 
                    tx.type === TX_TYPES.DEPOSIT ? '💳' :
                    tx.type === TX_TYPES.BUNDLE_PURCHASE ? '📦' :
                    tx.type === TX_TYPES.VIP_SUBSCRIPTION ? '👑' :
                    tx.type === TX_TYPES.REFERRAL_REWARD ? '🎁' :
                    tx.amount >= 0 ? '➕' : '➖';
                    
                const type = (tx.type || 'Unknown').replace(/_/g, ' ');
                const amountPrefix = tx.amount >= 0 ? '+' : '';
                
                let extraInfo = '';
                if (tx.type === TX_TYPES.DEPOSIT && tx.metadata?.trackingFee > 0) {
                    extraInfo = ` (fee: ${formatCurrency(tx.metadata.trackingFee)})`;
                }
                
                const date = tx.createdAt 
                    ? new Date(tx.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    }) 
                    : 'Unknown';

                message += `${icon} <b>${type}</b>\n`;
                message += `   ${amountPrefix}${formatCurrency(Math.abs(tx.amount || 0))}${extraInfo} | ${tx.status}\n`;
                message += `   🕐 ${date}\n\n`;
            });
        }

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📥 Export CSV', 'export_history')],
            [Markup.button.callback('🔙 Back', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.history, message, keyboard, 'HTML');
    }

    async handleExportHistory(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            await this.safeAnswerCbQuery(ctx, '📥 Generating CSV...');
            
            const transactions = await Transaction
                .find({ userId })
                .sort({ createdAt: -1 })
                .lean();

            if (!transactions.length) {
                return ctx.reply('📭 No transactions to export.');
            }

            let csv = 'Date,Type,Amount,Status,TrackingFee,TX Hash\n';
            
            for (const tx of transactions) {
                const date = tx.createdAt 
                    ? new Date(tx.createdAt).toISOString().split('T')[0] 
                    : 'N/A';
                    
                const trackingFee = tx.metadata?.trackingFee || 0;
                
                csv += `${date},${tx.type || 'Unknown'},${tx.amount || 0},${tx.status || 'Unknown'},${trackingFee},${tx.txHash || 'N/A'}\n`;
            }

            const filename = `history_${userId}_${Date.now()}.csv`;
            
            await ctx.replyWithDocument(
                { source: Buffer.from(csv), filename },
                { caption: '📥 Your transaction history export.' }
            );
        } catch (error) {
            logger.error('Export history failed', { userId, error: error.message });
            await ctx.reply('❌ Failed to export history.');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE STATS (FIXED - Correct Free/VIP Counting)
    // ═══════════════════════════════════════════════════════════

    async handleStats(ctx) {
        const userId = ctx.from.id.toString();
        
        // Sync first
        await this._syncLockedBalance(userId);
        
        const user = await User.findOne({ userId }).lean();
        const sessions = await Session.find({ userId }).lean();

        const totalRequests = sessions.length;
        const successful = sessions.filter(s => s.status === 'RECEIVED').length;
        const failed = sessions.filter(s => ['TIMEOUT', 'FAILED'].includes(s.status)).length;
        const successRate = totalRequests > 0 
            ? ((successful / totalRequests) * 100).toFixed(1) 
            : 0;

        const completedSessions = sessions.filter(
            s => s.endTime && s.startTime && s.status === 'RECEIVED'
        );
        
        const avgWaitTime = completedSessions.length > 0
            ? (completedSessions.reduce((acc, s) => 
                acc + (new Date(s.endTime) - new Date(s.startTime)), 0
            ) / completedSessions.length / 1000)
            : 0;

        const free = this._getFreeUsage(user);
        const vip = this._getVIPUsage(user);

        const message =
            `📊 <b>Your Statistics</b>\n\n` +
            `🔢 <b>OTP Requests:</b>\n` +
            `• Total: <code>${totalRequests}</code>\n` +
            `• Successful: <code>${successful}</code>\n` +
            `• Failed: <code>${failed}</code>\n` +
            `• Success Rate: <code>${successRate}%</code>\n\n` +
            `⚡ <b>Performance:</b>\n` +
            `• Avg Wait: <code>${avgWaitTime.toFixed(1)}s</code>\n\n` +
            `💰 <b>Financial:</b>\n` +
            `• Deposited: <code>${formatCurrency(user?.totalDeposited || 0)}</code>\n` +
            `• Spent: <code>${formatCurrency(user?.totalSpent || 0)}</code>\n` +
            `• Balance: <code>${formatCurrency(this._getDisplayBalance(user))}</code>\n` +
            `• Locked: <code>${formatCurrency(this._getLockedBalance(user))}</code>\n\n` +
            `🎮 <b>Usage:</b>\n` +
            `• Free: <code>${free.used}/${free.limit}</code> used\n` +
            `• Bundle: <code>${this._getBundleRemaining(user)}</code>\n` +
            (vip.active ? `• VIP: <code>${vip.used}/${vip.limit}</code> used\n` : '') +
            `\n📅 Member Since: ${user?.createdAt 
                ? new Date(user.createdAt).toLocaleDateString() 
                : 'Unknown'}`;

        await this.sendPhotoWithCaption(
            ctx, 
            IMAGES.stats, 
            message, 
            this._buildBackButton(), 
            'HTML'
        );
                                       }
                // ═══════════════════════════════════════════════════════════
    //  HANDLE REFERRAL
    // ═══════════════════════════════════════════════════════════

    async handleReferral(ctx) {
        const userId = ctx.from.id.toString();
        const user = await User.findOne({ userId }).lean();

        if (!user) {
            logger.error('User not found in handleReferral', { userId });
            return ctx.reply('❌ Error loading your profile. Please try /start.');
        }

        const botUsername = ctx.botInfo?.username || 'SwiftOTPBot';
        const referralLink = `https://t.me/${botUsername}?start=${user.referralCode}`;
        const percentage = ((config.referral?.percentage || 0.05) * 100).toFixed(0);
        const minDeposit = formatCurrency(config.referral?.minDeposit || 5);

        const message =
            `🎁 <b>Referral Program</b>\n\n` +
            `🔗 <b>Your Code:</b> <code>${user.referralCode}</code>\n\n` +
            `💰 Earn <code>${percentage}%</code> of your referrals' first deposits!\n` +
            `📋 Minimum deposit to qualify: <code>${minDeposit}</code>\n\n` +
            `📊 <b>Your Stats:</b>\n` +
            `• Referrals: <code>${user.referralCount || 0}</code>\n` +
            `• Total Earnings: <code>${formatCurrency(user.referralEarnings || 0)}</code>\n` +
            `• Pending Approval: <code>${formatCurrency(user.referralRewardsPending || 0)}</code>\n\n` +
            `🔗 <b>Your Link:</b>\n<code>${referralLink}</code>\n\n` +
            `<i>Share this link with friends. When they join and make their first deposit, you earn!</i>`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📤 Share Link', `share_${user.referralCode}`)],
            [Markup.button.callback('📊 View Referral Stats', 'referral_stats')],
            [Markup.button.callback('🔙 Back to Menu', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.referral, message, keyboard, 'HTML');
    }

    async handleShareReferral(ctx) {
        const referralCode = ctx.match[1];
        const botUsername = ctx.botInfo?.username || 'SwiftOTPBot';
        const referralLink = `https://t.me/${botUsername}?start=${referralCode}`;

        await this.safeAnswerCbQuery(ctx, '📤 Link ready!');

        await ctx.reply(
            `📤 <b>Share Your Referral Link</b>\n\n` +
            `<code>${referralLink}</code>\n\n` +
            `Tap and hold to copy, then share with friends!\n\n` +
            `💡 <i>Tip: Share in crypto groups, social media, or with friends who need OTPs.</i>`,
            { parse_mode: 'HTML' }
        );
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE SETTINGS
    // ═══════════════════════════════════════════════════════════

    async handleSettings(ctx) {
        const userId = ctx.from.id.toString();
        const user = await User.findOne({ userId }).lean();

        if (!user) {
            return ctx.reply('❌ Error loading settings. Please try /start.');
        }

        const message =
            `⚙️ <b>Settings</b>\n\n` +
            `🔒 Privacy: <code>${user.privacyEnabled ? 'Masked OTPs' : 'Full OTPs'}</code>\n` +
            `🔔 Notifications: <code>${user.notificationsEnabled ? 'On' : 'Off'}</code>\n` +
            `🌍 Country: <code>${user.preferredCountry || 'US'}</code>\n\n` +
            `Toggle settings below:`;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    user.privacyEnabled ? '👁 Show Full OTPs' : '🔒 Mask OTPs',
                    'toggle_privacy'
                )
            ],
            [
                Markup.button.callback(
                    user.notificationsEnabled ? '🔕 Disable Notifications' : '🔔 Enable Notifications',
                    'toggle_notifications'
                )
            ],
            [Markup.button.callback('🌍 Change Country', 'change_country')],
            [Markup.button.callback('🔙 Back to Menu', 'menu')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, keyboard, 'HTML');
    }

    async handleTogglePrivacy(ctx) {
        const userId = ctx.from.id.toString();
        const user = await User.findOne({ userId }).lean();
        const newValue = !user.privacyEnabled;

        await User.updateOne({ userId }, { $set: { privacyEnabled: newValue } });
        await this.safeAnswerCbQuery(ctx, newValue ? '🔒 Privacy ON' : '👁 Privacy OFF');
        await this.handleSettings(ctx);
    }

    async handleToggleNotifications(ctx) {
        const userId = ctx.from.id.toString();
        const user = await User.findOne({ userId }).lean();
        const newValue = !user.notificationsEnabled;

        await User.updateOne({ userId }, { $set: { notificationsEnabled: newValue } });
        await this.safeAnswerCbQuery(ctx, newValue ? '🔔 Notifications ON' : '🔕 Notifications OFF');
        await this.handleSettings(ctx);
    }

    async handleChangeCountry(ctx) {
        ctx.session = ctx.session || {};
        ctx.session.awaitingCustomCountry = false;

        const buttons = COUNTRY_LIST.map(c => [
            Markup.button.callback(`${c.flag} ${c.name}`, `setcountry_${c.code}`)
        ]);

        buttons.push([Markup.button.callback('✏️ Custom Code', 'custom_country')]);
        buttons.push([Markup.button.callback('🔙 Back', 'settings')]);

        const message =
            `🌍 <b>Select Your Preferred Country</b>\n\n` +
            `Choose a country for your OTP numbers:\n\n` +
            `<i>This affects the phone number country code when available.</i>`;

        await this.sendPhotoWithCaption(
            ctx,
            IMAGES.default,
            message,
            Markup.inlineKeyboard(buttons),
            'HTML'
        );
    }

    async handleSetCountry(ctx) {
        const countryCode = ctx.match[1];
        const userId = ctx.from.id.toString();

        await User.updateOne({ userId }, { $set: { preferredCountry: countryCode } });
        await this.safeAnswerCbQuery(ctx, `🌍 Set to ${countryCode}`);
        await this.handleSettings(ctx);
    }

    async handleCustomCountryInput(ctx) {
        const userId = ctx.from.id.toString();
        const countryCode = ctx.message.text.trim().toUpperCase().substring(0, 2);

        if (!/^[A-Z]{2}$/.test(countryCode)) {
            return ctx.reply(
                `❌ <b>Invalid country code.</b>\n\n` +
                `Please enter a valid 2-letter country code (e.g., US, UK, DE).`,
                { parse_mode: 'HTML' }
            );
        }

        await User.updateOne({ userId }, { $set: { preferredCountry: countryCode } });
        await ctx.reply(
            `🌍 Country set to <code>${countryCode}</code>`,
            { parse_mode: 'HTML' }
        );
        await this.handleSettings(ctx);
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE SUPPORT
    // ═══════════════════════════════════════════════════════════

    async handleSupport(ctx) {
        try {
            const userId = ctx.from?.id?.toString();

            const message =
                `🎧 <b>SwiftSupport</b> — Customer Service\n\n` +
                `Need help? Our support team is here for you!\n\n` +
                `💬 Contact: <code>@${SUPPORT_USERNAME}</code>\n` +
                `⏱ Response Time: Usually within 5 minutes\n\n` +
                `❓ <b>Common Issues:</b>\n` +
                `• Deposit not showing? → Use /deposit then Check Deposit\n` +
                `• OTP not received? → Cancel and retry\n` +
                `• Wrong amount sent? → Contact support with TX hash\n` +
                `• Balance looks wrong? → Use /balance to sync\n\n` +
                `⚠️ Please include your <b>User ID</b> when contacting support.\n` +
                `<code>${userId || 'N/A'}</code>`;

            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💬 Chat Support', url: SUPPORT_URL }],
                        [{ text: '🔙 Back', callback_data: 'menu' }]
                    ]
                }
            };

            await this.sendPhotoWithCaption(ctx, IMAGES.support, message, keyboard, 'HTML');
        } catch (error) {
            logger.error('Support handler error', { error: error.message, userId: ctx.from?.id });

            try {
                await ctx.reply(
                    `🎧 Customer Service\n\nContact @${SUPPORT_USERNAME} for help.`,
                    {
                        reply_markup: {
                            inline_keyboard: [[{ text: '💬 Chat Support', url: SUPPORT_URL }]]
                        }
                    }
                );
            } catch (e) {
                logger.error('Support fallback failed', { error: e.message });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE HELP
    // ═══════════════════════════════════════════════════════════

    async handleHelp(ctx) {
        const message =
            `❓ <b>Help & FAQ</b>\n\n` +
            `<b>How to request OTP:</b>\n` +
            `1️⃣ Tap Request OTP or use /otp\n` +
            `2️⃣ Select mode (FREE, CHEAP, VIP, or Bundle)\n` +
            `3️⃣ Choose service (WhatsApp, Telegram, etc.)\n` +
            `4️⃣ Select country\n` +
            `5️⃣ Wait for OTP to arrive\n\n` +
            `<b>How to deposit:</b>\n` +
            `1️⃣ Tap Deposit or use /deposit\n` +
            `2️⃣ Select amount\n` +
            `3️⃣ Send USDT (BEP-20) to shown address\n` +
            `4️⃣ Tap Check Deposit or wait 1-2 minutes\n\n` +
            `👑 <b>VIP Benefits:</b>\n` +
            `• 50 OTPs/day\n` +
            `• Priority routing\n` +
            `• Fastest delivery\n` +
            `• $5/month\n\n` +
            `📦 <b>Bundle:</b>\n` +
            `• 100 OTPs for $5\n` +
            `• Never expires\n\n` +
            `<b>Commands:</b>\n` +
            `/start — Welcome screen\n` +
            `/menu — Main menu\n` +
            `/balance — Check balance\n` +
            `/deposit — Add funds\n` +
            `/history — Transactions\n` +
            `/referral — Earn rewards\n` +
            `/stats — Your statistics\n` +
            `/settings — Preferences\n` +
            `/support — Customer service\n` +
            `/otp — Request OTP\n` +
            `/buybundle — Buy 100 OTPs\n` +
            `/buyvip — Upgrade to VIP\n` +
            `/help — Show this help`;

        await this.sendPhotoWithCaption(
            ctx,
            IMAGES.default,
            message,
            this._buildBackButton(),
            'HTML'
        );
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE BUY BUNDLE (WITH BALANCE VALIDATION & LOCKING)
    // ═══════════════════════════════════════════════════════════

    async handleBuyBundle(ctx) {
        const user = await this._ensureUserFresh(ctx);
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;

        const availableBalance = this._getAvailableBalance(user);

        if (availableBalance < bundlePrice) {
            const message =
                `❌ <b>Insufficient Balance</b>\n\n` +
                `Required: <code>${formatCurrency(bundlePrice)}</code>\n` +
                `Available: <code>${formatCurrency(availableBalance)}</code>\n` +
                `Locked: <code>${formatCurrency(this._getLockedBalance(user))}</code>\n\n` +
                `Deposit first with /deposit`;

            return this.sendPhotoWithCaption(
                ctx,
                IMAGES.deposit,
                message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );
        }

        const txId = `BUNDLE_${Date.now()}_${user.userId}`;

        // Lock funds first
        try {
            await this._lockFunds(user.userId, bundlePrice, txId);
        } catch (err) {
            logger.error('Bundle purchase lock failed', { userId: user.userId, error: err.message });
            return ctx.reply('❌ Error processing purchase. Please try again.');
        }

        try {
            // Deduct balance and add bundle
            await User.updateOne(
                { userId: user.userId },
                {
                    $inc: {
                        balance: -bundlePrice,
                        bundleRemaining: bundleCount,
                        totalSpent: bundlePrice
                    }
                }
            );

            // Create transaction record
            await Transaction.create({
                txId,
                userId: user.userId,
                type: TX_TYPES.BUNDLE_PURCHASE,
                amount: -bundlePrice,
                status: 'COMPLETED',
                metadata: {
                    bundleCount,
                    pricePerOtp: bundlePrice / bundleCount,
                    lockedAmount: bundlePrice,
                    lockedBalanceProcessed: true
                },
                createdAt: new Date(),
                updatedAt: new Date()
            });

            // Release lock (since purchase completed)
            await this._releaseLockedFunds(user.userId, txId, 'completed');

            const newBundleTotal = (user.bundleRemaining || 0) + bundleCount;

            const message =
                `📦 <b>Bundle Purchased!</b>\n\n` +
                `✅ <code>${bundleCount}</code> OTPs added\n` +
                `💵 <code>${formatCurrency(bundlePrice)}</code> deducted\n` +
                `📦 Total Available: <code>${newBundleTotal}</code> OTPs\n\n` +
                `Use /otp to start requesting.`;

            await this.sendPhotoWithCaption(
                ctx,
                IMAGES.default,
                message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔢 Request OTP', 'request_otp')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );

        } catch (error) {
            logger.error('Bundle purchase failed', { userId: user.userId, error: error.message });

            // Attempt refund and release lock
            try {
                await this._releaseLockedFunds(user.userId, txId, 'refund');
                await Transaction.updateOne(
                    { txId },
                    { $set: { status: 'FAILED', 'metadata.failureReason': error.message } }
                );
            } catch (refundErr) {
                logger.error('Bundle refund failed', { userId: user.userId, error: refundErr.message });
            }

            await ctx.reply('❌ Purchase failed. Funds have been returned if deducted.');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  HANDLE BUY VIP (WITH BALANCE VALIDATION & LOCKING)
    // ═══════════════════════════════════════════════════════════

    async handleBuyVIP(ctx) {
        const user = await this._ensureUserFresh(ctx);
        const vipPrice = config.prices?.vipSubscription || 5.00;

        const availableBalance = this._getAvailableBalance(user);

        if (availableBalance < vipPrice) {
            const message =
                `❌ <b>Insufficient Balance</b>\n\n` +
                `Required: <code>${formatCurrency(vipPrice)}</code>\n` +
                `Available: <code>${formatCurrency(availableBalance)}</code>\n` +
                `Locked: <code>${formatCurrency(this._getLockedBalance(user))}</code>\n\n` +
                `Deposit first with /deposit`;

            return this.sendPhotoWithCaption(
                ctx,
                IMAGES.deposit,
                message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );
        }

        const txId = `VIP_${Date.now()}_${user.userId}`;
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + 1);

        // Lock funds first
        try {
            await this._lockFunds(user.userId, vipPrice, txId);
        } catch (err) {
            logger.error('VIP purchase lock failed', { userId: user.userId, error: err.message });
            return ctx.reply('❌ Error processing purchase. Please try again.');
        }

        try {
            // Deduct and activate VIP
            await User.updateOne(
                { userId: user.userId },
                {
                    $inc: { balance: -vipPrice, totalSpent: vipPrice },
                    $set: {
                        mode: 'VIP',
                        vipExpiry: expiryDate,
                        vipDailyUsed: 0,
                        vipDailyReset: new Date(),
                        vipResetDayUTC: this._getUTCDateString(new Date())
                    }
                }
            );

            // Create transaction record
            await Transaction.create({
                txId,
                userId: user.userId,
                type: TX_TYPES.VIP_SUBSCRIPTION,
                amount: -vipPrice,
                status: 'COMPLETED',
                metadata: {
                    duration: '1 month',
                    expiryDate,
                    vipDailyLimit: config.limits?.vipDaily || 50,
                    lockedAmount: vipPrice,
                    lockedBalanceProcessed: true
                },
                createdAt: new Date(),
                updatedAt: new Date()
            });

            // Release lock
            await this._releaseLockedFunds(user.userId, txId, 'completed');

            const message =
                `👑 <b>VIP Activated!</b>\n\n` +
                `✅ Valid until: <code>${expiryDate.toLocaleDateString()}</code>\n` +
                `🔢 50 OTPs/day\n` +
                `⚡ Priority delivery enabled\n\n` +
                `🎉 Enjoy premium service!`;

            await this.sendPhotoWithCaption(
                ctx,
                IMAGES.default,
                message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔢 Request OTP', 'request_otp')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]),
                'HTML'
            );

        } catch (error) {
            logger.error('VIP purchase failed', { userId: user.userId, error: error.message });

            // Attempt refund
            try {
                await this._releaseLockedFunds(user.userId, txId, 'refund');
                await Transaction.updateOne(
                    { txId },
                    { $set: { status: 'FAILED', 'metadata.failureReason': error.message } }
                );
            } catch (refundErr) {
                logger.error('VIP refund failed', { userId: user.userId, error: refundErr.message });
            }

            await ctx.reply('❌ VIP activation failed. Funds have been returned if deducted.');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  EXPORT
    // ═══════════════════════════════════════════════════════════

        async handleExportHistory(ctx) {
        const userId = ctx.from.id.toString();

        try {
            await this.safeAnswerCbQuery(ctx, '📥 Generating CSV...');

            const transactions = await Transaction
                .find({ userId })
                .sort({ createdAt: -1 })
                .lean();

            if (!transactions.length) {
                return ctx.reply('📭 No transactions to export.');
            }

            let csv = 'Date,Type,Amount,Status,TrackingFee,TX Hash,Notes\n';
            for (const tx of transactions) {
                const date = tx.createdAt
                    ? new Date(tx.createdAt).toISOString()
                    : 'N/A';
                const trackingFee = tx.metadata?.trackingFee || 0;
                const notes = tx.metadata?.failureReason || '';
                csv += `${date},${tx.type || 'Unknown'},${tx.amount || 0},${tx.status || 'Unknown'},${trackingFee},${tx.txHash || 'N/A'},"${notes}"\n`;
            }

            const filename = `SwiftSMS_History_${userId}_${Date.now()}.csv`;

            await ctx.replyWithDocument(
                { source: Buffer.from(csv), filename },
                { caption: '📥 Your complete transaction history export.' }
            );
        } catch (error) {
            logger.error('Export history failed', { userId, error: error.message });
            await ctx.reply('❌ Failed to export history. Please try again.');
        }
    }
}

export default UserCommands;
