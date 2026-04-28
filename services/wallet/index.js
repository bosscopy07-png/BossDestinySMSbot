import { ethers } from 'ethers';
import { User, Transaction } from '../../models/index.js';
import { generateId } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

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
        this.initializationPromise = null;
        this.notificationCallback = null; // NEW: hook for Telegram notifications

        this.usdtAbi = [
            'function balanceOf(address) view returns (uint256)',
            'function transfer(address, uint256) returns (bool)',
            'function decimals() view returns (uint8)',
            'event Transfer(address indexed from, address indexed to, uint256 value)'
        ];

        this.initializationPromise = this.initialize();
    }

    // NEW: Allow bot to register notification callback
    onDepositNotification(callback) {
        this.notificationCallback = callback;
    }

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

    // ========== DEPOSIT SYSTEM ==========

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
                    depositRequestedAmount: amount,  // NEW: store what user actually wants
                    depositPending: true,
                    depositRequestedAt: new Date()
                } 
            },
            { upsert: true }
        );

        return {
            address: this.masterAddress,
            amount: trackingAmount,        // What they must send
            baseAmount: amount,            // What they actually want (NEW)
            trackingAmount: trackingAmount, // Alias for clarity
            network: 'BSC (BEP-20)',
            token: 'USDT'
        };
    }

    generateTrackingAmount(baseAmount, userId) {
        const userSuffix = parseInt(userId.toString().slice(-5)) / 1000000;
        const trackingAmount = baseAmount + userSuffix;
        return parseFloat(trackingAmount.toFixed(6));
    }

    // ========== MASTER ADDRESS DEPOSIT CHECKING ==========

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

    async processDepositEvent(event) {
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

        // FIX: Look for user by tracking amount first, then by range
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

        // FIX: Use requestedAmount for credit, not tracking amount
        const creditAmount = user.depositRequestedAmount || amount;
        const trackingFee = parseFloat((amount - creditAmount).toFixed(6));

        const tx = await Transaction.create({
            txId: generateId(),
            userId: user.userId,
            type: 'DEPOSIT',
            amount: creditAmount,              // FIX: credit the requested amount
            currency: 'USDT',
            status: 'CONFIRMED',
            blockchain: {
                txHash,
                blockNumber,
                confirmations: 0,
                fromAddress,
                toAddress,
                token: 'USDT',
                amountCrypto: amount.toString(),        // What was actually sent
                requestedAmount: creditAmount,           // What user wanted
                trackingFee: trackingFee                 // System fee
            }
        });

        await User.updateOne(
            { userId: user.userId },
            {
                $inc: { 
                    balance: creditAmount,         // FIX: only credit requested amount
                    totalDeposited: creditAmount
                },
                $set: {
                    depositPending: false,
                    depositTrackingAmount: null,
                    depositRequestedAmount: null,  // NEW: clear this too
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

        // NEW: Send notification if callback registered
        if (this.notificationCallback) {
            try {
                await this.notificationCallback(user.userId, {
                    type: 'DEPOSIT_CONFIRMED',
                    amount: creditAmount,
                    trackingFee,
                    txHash,
                    address: this.masterAddress
                });
            } catch (notifyError) {
                logger.error('Deposit notification failed', { userId: user.userId, error: notifyError.message });
            }
        }

        return {
            userId: user.userId,
            amount: creditAmount,           // FIX: return credited amount
            trackingAmount: amount,          // What was sent
            trackingFee,
            txHash,
            status: 'CREDITED'
        };
    }

    // FIX: checkDeposit now actually queries blockchain for the specific user
    async checkDeposit(userId) {
        await this.ensureReady();

        const user = await User.findOne({ userId });
        if (!user) {
            return { found: false, message: 'User not found' };
        }

        if (!user.depositPending) {
            return { 
                found: false, 
                message: 'No pending deposit. Use /deposit to start one.' 
            };
        }

        // If user has no tracking amount set, nothing to check
        if (!user.depositTrackingAmount) {
            return { 
                found: false, 
                message: 'No deposit address generated yet. Use /deposit first.' 
            };
        }

        try {
            // Direct blockchain query: scan last 500 blocks for transfers to master address
            // from ANY sender, then match by amount
            const latestBlock = await this.provider.getBlockNumber();
            const scanRange = 500;
            let fromBlock = Math.max(0, latestBlock - scanRange);

            const filter = this.usdtContract.filters.Transfer(null, this.masterAddress);
            const events = await this.usdtContract.queryFilter(filter, fromBlock, latestBlock);

            for (const event of events) {
                const amountRaw = event.args.value;
                const amount = parseFloat(ethers.formatUnits(amountRaw, this.decimals));
                const txHash = event.transactionHash;

                // Skip already processed
                const existing = await Transaction.findOne({ 'blockchain.txHash': txHash });
                if (existing) continue;

                // Check if this amount matches this user's pending deposit
                const trackingAmount = user.depositTrackingAmount;
                const matchExact = Math.abs(amount - trackingAmount) < 0.0001;

                if (matchExact) {
                    // Process this deposit immediately
                    const result = await this.processDepositEvent(event);
                    if (result && result.userId === userId) {
                        return {
                            found: true,
                            status: 'CONFIRMED',
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

            // No matching deposit found in recent blocks
            return { 
                found: false, 
                message: 'No deposit found yet. Send exactly ' + user.depositTrackingAmount + ' USDT (BEP-20) to your deposit address and check again.' 
            };

        } catch (error) {
            logger.error('Direct deposit check failed', { userId, error: error.message });
            
            // Fallback: check if any transaction was already recorded for this user
            const recentTx = await Transaction.findOne({
                userId,
                type: 'DEPOSIT',
                createdAt: { $gte: new Date(Date.now() - 3600000) } // Last hour
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

    // ========== REFERRAL SYSTEM ==========

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
                status: 'PENDING',
                metadata: {
                    referredUserId: userId,
                    depositAmount: amount,
                    percentage: config.referral?.percentage ?? 0.05,
                    requiresApproval: true
                }
            });

            await User.updateOne(
                { userId: referrer.userId },
                {
                    $inc: {
                        referralCount: 1,
                        referralEarnings: rewardAmount
                    }
                }
            );

            logger.info('Referral reward created (pending approval)', {
                referrerId: referrer.userId,
                referredId: userId,
                amount: rewardAmount
            });

        } catch (error) {
            logger.error('Referral processing failed', { userId, error: error.message });
        }
    }

    // ========== FUND MANAGEMENT ==========

    async lockFunds(userId, amount, purpose) {
        const txId = generateId();

        try {
            const user = await User.findOne({ userId });
            if (!user || ((user.balance || 0) - (user.lockedBalance || 0)) < amount) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            await Transaction.create({
                txId,
                userId,
                type: 'CHEAP_OTP',
                amount: -amount,
                currency: 'USD',
                status: 'PENDING',
                metadata: { purpose, lockedAt: new Date() }
            });

            await User.updateOne(
                { userId },
                { $inc: { lockedBalance: amount } }
            );

            logger.info('Funds locked', { userId, amount, purpose, txId });

            return txId;

        } catch (error) {
            logger.error('Failed to lock funds', { userId, amount, error: error.message });
            throw error;
        }
    }

    async captureFunds(txId, userId) {
        try {
            const tx = await Transaction.findOne({ txId, userId });
            if (!tx || tx.status !== 'PENDING') {
                throw new Error('INVALID_TRANSACTION');
            }

            const amount = Math.abs(tx.amount);

            await Transaction.updateOne(
                { txId },
                {
                    $set: {
                        status: 'COMPLETED',
                        'metadata.capturedAt': new Date()
                    }
                }
            );

            await User.updateOne(
                { userId },
                {
                    $inc: {
                        lockedBalance: -amount,
                        totalSpent: amount
                    }
                }
            );

            logger.info('Funds captured', { userId, amount, txId });

            return true;

        } catch (error) {
            logger.error('Failed to capture funds', { txId, userId, error: error.message });
            throw error;
        }
    }

    async releaseFunds(txId, userId, reason) {
        try {
            const tx = await Transaction.find
