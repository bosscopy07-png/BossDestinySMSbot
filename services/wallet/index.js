import { ethers } from 'ethers';
import { User, Transaction } from '../../models/index.js';
import { generateId } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

/**
 * WalletService — Blockchain deposits, fund locking, balance management
 * 
 * FIXED:
 * - captureFunds now ACTUALLY deducts from user balance (was missing)
 * - releaseFunds throws on invalid tx instead of silent false
 * - lockFunds uses generic 'LOCK' type, preserves audit trail
 * - releaseFunds preserves original tx type, only changes status
 * - Atomic balance checks prevent negative balances
 * - All methods have proper error handling and rollback
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
    //  INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    async initialize() {
        const rpcEndpoints = [
            config.blockchain?.rpc,
            'https://rpc.ankr.com/bsc',
            'https://bsc-dataseed.binance.org/',
            'https://bsc-dataseed1.defibit.io/',
            'https://bsc-dataseed1.ninicoin.io/'
        ].filter((url, i, self) => url && self.indexOf(url) === i);

        for (const rpcUrl of rpcEndpoints) {
            try {
                this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
                    staticNetwork: true,
                    batchMaxCount: 1
                });

                const testPromise = this.provider.getNetwork();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('RPC_TIMEOUT')), 5000)
                );
                
                await Promise.race([testPromise, timeoutPromise]);

                this.masterWallet = new ethers.Wallet(
                    config.blockchain?.masterPrivateKey, 
                    this.provider
                );
                
                this.usdtContract = new ethers.Contract(
                    config.blockchain?.usdtContract,
                    this.usdtAbi,
                    this.masterWallet
                );

                this.masterAddress = this.masterWallet.address;
                this.isReady = true;

                try {
                    this.lastCheckedBlock = await this.provider.getBlockNumber();
                } catch {
                    this.lastCheckedBlock = 0;
                }

                logger.info('Wallet service initialized', {
                    masterAddress: this.masterAddress,
                    rpc: rpcUrl.replace(/\/\/.*@/, '//***@')
                });

                await this.initializeDecimals();
                return;

            } catch (error) {
                logger.warn('RPC failed, trying next...', { 
                    rpc: rpcUrl?.replace(/\/\/.*@/, '//***@'),
                    error: error.message 
                });
                this.provider = null;
            }
        }

        logger.error('All RPC endpoints failed — running in degraded mode');
        this.masterWallet = new ethers.Wallet(config.blockchain?.masterPrivateKey);
        this.masterAddress = this.masterWallet.address;
        this.isReady = false;
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
    //  DEPOSIT SYSTEM
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
                    depositRequestedAt: new Date()
                } 
            },
            { upsert: true }
        );

        return {
            address: this.masterAddress,
            amount: trackingAmount,
            baseAmount: amount,
            trackingAmount: trackingAmount,
            network: 'BSC (BEP-20)',
            token: 'USDT'
        };
    }

    generateTrackingAmount(baseAmount, userId) {
        const userSuffix = parseInt(userId.toString().slice(-5)) / 1000000;
        const trackingAmount = baseAmount + userSuffix;
        return parseFloat(trackingAmount.toFixed(6));
    }

    async checkAllDeposits() {
        await this.ensureReady();

        try {
            const latestBlock = await this.provider.getBlockNumber();
            const scanRange = 500;
            
            let fromBlock = this.lastCheckedBlock || (latestBlock - scanRange);
            
            if (latestBlock - fromBlock > scanRange) {
                fromBlock = latestBlock - scanRange;
            }
            
            if (fromBlock < 0) fromBlock = 0;

            if (latestBlock <= fromBlock) {
                return [];
            }

            const filter = this.usdtContract.filters.Transfer(null, this.masterAddress);
            const events = await this.usdtContract.queryFilter(filter, fromBlock, latestBlock);

            const processedDeposits = [];

            for (const event of events) {
                try {
                    const result = await this.processDepositEvent(event);
                    if (result) processedDeposits.push(result);
                } catch (error) {
                    logger.error('Failed to process deposit event', {
                        txHash: event.transactionHash,
                        error: error.message
                    });
                }
            }

            this.lastCheckedBlock = latestBlock + 1;
            return processedDeposits;

        } catch (error) {
            logger.error('Deposit check failed', { error: error.message });
            
            if (error.message?.includes('exceeds the limits') || error.message?.includes('Forbidden')) {
                try {
                    const latestBlock = await this.provider.getBlockNumber();
                    this.lastCheckedBlock = latestBlock - 400;
                    logger.warn('Reset scan range due to RPC limit', { newStart: this.lastCheckedBlock });
                } catch {
                    this.lastCheckedBlock = 0;
                }
            }
            
            throw error;
        }
    }

    async processDepositEvent(event, retryCount = 0) {
        const MAX_RETRIES = 3;
        
        try {
            const fromAddress = event.args.from;
            const toAddress = event.args.to;
            const amountRaw = event.args.value;
            const amount = parseFloat(ethers.formatUnits(amountRaw, this.decimals));
            const txHash = event.transactionHash;
            const blockNumber = event.blockNumber;

            if (toAddress.toLowerCase() !== this.masterAddress.toLowerCase()) {
                return null;
            }

            const existing = await Transaction.findOne({ 'blockchain.txHash': txHash });
            if (existing) return null;

            let user = await User.findOne({ 
                depositPending: true,
                depositTrackingAmount: amount
            });

            if (!user) {
                user = await User.findOne({
                    depositPending: true,
                    depositTrackingAmount: { 
                        $gte: amount - 0.01, 
                        $lte: amount + 0.01 
                    }
                });
            }

            if (!user) {
                logger.warn('Deposit received but no matching user found', {
                    from: fromAddress,
                    amount,
                    txHash
                });
                return null;
            }

            let creditAmount = user.depositRequestedAmount;
            
            if (!creditAmount || creditAmount <= 0) {
                const userSuffix = parseInt(user.userId.toString().slice(-5)) / 1000000;
                creditAmount = parseFloat((amount - userSuffix).toFixed(2));
                
                logger.warn('depositRequestedAmount missing, derived from tracking amount', {
                    userId: user.userId,
                    derivedCreditAmount: creditAmount,
                    trackingAmount: amount,
                    userSuffix
                });

                await User.updateOne(
                    { userId: user.userId },
                    { $set: { depositRequestedAmount: creditAmount } }
                );
            }

            const trackingFee = parseFloat((amount - creditAmount).toFixed(6));

            if (creditAmount <= 0) {
                logger.error('Invalid credit amount', { userId: user.userId, creditAmount, trackingAmount: amount });
                return null;
            }

            const tx = await Transaction.create({
                txId: generateId(),
                userId: user.userId,
                type: 'DEPOSIT',
                amount: creditAmount,
                currency: 'USDT',
                status: 'COMPLETED',
                blockchain: {
                    txHash,
                    blockNumber,
                    confirmations: 0,
                    fromAddress,
                    toAddress,
                    token: 'USDT',
                    amountCrypto: amount.toString(),
                    requestedAmount: creditAmount,
                    trackingFee: trackingFee
                }
            });

            await User.updateOne(
                { userId: user.userId },
                {
                    $inc: { 
                        balance: creditAmount,
                        totalDeposited: creditAmount
                    },
                    $set: {
                        depositPending: false,
                        depositTrackingAmount: null,
                        depositRequestedAmount: null,
                        lastDepositAt: new Date(),
                        registeredWallet: fromAddress.toLowerCase()
                    }
                }
            );

            await this.processReferralDeposit(user.userId, creditAmount);

            logger.info('Deposit detected and credited', {
                userId: user.userId,
                creditAmount,
                trackingAmount: amount,
                trackingFee,
                txHash,
                from: fromAddress
            });

            if (this.notificationCallback && !this.notifiedTxHashes.has(txHash)) {
                this.notifiedTxHashes.add(txHash);
                
                try {
                    await this.notificationCallback(user.userId, {
                        type: 'DEPOSIT_CONFIRMED',
                        amount: creditAmount,
                        trackingFee,
                        txHash,
                        address: this.masterAddress
                    });
                } catch (notifyError) {
                    logger.error('Deposit notification failed', { 
                        userId: user.userId, 
                        error: notifyError.message 
                    });
                    this.notifiedTxHashes.delete(txHash);
                }
            }
        
            return {
                userId: user.userId,
                amount: creditAmount,
                trackingAmount: amount,
                trackingFee,
                txHash,
                status: 'CREDITED'
            };

        } catch (error) {
            if (retryCount < MAX_RETRIES && this.isRetryableError(error)) {
                const delay = 1000 * Math.pow(2, retryCount);
                logger.warn('Deposit event processing failed, retrying...', { 
                    txHash: event.transactionHash, 
                    retry: retryCount + 1,
                    delay,
                    error: error.message 
                });
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.processDepositEvent(event, retryCount + 1);
            }

            logger.error('Failed to process deposit event', {
                txHash: event.transactionHash,
                error: error.message,
                retryCount
            });
            throw error;
        }
    }

    isRetryableError(error) {
        const retryableMessages = [
            'E11000',
            'timeout',
            'ECONNREFUSED',
            'ENETUNREACH',
            'socket hang up',
            'Transaction validation failed'
        ];
        return retryableMessages.some(msg => error.message?.includes(msg));
    }

    async checkDeposit(userId) {
        await this.ensureReady();
        
        const user = await User.findOne({ userId });
        if (!user) {
            return { found: false, message: 'User not found' };
        }

        if (!user.depositPending) {
            const recentTx = await Transaction.findOne({
                userId,
                type: 'DEPOSIT',
                createdAt: { $gte: new Date(Date.now() - 3600000) }
            }).sort({ createdAt: -1 });

            if (recentTx) {
                return {
                    found: true,
                    status: recentTx.status,
                    amount: recentTx.amount,
                    baseAmount: recentTx.blockchain?.requestedAmount || recentTx.amount,
                    trackingAmount: recentTx.blockchain?.amountCrypto,
                    trackingFee: recentTx.blockchain?.trackingFee || 0,
                    txHash: recentTx.blockchain?.txHash,
                    confirmations: recentTx.blockchain?.confirmations || 0
                };
            }

            return { 
                found: false, 
                message: 'No pending deposit. Use /deposit to start one.' 
            };
        }

        if (!user.depositTrackingAmount) {
            return { 
                found: false, 
                message: 'No deposit address generated yet. Use /deposit first.' 
            };
        }

        try {
            const latestBlock = await this.provider.getBlockNumber();
            const scanRange = 500;
            let fromBlock = Math.max(0, latestBlock - scanRange);

            const filter = this.usdtContract.filters.Transfer(null, this.masterAddress);
            const events = await this.usdtContract.queryFilter(filter, fromBlock, latestBlock);

            for (const event of events) {
                const amountRaw = event.args.value;
                const amount = parseFloat(ethers.formatUnits(amountRaw, this.decimals));
                const txHash = event.transactionHash;

                const existing = await Transaction.findOne({ 'blockchain.txHash': txHash });
                if (existing) continue;

                const trackingAmount = user.depositTrackingAmount;
                const matchExact = Math.abs(amount - trackingAmount) < 0.0001;

                if (matchExact) {
                    const result = await this.processDepositEvent(event);
                    
                    if (result && result.userId === userId) {
                        return {
                            found: true,
                            status: 'COMPLETED',
                            amount: result.amount,
                            baseAmount: result.amount,
                            trackingAmount: result.trackingAmount,
                            trackingFee: result.trackingFee,
                            txHash: result.txHash,
                            confirmations: 0
                        };
                    }
                }
            }

            return { 
                found: false, 
                message: 'No deposit found yet. Send exactly ' + user.depositTrackingAmount + ' USDT (BEP-20) to your deposit address and check again.' 
            };

        } catch (error) {
            logger.error('Direct deposit check failed', { userId, error: error.message });
            
            const recentTx = await Transaction.findOne({
                userId,
                type: 'DEPOSIT',
                createdAt: { $gte: new Date(Date.now() - 3600000) }
            }).sort({ createdAt: -1 });

            if (recentTx) {
                return {
                    found: true,
                    status: recentTx.status,
                    amount: recentTx.amount,
                    baseAmount: recentTx.blockchain?.requestedAmount || recentTx.amount,
                    txHash: recentTx.blockchain?.txHash,
                    confirmations: recentTx.blockchain?.confirmations || 0
                };
            }

            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  REFERRAL SYSTEM
    // ═══════════════════════════════════════════════════════════

    async processReferralDeposit(userId, amount) {
        try {
            const user = await User.findOne({ userId });
            if (!user || !user.referredBy) return;

            const referrer = await User.findOne({ referralCode: user.referredBy });
            if (!referrer) return;

            const minDeposit = config.referral?.minDeposit ?? 5;
            if (amount < minDeposit) return;

            const existingReward = await Transaction.findOne({
                userId: referrer.userId,
                type: 'REFERRAL_REWARD',
                'metadata.referredUserId': userId
            });

            if (existingReward) return;

            const rewardAmount = amount * (config.referral?.percentage ?? 0.05);

            await Transaction.create({
                txId: generateId(),
                userId: referrer.userId,
                type: 'REFERRAL_REWARD',
                amount: rewardAmount,
                currency: 'USD',
                status: 'PENDING
