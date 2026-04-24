import { ethers } from 'ethers';
import { User, Transaction } from '../../models/index.js';
import { generateId, validateAddress } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class WalletService {
    constructor() {
        // Initialize master wallet from private key
        this.provider = new ethers.JsonRpcProvider(config.blockchain.rpc);
        this.masterWallet = new ethers.Wallet(config.blockchain.masterPrivateKey, this.provider);
        
        // USDT Contract ABI (minimal for transfers and balance checks)
        this.usdtAbi = [
            'function balanceOf(address) view returns (uint256)',
            'function transfer(address, uint256) returns (bool)',
            'function decimals() view returns (uint8)',
            'event Transfer(address indexed from, address indexed to, uint256 value)'
        ];
        
        this.usdtContract = new ethers.Contract(
            config.blockchain.usdtContract,
            this.usdtAbi,
            this.masterWallet
        );
        
        this.decimals = 18; // Will be fetched from contract
        this.derivationIndex = 0;
        
        logger.info('Wallet service initialized', {
            masterAddress: this.masterWallet.address
        });
        
        this.initializeDecimals();
    }

    async initializeDecimals() {
        try {
            this.decimals = await this.usdtContract.decimals();
        } catch (error) {
            logger.error('Failed to get USDT decimals', { error: error.message });
            this.decimals = 18;
        }
    }

    // Generate unique deposit address for user using HD wallet derivation
    async generateDepositAddress(userId) {
        try {
            const user = await User.findOne({ userId });
            if (user && user.depositAddress) {
                return user.depositAddress;
            }

            // Derive address from master key using user index
            const index = await this.getNextDerivationIndex();
            const path = `m/44'/60'/0'/0/${index}`;
            
            // Create HD node from master private key
            const masterNode = ethers.HDNodeWallet.fromPhrase(
                await this.masterWallet.mnemonic?.phrase || '',
                '',
                "m/44'/60'/0'/0"
            );
            
            const derivedWallet = masterNode.derivePath(path);
            
            // Save to user
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
        try {
            const user = await User.findOne({ userId });
            if (!user || !user.depositAddress) {
                return { found: false, message: 'No deposit address found' };
            }

            // Get USDT balance of user's deposit address
            const balance = await this.usdtContract.balanceOf(user.depositAddress);
            const formattedBalance = ethers.formatUnits(balance, this.decimals);

            // Check if there's a pending transaction for this user
            const pendingTx = await Transaction.findOne({
                userId,
                type: 'DEPOSIT',
                status: { $in: ['PENDING', 'CONFIRMING'] }
            }).sort({ createdAt: -1 });

            // Get latest block number
            const latestBlock = await this.provider.getBlockNumber();

            if (pendingTx && pendingTx.blockchain?.txHash) {
                // Check confirmations
                const receipt = await this.provider.getTransactionReceipt(
                    pendingTx.blockchain.txHash
                );

                if (receipt) {
                    const confirmations = latestBlock - receipt.blockNumber;

                    if (confirmations >= config.blockchain.blockConfirmations) {
                        // Deposit confirmed
                        await this.confirmDeposit(pendingTx, confirmations);
                        return {
                            found: true,
                            status: 'CONFIRMED',
                            amount: pendingTx.amount,
                            txHash: pendingTx.blockchain.txHash
                        };
                    } else {
                        // Still confirming
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

            // Check for new deposits by looking at Transfer events
            const filter = this.usdtContract.filters.Transfer(
                null, // from any address
                user.depositAddress
            );

            const events = await this.usdtContract.queryFilter(
                filter,
                latestBlock - 1000, // Look back 1000 blocks
                latestBlock
            );

            if (events.length > 0) {
                // Process the most recent event
                const latestEvent = events[events.length - 1];
                const amount = ethers.formatUnits(latestEvent.args.value, this.decimals);
                const txHash = latestEvent.transactionHash;

                // Check if already processed
                const existing = await Transaction.findOne({
                    'blockchain.txHash': txHash
                });

                if (!existing) {
                    // Create new deposit transaction
                    const tx = await Transaction.create({
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
            // Update transaction
            await Transaction.updateOne(
                { txId: transaction.txId },
                {
                    $set: {
                        status: 'COMPLETED',
                        'blockchain.confirmations': confirmations
                    }
                }
            );

            // Credit user balance
            await User.updateOne(
                { userId: transaction.userId },
                {
                    $inc: {
                        balance: transaction.amount,
                        totalDeposited: transaction.amount
                    }
                }
            );

            // Check for referral reward
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

            // Check if minimum deposit met
            const minDeposit = config.referral.minDeposit;
            if (amount < minDeposit) return;

            // Check if already rewarded for this referral
            const existingReward = await Transaction.findOne({
                userId: referrer.userId,
                type: 'REFERRAL_REWARD',
                'metadata.referredUserId': userId
            });

            if (existingReward) return;

            // Calculate reward (percentage of deposit)
            const rewardAmount = amount * config.referral.percentage;

            // Create pending reward transaction (requires admin approval)
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

            // Update referrer stats
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

    // Lock funds before providing service
    async lockFunds(userId, amount, purpose) {
        const txId = generateId();

        try {
            const user = await User.findOne({ userId });
            if (!user || user.getAvailableBalance() < amount) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            // Create hold transaction
            await Transaction.create({
                txId,
                userId,
                type: 'CHEAP_OTP',
                amount: -amount,
                currency: 'USD',
                status: 'PENDING',
                metadata: { purpose, lockedAt: new Date() }
            });

            // Lock balance
            await User.updateOne(
                { userId },
                {
                    $inc: {
                        lockedBalance: amount
                    }
                }
            );

            logger.info('Funds locked', { userId, amount, purpose, txId });

            return txId;

        } catch (error) {
            logger.error('Failed to lock funds', { userId, amount, error: error.message });
            throw error;
        }
    }

    // Capture locked funds (service delivered)
    async captureFunds(txId, userId) {
        try {
            const tx = await Transaction.findOne({ txId, userId });
            if (!tx || tx.status !== 'PENDING') {
                throw new Error('INVALID_TRANSACTION');
            }

            const amount = Math.abs(tx.amount);

            // Update transaction
            await Transaction.updateOne(
                { txId },
                {
                    $set: {
                        status: 'COMPLETED',
                        'metadata.capturedAt': new Date()
                    }
                }
            );

            // Move from locked to spent
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

    // Release locked funds (service failed)
    async releaseFunds(txId, userId, reason) {
        try {
            const tx = await Transaction.findOne({ txId, userId });
            if (!tx || tx.status !== 'PENDING') {
                return false;
            }

            const amount = Math.abs(tx.amount);

            // Update transaction as refund
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

            // Return to available balance
            await User.updateOne(
                { userId },
                {
                    $inc: {
                        lockedBalance: -amount
                    }
                }
            );

            logger.info('Funds released', { userId, amount, reason, txId });

            return true;

        } catch (error) {
            logger.error('Failed to release funds', { txId, userId, error: error.message });
            throw error;
        }
    }

    // Admin: Add balance manually
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

    // Admin: Deduct balance
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

    // Get user's deposit address
    async getDepositAddress(userId) {
        const user = await User.findOne({ userId });
        if (user && user.depositAddress) {
            return user.depositAddress;
        }
        return await this.generateDepositAddress(userId);
    }

    // Get master wallet address (for admin)
    getMasterAddress() {
        return this.masterWallet.address;
    }

    // Get master wallet balance
    async getMasterBalance() {
        try {
            const bnbBalance = await this.provider.getBalance(this.masterWallet.address);
            const usdtBalance = await this.usdtContract.balanceOf(this.masterWallet.address);
            
            return {
                bnb: ethers.formatEther(bnbBalance),
                usdt: ethers.formatUnits(usdtBalance, this.decimals)
            };
        } catch (error) {
            logger.error('Failed to get master balance', { error: error.message });
            throw error;
        }
    }
}

export default WalletService;


