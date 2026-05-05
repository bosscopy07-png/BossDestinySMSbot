import { ethers } from 'ethers';
import { User, Transaction } from '../../models/index.js';
import { generateId } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

// ═══════════════════════════════════════════════════════════
//  RPC CONFIGURATION — DUAL-MODE SYSTEM WITH FALLBACK
// ═══════════════════════════════════════════════════════════

const LIGHT_RPC_URL = 'https://bsc.blockpi.network/v1/rpc/8ca241ff53aa72bd97b543bf72e1ad9a1231049c';
const LIGHT_FALLBACK_RPC_URL = 'https://bnb-mainnet.g.alchemy.com/v2/FYyZrOxSDZWjqzljvhIgt';
const PREMIUM_RPC_TIMEOUT_MS = 15000;
const IDLE_SCAN_INTERVAL_MS = 60000;      // 60s when idle (light RPC)
const ACTIVE_SCAN_INTERVAL_MS = 15000;    // 15s when active deposit exists
const ACTIVE_MODE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes after last deposit init
const ACTIVE_MODE_EXTENSION_MS = 15 * 60 * 1000; // Extend active mode to 15min total
const FALLBACK_RECOVERY_INTERVAL_MS = 60 * 1000; // Return to primary light RPC after 60s
const FALLBACK_SCAN_RANGE = 10; // Alchemy fallback only scans 10 blocks
const STALE_DEPOSIT_TIMEOUT_MS = 30 * 60 * 1000; // 30min — deposits older than this are considered stale

/**
 * WalletService — Blockchain deposits, fund locking, balance management
 * 
 * DUAL-RPC ARCHITECTURE:
 * - IDLE MODE: Uses lightweight public RPC, slow interval (60s), minimal credits
 * - ACTIVE MODE: Uses premium configured RPC, fast interval (15s), triggered by deposit
 * - FALLBACK MODE: Uses Alchemy when primary light RPC fails, limited to 10 blocks, auto-recovers
 * 
 * STATE TRANSITIONS:
 *   IDLE ──[user initiates deposit]──► ACTIVE ──[10-15min no new deposits]──► IDLE
 *   IDLE_LIGHT ──[primary RPC fails]──► IDLE_FALLBACK ──[60s]──► IDLE_LIGHT
 */
class WalletService {
    constructor() {
        this.masterAddress = null;
        this.decimals = 18;
        this.provider = null;
        this.masterWallet = null;
        this.usdtContract = null;
        this.isReady = false;
        this.lastCheckedBlock = 0;
        this.scanInterval = null;
        this.notificationCallback = null;
        this.notifiedTxHashes = new Set();
        this.initializationPromise = null;
        
        // ═══ DUAL-RPC STATE ═══
        this.scanMode = 'IDLE';           // 'IDLE' | 'ACTIVE'
        this.activeModeExpiry = 0;        // Timestamp when active mode expires
        this.lightProvider = null;        // Primary lightweight RPC provider
        this.lightFallbackProvider = null; // Alchemy fallback provider
        this.premiumProvider = null;      // Premium RPC provider
        this.currentProviderType = null;  // 'light' | 'light_fallback' | 'premium'
        this.fallbackExpiry = 0;          // When to return from fallback to primary light
        
        this.usdtAbi = [
            'function balanceOf(address) view returns (uint256)',
            'function transfer(address, uint256) returns (bool)',
            'function decimals() view returns (uint8)',
            'event Transfer(address indexed from, address indexed to, uint256 value)'
        ];

        this.initializationPromise = this.initialize();
    }

    onDepositNotification(callback) {
        this.notificationCallback = callback;
    }

    // ═══════════════════════════════════════════════════════════
    //  RPC ENDPOINTS — PRIORITY ORDER
    // ═══════════════════════════════════════════════════════════

    _getPremiumRpcEndpoints() {
        const endpoints = [
            config.blockchain?.rpc,
            'https://go.getblock.us/3d92a58434934d8fb726cd0c12fb5715',
            'https://bsc.blockpi.network/v1/rpc/8ca241ff53aa72bd97b543bf72e1ad9a1231049c',
            'https://rpc.ankr.com/bsc',
            'https://bsc-dataseed.binance.org/',
            'https://bsc-dataseed1.defibit.io/',
            'https://bsc-dataseed1.ninicoin.io/'
        ];

        return endpoints.filter((url, i, self) => url && self.indexOf(url) === i);
    }

