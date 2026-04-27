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

        this.usdtAbi = [
            'function balanceOf(address) view returns (uint256)',
            'function transfer(address, uint256) returns (bool)',
            'function decimals() view returns (uint8)',
            'event Transfer(address indexed from, address indexed to, uint256 value)'
        ];

        this.initializationPromise = this.initialize();
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

        const tx = await Transaction.create({
            txId: generateId(),
            userId: user.userId,
            type: 'DEPOSIT',
            amount: amount,
            currency: 'USDT',
            status: 'CONFIRMING',
            blockchain: {
                txHash,
                blockNumber,
                confirmations: 0,
                fromAddress,
                toAddress,
                token: 'USDT',
                amountCrypto: amount.toString()
            }
        });

        await User.updateOne(
            { userId: user.userId },
            {
                $inc: { 
                    balance: amount,
                    totalDeposited: amount
                },
                $set: {
                    depositPending: false,
                    depositTrackingAmount: null,
                    lastDepositAt: new Date(),
                    registeredWallet: fromAddress.toLowerCase()
                }
            }
        );

        await this.processReferralDeposit(user.userId, amount);

        logger.info('Deposit detected and credited', {
            userId: user.userId,
            amount,
            txHash,
            from: fromAddress
        });

        return {
            userId: user.userId,
            amount,
            txHash,
            status: 'CREDITED'
        };
    }

    async checkDeposit(userId) {
        await this.ensureReady();

        const user = await User.findOne({ userId });
        if (!user) {
            return { found: false, message: 'User not found' };
        }

        const results = await this.checkAllDeposits();
        const userDeposit = results.find(r => r.userId === userId);

        if (userDeposit) {
            return {
                found: true,
                status: 'CREDITED',
                amount: userDeposit.amount,
                txHash: userDeposit.txHash
            };
        }

        return { 
            found: false, 
            message: 'No pending deposit found. Send USDT to the address shown.' 
        };
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
            const tx = await Transaction.findOne({ txId, userId });
            if (!tx || tx.status !== 'PENDING') {
                return false;
            }

            const amount = Math.abs(tx.amount);

            await Transaction.updateOne(
                { txId },
                {
                    $set: {
                        status: 'CANCELLED',
                        type: 'REFUND',
                        'metadata.releasedAt': new Date(),
                        'metadata.releaseReason': reason
                    }
                }
            );

            await User.updateOne(
                { userId },
                { $inc: { lockedBalance: -amount } }
            );

            logger.info('Funds released', { userId, amount, reason, txId });

            return true;

        } catch (error) {
            logger.error('Failed to release funds', { txId, userId, error: error.message });
            throw error;
        }
    }

    // ========== ADMIN BALANCE OPERATIONS (M0-COMPATIBLE) ==========

    /**
     * Add balance to a user (admin operation)
     * M0-compatible: no transactions, manual rollback on failure
     */
    async addBalance(userId, amount, adminId, reason) {
        const txId = generateId();

        // Validate inputs before any DB writes
        if (isNaN(amount) || amount <= 0) {
            throw new Error('INVALID_AMOUNT');
        }

        const user = await User.findOne({ userId }).select('_id userId');
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }

        let txCreated = false;

        try {
            // Step 1: Create transaction record
            await Transaction.create({
                txId,
                userId,
                type: 'ADMIN_ADD',           // ← FIXED: was 'ADMIN_ADJUSTMENT'
                amount,
                currency: 'USD',
                status: 'COMPLETED',
                processedBy: adminId,
                metadata: { reason, isCredit: true }
            });
            txCreated = true;

            // Step 2: Update user balance
            const userUpdate = await User.updateOne(
                { userId },
                { $inc: { balance: amount } }
            );

            if (userUpdate.matchedCount === 0) {
                throw new Error('USER_UPDATE_FAILED');
            }

            logger.info('Balance added by admin', { userId, amount, adminId, reason, txId });

            return txId;

        } catch (error) {
            // Rollback: delete orphaned transaction if user update failed
            if (txCreated) {
                try {
                    await Transaction.deleteOne({ txId });
                    logger.warn('Rolled back orphaned transaction', { txId, reason: error.message });
                } catch (rollbackError) {
                    logger.error('Failed to rollback transaction', { txId, error: rollbackError.message });
                }
            }

            logger.error('Failed to add balance', { userId, amount, adminId, error: error.message });
            throw error;
        }
    }

    /**
     * Deduct balance from a user (admin operation)
     * M0-compatible: no transactions, manual rollback on failure
     * Uses atomic findOneAndUpdate to prevent race conditions
     */
    async deductBalance(userId, amount, adminId, reason) {
        const txId = generateId();

        // Validate inputs before any DB writes
        if (isNaN(amount) || amount <= 0) {
            throw new Error('INVALID_AMOUNT');
        }

        let txCreated = false;

        try {
            // Step 1: Atomically check balance and deduct
            const user = await User.findOneAndUpdate(
                {
                    userId,
                    $expr: { $gte: ['$balance', amount] }  // Atomic balance check
                },
                { $inc: { balance: -amount } },
                { new: true }
            );

            if (!user) {
                throw new Error('INSUFFICIENT_BALANCE');
            }

            // Step 2: Create transaction record
            await Transaction.create({
                txId,
                userId,
                type: 'ADMIN_DEDUCT',        // ← FIXED: was 'ADMIN_ADJUSTMENT'
                amount: -amount,
                currency: 'USD',
                status: 'COMPLETED',
                processedBy: adminId,
                metadata: { reason, isDebit: true }
            });
            txCreated = true;

            logger.info('Balance deducted by admin', { userId, amount, adminId, reason, txId });

            return txId;

        } catch (error) {
            // Rollback: restore user balance if transaction creation failed
            if (txCreated === false && error.message !== 'INSUFFICIENT_BALANCE' && error.message !== 'INVALID_AMOUNT') {
                try {
                    await User.updateOne({ userId }, { $inc: { balance: amount } });
                    logger.warn('Restored user balance after failed transaction creation', { userId, amount, txId });
      
