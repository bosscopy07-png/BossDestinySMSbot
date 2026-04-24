import { ethers } from 'ethers';
import { User, Transaction } from '../../models/index.js';
import { generateId, validateAddress } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';
import config from '../../config/env.js';

class PaymentService {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(config.blockchain.rpc);
        this.masterWallet = new ethers.Wallet(config.blockchain.masterPrivateKey, this.provider);
        
        // USDT Contract
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
        
        this.decimals = 18;
        this.initialize();
    }

    async initialize() {
        try {
            this.decimals = await this.usdtContract.decimals();
            logger.info('Payment service initialized', {
                masterAddress: this.masterWallet.address,
                usdtContract: config.blockchain.usdtContract
            });
        } catch (error) {
            logger.error('Failed to initialize payment service', { error: error.message });
        }
    }

    // Generate unique deposit address for user
    async generateDepositAddress(userId) {
        try {
            const user = await User.findOne({ userId });
            if (user?.depositAddress) {
                return {
                    address: user.depositAddress,
                    isNew: false
                };
            }

            // Get next derivation index
            const lastUser = await User.findOne({ depositIndex: { $ne: null } })
                .sort({ depositIndex: -1 });
            
            const index = lastUser ? lastUser.depositIndex + 1 : 0;

            // Derive address from master key
            // Using simple index-based derivation for BSC
            const derivedWallet = this.deriveWallet(index);

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

            return {
                address: derivedWallet.address,
                isNew: true
            };

        } catch (error) {
            logger.error('Failed to generate deposit address', { userId, error: error.message });
            throw error;
        }
    }

    deriveWallet(index) {
        // Simple derivation - in production use proper HD wallet
        const path = `m/44'/60'/0'/0/${index}`;
        
        // For now, use deterministic address generation
        // In production, use ethers.HDNodeWallet
        const entropy = ethers.keccak256(
            ethers.concat([
                ethers.toUtf8Bytes(config.blockchain.masterPrivateKey),
                ethers.toUtf8Bytes(path)
            ])
        );
        
        const privateKey = ethers.keccak256(entropy);
        return new ethers.Wallet(privateKey, this.provider);
    }

    // Monitor blockchain for deposits
    async scanDeposits(userId = null) {
        try {
            const latestBlock = await this.provider.getBlockNumber();
            const fromBlock = latestBlock - 1000; // Scan last 1000 blocks

            // Get all users with deposit addresses
            const query = userId 
                ? { userId, depositAddress: { $ne: null } }
                : { depositAddress: { $ne: null } };
            
            const users = await User.find(query).select('userId depositAddress');

            for (const user of users) {
                try {
                    await this.checkUserDeposits(user, fromBlock, latestBlock);
                } catch (error) {
                    logger.error('Failed to check user deposits', {
                        userId: user.userId,
                        error: error.message
                    });
                }
            }

        } catch (error) {
            logger.error('Deposit scan failed', { error: error.message });
            throw error;
        }
    }

    async checkUserDeposits(user, fromBlock, toBlock) {
        // Check USDT transfers to user's deposit address
        const filter = this.usdtContract.filters.Transfer(
            null, // from any address
            user.depositAddress
        );

        const events = await this.usdtContract.queryFilter(filter, fromBlock, toBlock);

        for (const event of events) {
            try {
                await this.processDepositEvent(user, event);
            } catch (error) {
                logger.error('Failed to process deposit event', {
                    userId: user.userId,
                    txHash: event.transactionHash,
                    error: error.message
                });
            }
        }
    }

    async processDepositEvent(user, event) {
        const txHash = event.transactionHash;
        const amount = ethers.formatUnits(event.args.value, this.decimals);
        const amountFloat = parseFloat(amount);

        // Check if already processed
        const existing = await Transaction.findOne({ 'blockchain.txHash': txHash });
        if (existing) {
            if (existing.status === 'COMPLETED') return;
            
            // Check if now confirmed
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (receipt) {
                const latestBlock = await this.provider.getBlockNumber();
                const confirmations = latestBlock - receipt.blockNumber;

                if (confirmations >= config.blockchain.blockConfirmations) {
                    await this.confirmDeposit(existing, confirmations);
                } else {
                    await Transaction.updateOne(
                        { txId: existing.txId },
                        {
                            $set: {
                                status: 'CONFIRMING',
                                'blockchain.confirmations': confirmations
                            }
                        }
                    );
                }
            }
            return;
        }

        // Create new deposit transaction
        const tx = await Transaction.create({
            txId: generateId(),
            userId: user.userId,
            type: 'DEPOSIT',
            amount: amountFloat,
            currency: 'USDT',
            status: 'CONFIRMING',
            blockchain: {
                txHash,
                blockNumber: event.blockNumber,
                confirmations: 0,
                fromAddress: event.args.from,
                toAddress: event.args.to,
                token: 'USDT',
                amountCrypto: amount
            }
        });

        logger.info('New deposit detected', {
            userId: user.userId,
            txHash,
            amount: amountFloat
        });

        // Check confirmations immediately
        const receipt = await this.provider.getTransactionReceipt(txHash);
        if (receipt) {
            const latestBlock = await this.provider.getBlockNumber();
            const confirmations = latestBlock - receipt.blockNumber;

            if (confirmations >= config.blockchain.blockConfirmations) {
                await this.confirmDeposit(tx, confirmations);
            }
        }
    }

    async confirmDeposit(tx, confirmations) {
        try {
            // Update transaction
            await Transaction.updateOne(
                { txId: tx.txId },
                {
                    $set: {
                        status: 'COMPLETED',
                        'blockchain.confirmations': confirmations,
                        completedAt: new Date()
                    }
                }
            );

            // Credit user balance
            await User.updateOne(
                { userId: tx.userId },
                {
                    $inc: {
                        balance: tx.amount,
                        totalDeposited: tx.amount
                    }
                }
            );

            logger.info('Deposit confirmed and credited', {
                userId: tx.userId,
                amount: tx.amount,
                txHash: tx.blockchain.txHash
            });

            // Trigger referral check
            const { default: ReferralService } = await import('../referral/index.js');
            const { default: WalletService } = await import('../wallet/index.js');
            const walletService = new WalletService();
            const referralService = new ReferralService(walletService);
            
            await referralService.processDeposit(tx.userId, tx.amount);

        } catch (error) {
            logger.error('Failed to confirm deposit', {
                txId: tx.txId,
                error: error.message
            });
            throw error;
        }
    }

    // Manual deposit check (for user-initiated checks)
    async manualCheckDeposit(userId) {
        try {
            const user = await User.findOne({ userId });
            if (!user?.depositAddress) {
                return { found: false, message: 'No deposit address' };
            }

            const latestBlock = await this.provider.getBlockNumber();
            await this.checkUserDeposits(user, latestBlock - 100, latestBlock);

            // Get latest transaction
            const latestTx = await Transaction.findOne({ userId })
                .sort({ createdAt: -1 });

            if (!latestTx || latestTx.type !== 'DEPOSIT') {
                return { found: false, message: 'No deposits found' };
            }

            if (latestTx.status === 'COMPLETED') {
                return {
                    found: true,
                    status: 'CONFIRMED',
                    amount: latestTx.amount,
                    txHash: latestTx.blockchain.txHash,
                    confirmations: latestTx.blockchain.confirmations
                };
            }

            if (latestTx.status === 'CONFIRMING') {
                return {
                    found: true,
                    status: 'CONFIRMING',
                    amount: latestTx.amount,
                    txHash: latestTx.blockchain.txHash,
                    confirmations: latestTx.blockchain.confirmations,
                    required: config.blockchain.blockConfirmations
                };
            }

            return { found: false, message: 'No pending deposits' };

        } catch (error) {
            logger.error('Manual deposit check failed', { userId, error: error.message });
            throw error;
        }
    }

    // Get deposit address for user
    async getDepositAddress(userId) {
        const result = await this.generateDepositAddress(userId);
        return result.address;
    }

    // Admin: Withdraw profits to external wallet
    async withdrawProfits(toAddress, amount, adminId) {
        try {
            if (!validateAddress(toAddress)) {
                throw new Error('INVALID_ADDRESS');
            }

            const amountWei = ethers.parseUnits(amount.toString(), this.decimals);

            // Check balance
            const balance = await this.usdtContract.balanceOf(this.masterWallet.address);
            if (balance < amountWei) {
                throw new Error('INSUFFICIENT_BALANCE');
            }

            // Send transaction
            const tx = await this.usdtContract.transfer(toAddress, amountWei);
            const receipt = await tx.wait();

            // Log withdrawal
            await Transaction.create({
                txId: generateId(),
                userId: adminId,
                type: 'WITHDRAWAL',
                amount: -amount,
                currency: 'USDT',
                status: 'COMPLETED',
                processedBy: adminId,
                blockchain: {
                    txHash: receipt.hash,
                    blockNumber: receipt.blockNumber,
                    fromAddress: this.masterWallet.address,
                    toAddress: toAddress,
                    token: 'USDT',
                    amountCrypto: amount
                }
            });

            logger.info('Profit withdrawal completed', {
                adminId,
                toAddress,
                amount,
                txHash: receipt.hash
            });

            return {
                success: true,
                txHash: receipt.hash,
                amount,
                toAddress
            };

        } catch (error) {
            logger.error('Withdrawal failed', {
                adminId,
                toAddress,
                amount,
                error: error.message
            });
            throw error;
        }
    }

    // Get master wallet info
    async getMasterWalletInfo() {
        try {
            const [bnbBalance, usdtBalance] = await Promise.all([
                this.provider.getBalance(this.masterWallet.address),
                this.usdtContract.balanceOf(this.masterWallet.address)
            ]);

            return {
                address: this.masterWallet.address,
                bnb: ethers.formatEther(bnbBalance),
                usdt: ethers.formatUnits(usdtBalance, this.decimals)
            };

        } catch (error) {
            logger.error('Failed to get master wallet info', { error: error.message });
            throw error;
        }
    }
}

export default PaymentService;

 
