
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

        this.usdtAbi = [
            'function balanceOf(address) view returns (uint256)',
            'function transfer(address, uint256) returns (bool)',
            'function decimals() view returns (uint8)',
            'event Transfer(address indexed from, address indexed to, uint256 value)'
        ];

        this.initialize();
    }

    async initialize() {
        const rpcEndpoints = [
            config.blockchain.rpc,
            'https://rpc.ankr.com/bsc',
            'https://bsc-dataseed.binance.org/',
            'https://bsc-dataseed1.defibit.io/',
            'https://bsc-dataseed1.ninicoin.io/'
        ].filter((url, i, self) => self.indexOf(url) === i);

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
                    config.blockchain.masterPrivateKey, 
                    this.provider
                );
                
                this.usdtContract = new ethers.Contract(
                    config.blockchain.usdtContract,
                    this.usdtAbi,
                    this.masterWallet
                );

                this.masterAddress = this.masterWallet.address;
                this.isReady = true;

                // Start from current block - 1000 for initial scan
                this.lastCheckedBlock = await this.provider.getBlockNumber() - 1000;

                logger.info('Wallet service initialized', {
                    masterAddress: this.masterAddress,
                    rpc: rpcUrl.replace(/\/\/.*@/, '//***@')
                });

                await this.initializeDecimals();
                return;

            } catch (error) {
                logger.warn('RPC failed, trying next...', { 
                    rpc: rpcUrl.replace(/\/\/.*@/, '//***@'),
                    error: error.message 
                });
                this.provider = null;
            }
        }

        logger.error('All RPC endpoints failed — running in degraded mode');
        this.masterWallet = new ethers.Wallet(config.blockchain.masterPrivateKey);
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

    checkReady() {
        if (!this.isReady) {
            throw new Error('WALLET_NOT_READY — blockchain connection unavailable');
        }
    }

    // ========== DEPOSIT SYSTEM ==========

    async getDepositInfo(userId) {
        const user = await User.findOne({ userId });
        
        // Generate unique amount for tracking (e.g., $5.001234)
        const baseAmount = user?.pendingDeposit || 10.00;
        const trackingAmount = this.generateTrackingAmount(baseAmount, userId);

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
            network: 'BSC (BEP-20)',
            token: 'USDT',
            userId: userId
        };
    }

    // Generate unique amount by adding small fraction based on userId
    // e.g., user 12345 + $10.00 = $10.0012345
    generateTrackingAmount(baseAmount, userId) {
        const userSuffix = parseInt(userId.toString().slice(-5)) / 1000000;
        const trackingAmount = baseAmount + userSuffix;
        return parseFloat(trackingAmount.toFixed(6));
    }

    // Extract base amount from tracking amount
    getBaseAmount(trackingAmount) {
        return Math.floor(trackingAmount);
    }

    // ========== MASTER ADDRESS DEPOSIT CHECKING ==========

    async checkAllDeposits() {
        this.checkReady();

        try {
            const latestBlock = await this.provider.getBlockNumber();
            
            if (latestBlock <= this.lastCheckedBlock) {
                return [];
            }

            const filter = this.usdtContract.filters.Transfer(null, this.masterAddress);
            const events = await this.usdtContract.queryFilter(
                filter,
                this.lastCheckedBlock,
                latestBlock
            );

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

        // Skip if not to master address
        if (toAddress.toLowerCase() !== this.masterAddress.toLowerCase()) {
            return null;
        }

        // Check if already processed
        const existing = await Transaction.findOne({ 'blockchain.txHash': txHash });
        if (existing) return null;

        // Find user by tracking amount or registered wallet
        let user = await User.findOne({ 
            $or: [
                { depositTrackingAmount: amount },
                { registeredWallet: fromAddress.toLowerCase() }
            ],
            depositPending: true
        });

        // If no exact match, try fuzzy match (within $0.01)
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

        // Create deposit transaction
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

        // Credit user balance immediately (small amounts, trust-based)
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

        // Process referral
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

    // Single user deposit check (for manual trigger)
    async checkDeposit(userId) {
        this.checkReady();

        const user = await User.findOne({ userId });
        if (!user) {
            return { found: false, message: 'User not found' };
        }

        // Run full scan
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

            const minDeposit = config.referral.minDeposit;
            if (amount < minDeposit) return;

            const existingReward = await Transaction.findOne({
                userId: referrer.userId,
                type: 'REFERRAL_REWARD',
                'metadata.referredUserId': userId
            });

            if (existingReward) return;

            const rewardAmount = amount * config.referral.percentage;

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
                    percentage: config.referral.percentage,
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
            if (!user || (user.balance - (user.lockedBalance || 0)) < amount) {
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

    async addBalance(userId, amount, adminId, reason) {
        const txId = generateId();

        try {
            await Transaction.create({
                txId,
                userId,
                type: 'ADMIN_ADJUSTMENT',
                amount,
                currency: 'USD',
                status: 'COMPLETED',
                processedBy: adminId,
                metadata: { reason, isCredit: true }
            });

            await User.updateOne(
                { userId },
                { $inc: { balance: amount } }
            );

            logger.info('Balance added by admin', { userId, amount, adminId, reason });

            return txId;

        } catch (error) {
            logger.error('Failed to add balance', { userId, amount, error: error.message });
            throw error;
        }
    }

    async deductBalance(userId, amount, adminId, reason) {
        const txId = generateId();

        try {
            const user = await User.findOne({ userId });
            if (!user || user.balance < amount) {
                throw new Error('INSUFFICIENT_BALANCE');
            }

            await Transaction.create({
                txId,
                userId,
                type: 'ADMIN_ADJUSTMENT',
                amount: -amount,
                currency: 'USD',
                status: 'COMPLETED',
                processedBy: adminId,
                metadata: { reason, isDebit: true }
            });

            await User.updateOne(
                { userId },
                { $inc: { balance: -amount } }
            );

            logger.info('Balance deducted by admin', { userId, amount, adminId, reason });

            return txId;

        } catch (error) {
            logger.error('Failed to deduct balance', { userId, amount, error: error.message });
            throw error;
        }
    }

    // ========== MASTER WALLET INFO ==========

    getMasterAddress() {
        return this.masterAddress || 'WALLET_NOT_READY';
    }

    async getMasterBalance() {
        this.checkReady();

        try {
            const bnbBalance = await this.provider.getBalance(this.masterWallet.address);
            const usdtBalance = await this.usdtContract.balanceOf(this.masterWallet.address);
            
            return {
                bnb: ethers.formatEther(bnbBalance),
                usdt: ethers.formatUnits(usdtBalance, this.decimals)
            };
        } catch (error) {
            logger.error('Failed to get master balance', { error: error.message });
            throw new Error('BALANCE_CHECK_FAILED — ' + error.message);
        }
    }

    // ========== BACKGROUND SCANNER ==========

    startDepositScanner(intervalMs = 30000) {
        if (!this.isReady) {
            logger.warn('Cannot start scanner — wallet not ready');
            return;
        }

        logger.info('Starting deposit scanner', { interval: intervalMs });

        setInterval(async () => {
            try {
                await this.checkAllDeposits();
            } catch (error) {
                logger.error('Deposit scanner error', { error: error.message });
            }
        }, intervalMs);
    }
}

export default WalletService;
                
