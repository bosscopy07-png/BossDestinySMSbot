import { ethers } from 'ethers';
import { User, Transaction } from '../../models/index.js';
import { generateId, validateAddress } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class WalletService {
    constructor() {
        this.masterAddress = null;
        this.decimals = 18;
        this.derivationIndex = 0;
        this.provider = null;
        this.masterWallet = null;
        this.usdtContract = null;
        this.isReady = false;

        // USDT Contract ABI (minimal for transfers and balance checks)
        this.usdtAbi = [
            'function balanceOf(address) view returns (uint256)',
            'function transfer(address, uint256) returns (bool)',
            'function decimals() view returns (uint8)',
            'event Transfer(address indexed from, address indexed to, uint256 value)'
        ];

        this.initialize();
    }

    async initialize() {
        try {
            // Initialize provider with retry logic
            this.provider = new ethers.JsonRpcProvider(config.blockchain.rpc, undefined, {
                staticNetwork: true,
                batchMaxCount: 1
            });

            // Test connection before creating wallet
            await this.provider.getNetwork();
            
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

            logger.info('Wallet service initialized', {
                masterAddress: this.masterAddress,
                rpc: config.blockchain.rpc.replace(/\/\/.*@/, '//***@') // hide credentials in logs
            });

            await this.initializeDecimals();

        } catch (error) {
            logger.error('Wallet service initialization failed — running in degraded mode', { 
                error: error.message,
                rpc: config.blockchain.rpc.replace(/\/\/.*@/, '//***@')
            });
            
            // Still create wallet offline for address derivation
            this.masterWallet = new ethers.Wallet(config.blockchain.masterPrivateKey);
            this.masterAddress = this.masterWallet.address;
            this.isReady = false;
        }
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

    // Check if wallet is ready before operations
    checkReady() {
        if (!this.isReady) {
            throw new Error('WALLET_NOT_READY — blockchain connection unavailable. Check RPC URL or try again later.');
        }
    }

    // Generate unique deposit address for user using HD wallet derivation
    async generateDepositAddress(userId) {
        try {
            const user = await User.findOne({ userId });
            if (user && user.depositAddress) {
                return user.depositAddress;
            }

            const index = await this.getNextDerivationIndex();
            const path = `m/44'/60'/0'/0/${index}`;
            
            const masterNode = ethers.HDNodeWallet.fromPhrase(
                await this.masterWallet.mnemonic?.phrase || '',
                '',
                "m/44'/60'/0'/0"
            );
            
            const derivedWallet = masterNode.derivePath(path);
            
            await User.updateOne(
                { userId },
                {
                    $set: {
                        depositAddress: derivedWallet.address,
                        depositIndex: index
                    }
                },
                { upsert: true }
            );

            logger.info('Deposit address generated', {
                userId,
                address: derivedWallet.address,
                index
            });

            return derivedWallet.address;

        } catch (error) {
            logger.error('Failed to generate deposit address', {
                userId,
                error: error.message
            });
            throw error;
        }
    }

    async getNextDerivationIndex() {
        const lastUser = await User.findOne({ depositIndex: { $ne: null } })
            .sort({ depositIndex: -1 });
        
        return lastUser ? lastUser.depositIndex + 1 : 0;
    }

    // Monitor blockchain for deposits to user address
    async checkDeposit(userId) {
        this.checkReady();

        try {
            const user = await User.findOne({ userId });
            if (!user || !user.depositAddress) {
                return { found: false, message: 'No deposit address found' };
            }

            const balance = await this.usdtContract.balanceOf(user.depositAddress);
            const formattedBalance = ethers.formatUnits(balance, this.decimals);

            const pendingTx = await Transaction.findOne({
                userId,
                type: 'DEPOSIT',
                status: { $in: ['PENDING', 'CONFIRMING'] }
            }).sort({ createdAt: -1 });

            const latestBlock = await this.provider.getBlockNumber();

            if (pendingTx && pendingTx.blockchain?.txHash) {
                const receipt = await this.provider.getTransactionReceipt(
                    pendingTx.blockchain.txHash
                );

                if (receipt) {
                    const confirmations = latestBlock - receipt.blockNumber;

                    if (confirmations >= config.blockchain.blockConfirmations) {
                        await this.confirmDeposit(pendingTx, confirmations);
                        return {
                            found: true,
                            status: 'CONFIRMED',
                            amount: pendingTx.amount,
                            txHash: pendingTx.blockchain.txHash
                        };
                    } else {
                        await Transaction.updateOne(
                            { txId: pendingTx.txId },
                            {
                                $set: {
                                    status: 'CONFIRMING',
                                    'blockchain.confirmations': confirmations
                                }
                            }
                        );
                        return {
                            found: true,
                            status: 'CONFIRMING',
                            confirmations,
                            required: config.blockchain.blockConfirmations
                        };
                    }
                }
            }

            const filter = this.usdtContract.filters.Transfer(null, user.depositAddress);
            const events = await this.usdtContract.queryFilter(
                filter,
                latestBlock - 1000,
                latestBlock
            );

            if (events.length > 0) {
                const latestEvent = events[events.length - 1];
                const amount = ethers.formatUnits(latestEvent.args.value, this.decimals);
                const txHash = latestEvent.transactionHash;

                const existing = await Transaction.findOne({
                    'blockchain.txHash': txHash
                });

                if (!existing) {
                    await Transaction.create({
                        txId: generateId(),
                        userId,
                        type: 'DEPOSIT',
                        amount: parseFloat(amount),
                        currency: 'USDT',
                        status: 'CONFIRMING',
                        blockchain: {
                            txHash,
                            blockNumber: latestEvent.blockNumber,
                            confirmations: 0,
                            fromAddress: latestEvent.args.from,
                            toAddress: user.depositAddress,
                            token: 'USDT',
                            amountCrypto: amount
                        }
                    });

                    return {
                        found: true,
                        status: 'CONFIRMING',
                        amount: parseFloat(amount),
                        txHash
                    };
                }
            }

            return { found: false, balance: formattedBalance };

        } catch (error) {
            logger.error('Deposit check failed', { userId, error: error.message });
            throw error;
        }
    }

    async confirmDeposit(transaction, confirmations) {
        try {
            await Transaction.updateOne(
                { txId: transaction.txId },
                {
                    $set: {
                        status: 'COMPLETED',
                        'blockchain.confirmations': confirmations
                    }
                }
            );

            await User.updateOne(
                { userId: transaction.userId },
                {
                    $inc: {
                        balance: transaction.amount,
                        totalDeposited: transaction.amount
                    }
                }
            );

            await this.processReferralDeposit(transaction.userId, transaction.amount);

            logger.info('Deposit confirmed and credited', {
                userId: transaction.userId,
                amount: transaction.amount,
                txHash: transaction.blockchain.txHash
            });

        } catch (error) {
            logger.error('Failed to confirm deposit', {
                txId: transaction.txId,
                error: error.message
            });
            throw error;
        }
    }

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

    async getDepositAddress(userId) {
        const user = await User.findOne({ userId });
        if (user && user.depositAddress) {
            return user.depositAddress;
        }
        return await this.generateDepositAddress(userId);
    }

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
}

export default WalletService;
                        