    // ═══════════════════════════════════════════════════════════
    //  DUAL-RPC INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    async initialize() {
        // ─── Initialize LIGHT provider first (always available) ───
        try {
            this.lightProvider = new ethers.JsonRpcProvider(LIGHT_RPC_URL, undefined, {
                staticNetwork: true,
                batchMaxCount: 1
            });

            const lightTest = this.lightProvider.getNetwork();
            const lightTimeout = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('LIGHT_RPC_TIMEOUT')), 10000)
            );
            
            await Promise.race([lightTest, lightTimeout]);
            logger.info('Light RPC initialized', { rpc: this._maskRpcUrl(LIGHT_RPC_URL) });

        } catch (error) {
            logger.error('Light RPC failed to initialize', { error: error.message });
            this.lightProvider = null;
        }

        // ─── Initialize LIGHT FALLBACK provider (Alchemy) ───
        try {
            this.lightFallbackProvider = new ethers.JsonRpcProvider(LIGHT_FALLBACK_RPC_URL, undefined, {
                staticNetwork: true,
                batchMaxCount: 1
            });

            const fallbackTest = this.lightFallbackProvider.getNetwork();
            const fallbackTimeout = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('FALLBACK_RPC_TIMEOUT')), 10000)
            );
            
            await Promise.race([fallbackTest, fallbackTimeout]);
            logger.info('Light fallback RPC initialized', { rpc: this._maskRpcUrl(LIGHT_FALLBACK_RPC_URL) });

        } catch (error) {
            logger.error('Light fallback RPC failed to initialize', { error: error.message });
            this.lightFallbackProvider = null;
        }

        // ─── Initialize PREMIUM provider ───
        const premiumEndpoints = this._getPremiumRpcEndpoints();
        let lastError = null;

        for (const rpcUrl of premiumEndpoints) {
            try {
                this.premiumProvider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
                    staticNetwork: true,
                    batchMaxCount: 1
                });

                const testPromise = this.premiumProvider.getNetwork();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('PREMIUM_RPC_TIMEOUT')), 8000)
                );
                
                await Promise.race([testPromise, timeoutPromise]);

                this.masterWallet = new ethers.Wallet(
                    config.blockchain?.masterPrivateKey, 
                    this.premiumProvider
                );
                
                this.usdtContract = new ethers.Contract(
                    config.blockchain?.usdtContract,
                    this.usdtAbi,
                    this.masterWallet
                );

                this.masterAddress = this.masterWallet.address;
                this.isReady = true;

                // Start in IDLE mode using light provider
                this._switchToIdleMode();

                try {
                    this.lastCheckedBlock = await this.provider.getBlockNumber();
                } catch {
                    this.lastCheckedBlock = 0;
                }

                logger.info('Wallet service initialized', {
                    masterAddress: this.masterAddress,
                    premiumRpc: this._maskRpcUrl(rpcUrl),
                    lightRpcAvailable: !!this.lightProvider,
                    lightFallbackAvailable: !!this.lightFallbackProvider
                });

                await this.initializeDecimals();
                return;

            } catch (error) {
                lastError = error;
                logger.warn('Premium RPC failed, trying next...', { 
                    rpc: this._maskRpcUrl(rpcUrl),
                    error: error.message
                });
                this.premiumProvider = null;
            }
        }

        // All premium RPCs failed — degraded mode
        logger.error('All premium RPC endpoints failed — running in degraded mode', {
            lastError: lastError?.message
        });
        
        this.masterWallet = new ethers.Wallet(config.blockchain?.masterPrivateKey);
        this.masterAddress = this.masterWallet.address;
        this.isReady = false;
    }

    _maskRpcUrl(url) {
        if (!url) return 'undefined';
        return url.replace(/\/\/.*@/, '//***@').replace(/\/v2\/.*/, '/v2/***').replace(/\/v1\/.*/, '/v1/***').replace(/\/v2\/[a-zA-Z0-9]+$/, '/v2/***');
    }

    async initializeDecimals() {
        if (!this.isReady) return;
        
        try {
            this.decimals = await this.usdtContract.decimals();
            logger.info('USDT decimals fetched', { decimals: this.decimals });
        } catch (error) {
            logger.error('Failed to get USDT decimals, using default 18', { error: error.message });
            this.decimals = 18;
        }
    }

    async ensureReady() {
        if (this.initializationPromise) {
            await this.initializationPromise;
        }
        if (!this.isReady) {
            throw new Error('WALLET_NOT_READY — blockchain connection unavailable. Check RPC URL or try again later.');
        }
    }

    checkReady() {
        if (!this.isReady) {
            throw new Error('WALLET_NOT_READY — blockchain connection unavailable. Check RPC URL or try again later.');
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  DUAL-RPC MODE SWITCHING
    // ═══════════════════════════════════════════════════════════

    /**
     * Switch to IDLE mode: use light RPC, slow interval
     */
    _switchToIdleMode() {
        if (this.scanMode === 'IDLE' && this.currentProviderType === 'light') {
            return; // Already idle on primary
        }

        this.scanMode = 'IDLE';
        this.provider = this.lightProvider || this.lightFallbackProvider;
        this.currentProviderType = this.lightProvider ? 'light' : 'light_fallback';
        this.fallbackExpiry = 0;

        // Re-create contract instance with light provider (read-only)
        if (this.provider && this.masterAddress) {
            this.usdtContract = new ethers.Contract(
                config.blockchain?.usdtContract,
                this.usdtAbi,
                this.provider  // read-only, no signer needed for scanning
            );
        }

        logger.info('Switched to IDLE scanning mode', {
            rpc: this.currentProviderType,
            interval: `${IDLE_SCAN_INTERVAL_MS}ms`,
            reason: 'No active deposits or timeout expired'
        });

        this._restartScanner();
    }

    /**
     * Switch to ACTIVE mode: use premium RPC, fast interval
     * Triggered when user initiates a deposit
     */
    _switchToActiveMode() {
        if (!this.premiumProvider) {
            logger.warn('Cannot switch to ACTIVE mode — premium RPC unavailable');
            return;
        }

        const now = Date.now();
        const wasAlreadyActive = this.scanMode === 'ACTIVE';

        this.scanMode = 'ACTIVE';
        this.activeModeExpiry = now + ACTIVE_MODE_TIMEOUT_MS;
        this.provider = this.premiumProvider;
        this.currentProviderType = 'premium';
        this.fallbackExpiry = 0;

        // Re-create contract with premium provider (has signer for potential writes)
        this.usdtContract = new ethers.Contract(
            config.blockchain?.usdtContract,
            this.usdtAbi,
            this.masterWallet  // signer attached for full operations
        );

        const reason = wasAlreadyActive ? 'Deposit initiated — extending active window' : 'Deposit initiated — switching to premium RPC';

        logger.info('Switched to ACTIVE scanning mode', {
            rpc: 'premium',
            interval: `${ACTIVE_SCAN_INTERVAL_MS}ms`,
            expiresIn: `${Math.round((this.activeModeExpiry - now) / 1000)}s`,
            reason
        });

        this._restartScanner();
    }

    /**
     * Switch to light fallback mode when primary light RPC fails
     */
    _switchToLightFallback() {
        if (!this.lightFallbackProvider) {
            logger.warn('Cannot switch to light fallback — fallback RPC unavailable');
            return;
        }

        if (this.currentProviderType === 'light_fallback') {
            return; // Already on fallback
        }

        this.provider = this.lightFallbackProvider;
        this.currentProviderType = 'light_fallback';
        this.fallbackExpiry = Date.now() + FALLBACK_RECOVERY_INTERVAL_MS;

        // Re-create contract with fallback provider
        if (this.masterAddress) {
            this.usdtContract = new ethers.Contract(
                config.blockchain?.usdtContract,
                this.usdtAbi,
                this.lightFallbackProvider
            );
        }

        logger.info('Switched to LIGHT FALLBACK mode', {
            rpc: 'alchemy',
            recoveryIn: `${FALLBACK_RECOVERY_INTERVAL_MS / 1000}s`,
            scanRange: FALLBACK_SCAN_RANGE,
            reason: 'Primary light RPC failed'
        });

        // Do NOT restart scanner — keep same interval, just change provider
    }

    /**
     * Attempt to recover from fallback to primary light RPC
     */
    _tryRecoverToPrimaryLight() {
        if (this.currentProviderType !== 'light_fallback') {
            return;
        }

        const now = Date.now();
        if (now < this.fallbackExpiry) {
            return; // Not ready to recover yet
        }

        if (!this.lightProvider) {
            return; // Primary not available
        }

        // Test primary before switching back
        this.lightProvider.getBlockNumber()
            .then(() => {
                logger.info('Primary light RPC recovered, switching back');
                this._switchToIdleMode();
            })
            .catch((error) => {
                logger.warn('Primary light RPC still down, staying on fallback', { error: error.message });
                // Extend fallback expiry by another minute
                this.fallbackExpiry = now + FALLBACK_RECOVERY_INTERVAL_MS;
            });
    }

    /**
     * Check if we should extend or expire active mode
     * CRITICAL FIX: Only extends if the SPECIFIC user who triggered active mode still has pending deposits
     * AND deposits are not stale (older than 30 minutes)
     */
    _evaluateScanMode() {
        const now = Date.now();

        if (this.scanMode !== 'ACTIVE') {
            // In idle mode, check if we should recover from fallback
            if (this.currentProviderType === 'light_fallback') {
                this._tryRecoverToPrimaryLight();
            }
            return;
        }

        if (now < this.activeModeExpiry) {
            return; // Still within active window, don't check yet
        }

        // Active window expired — check if there are RECENT pending deposits
        this._checkRecentPendingDeposits().then(hasRecentPending => {
            if (hasRecentPending) {
                // Extend active mode only if there are recent pending deposits
                this.activeModeExpiry = now + ACTIVE_MODE_EXTENSION_MS;
                logger.info('Extended ACTIVE mode — recent pending deposits exist', {
                    newExpiry: new Date(this.activeModeExpiry).toISOString()
                });
            } else {
                this._switchToIdleMode();
            }
        }).catch(err => {
            logger.error('Failed to check pending deposits, staying in current mode', { error: err.message });
        });
    }

    /**
     * Check if any users have RECENT pending deposits (not stale)
     * This prevents old/stuck depositPending flags from keeping active mode alive forever
     */
    async _checkRecentPendingDeposits() {
        try {
            const staleThreshold = new Date(Date.now() - STALE_DEPOSIT_TIMEOUT_MS);
            
            const pendingCount = await User.countDocuments({ 
                depositPending: true,
                depositRequestedAt: { $gte: staleThreshold }  // Only count deposits requested within last 30min
            });
            
            return pendingCount > 0;
        } catch (error) {
            logger.error('Failed to count recent pending deposits', { error: error.message });
            return false; // Fail-safe: assume no pending to avoid staying active forever
        }
    }

    /**
     * Clean up stale depositPending flags (deposits older than 30min that were never completed)
     * Call this periodically to prevent database pollution
     */
    async _cleanupStaleDeposits() {
        try {
            const staleThreshold = new Date(Date.now() - STALE_DEPOSIT_TIMEOUT_MS);
            
            const result = await User.updateMany(
                { 
                    depositPending: true,
                    depositRequestedAt: { $lt: staleThreshold }
                },
                {
                    $set: {
                        depositPending: false,
                        depositTrackingAmount: null,
                        depositRequestedAmount: null
                    }
                }
            );

            if (result.modifiedCount > 0) {
                logger.info('Cleaned up stale deposit flags', { count: result.modifiedCount });
            }
        } catch (error) {
            logger.error('Failed to cleanup stale deposits', { error: error.message });
        }
    }

    /**
     * Restart scanner with current mode's interval
     */
    _restartScanner() {
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }

        const interval = this.scanMode === 'ACTIVE' ? ACTIVE_SCAN_INTERVAL_MS : IDLE_SCAN_INTERVAL_MS;

        if (!this.isReady) {
            logger.warn('Cannot restart scanner — wallet not ready');
            return;
        }

        this.scanInterval = setInterval(async () => {
            try {
                // Evaluate mode transition before each scan
                this._evaluateScanMode();

                // Only scan if we have a valid provider
                if (!this.provider) {
                    logger.warn('No provider available for scan');
                    return;
                }

                await this.checkAllDeposits();
            } catch (error) {
                logger.error('Deposit scanner error', { 
                    error: error.message,
                    mode: this.scanMode,
                    provider: this.currentProviderType
                });

                // If light RPC fails during idle scan, try fallback
                if (this.scanMode === 'IDLE' && this.currentProviderType === 'light') {
                    this._switchToLightFallback();
                }
            }
        }, interval);

        this.scanInterval.unref?.();
    }

    // ═══════════════════════════════════════════════════════════
    //  DEPOSIT SYSTEM — MODIFIED TO TRIGGER ACTIVE MODE
    // ═══════════════════════════════════════════════════════════

    async getDepositInfo(userId, requestedAmount = 10) {
        await this.ensureReady();

        const minDeposit = 0.50;
        let amount = parseFloat(requestedAmount);
        
        if (isNaN(amount) || amount < minDeposit) {
            amount = minDeposit;
        }

        const trackingAmount = this.generateTrackingAmount(amount, userId);

        await User.updateOne(
            { userId },
            { 
                $set: { 
                    depositAddress: this.masterAddress,
                    depositTrackingAmount: trackingAmount,
                    depositRequestedAmount: amount,
                    depositPending: true,
                    depositRequested
