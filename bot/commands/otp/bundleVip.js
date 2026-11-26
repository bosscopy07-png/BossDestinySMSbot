// bot/commands/otp/bundleVip.js — VIP numbers and bundle purchase flows
// Mixed into OTPCommands.prototype by bot/commands/otp.js (bodies unchanged: `this` is the OTPCommands instance).
import { Markup } from 'telegraf';
import { Session, User, Number as NumberModel, Transaction } from '../../../models/index.js';
import { formatCurrency, maskOTP } from '../../../utils/helpers.js';
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import { IMAGES, KEYBOARDS } from './constants.js';

export const bundleVipMethods = {
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
    },

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
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  BUNDLE PURCHASES
    // ═══════════════════════════════════════════════════════════════════════

    
async handleBuyBundle(ctx) {
        const user = ctx.state.user;
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;
        
        const message = 
            `📦 <b>Buy OTP Bundle</b>\n\n` +
            `💰 Price: ${formatCurrency(bundlePrice)}\n` +
            `📦 Includes: ${bundleCount} OTPs\n` +
            `✅ Never expires\n` +
            `💡 Best value for regular users\n\n` +
            `Your Balance: ${formatCurrency(user.balance)}`;
            
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_bundle')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);
        
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleFirst, message, keyboard, 'HTML');
    },

    async handleConfirmBundle(ctx) {
        const user = ctx.state.user;
        const bundlePrice = config.prices?.bundlePrice || 5.00;
        const bundleCount = config.prices?.bundleOtpCount || 100;
        
        if (user.balance < bundlePrice) {
            const message = 
                `❌ <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(bundlePrice)}\n` +
                `Available: ${formatCurrency(user.balance)}\n\n` +
                `Deposit first with /deposit`;
            return this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, null, 'HTML');
        }
        
        try {
            await User.updateOne(
                { userId: user.userId }, 
                { $inc: { balance: -bundlePrice, bundleRemaining: bundleCount } }
            );
            
            await Transaction.create({
                txId: `BUNDLE_MAIN_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'BUNDLE_PURCHASE',
                amount: -bundlePrice,
                status: 'COMPLETED',
                metadata: { 
                    quantity: bundleCount, 
                    pricePerOtp: bundlePrice / bundleCount,
                    source: 'MAIN_BUNDLE_MENU'
                },
                createdAt: new Date()
            });
            
            const message = 
                `✅ <b>Bundle Purchased!</b>\n\n` +
                `📦 ${bundleCount} OTPs added\n` +
                `💰 ${formatCurrency(bundlePrice)} deducted\n` +
                `📦 Total Available: ${(user.bundleRemaining || 0) + bundleCount} OTPs\n\n` +
                `Use /otp to start requesting.`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('Bundle purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, 
                '❌ Purchase failed. Please try again.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  VIP PURCHASES
    // ═══════════════════════════════════════════════════════════════════════

    
async handleBuyVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        const currentVip = this._isVipActive(user);
        
        let message = 
            `👑 <b>Upgrade to VIP</b>\n\n`;
            
        if (currentVip) {
            message += 
                `✅ You already have VIP active!\n` +
                `⏰ Expires: ${new Date(user.vipExpiry).toLocaleDateString()}\n` +
                `📞 Number: ${user.vipPhoneNumber || 'Assigning...'}\n\n` +
                `Extend your subscription?`;
        } else {
            message += 
                `💰 Price: ${formatCurrency(vipPrice)}/month\n` +
                `✅ 50 OTPs per day\n` +
                `📞 Dedicated phone number\n` +
                `⚡ Priority routing\n` +
                `🚀 Fastest delivery\n\n` +
                `Your Balance: ${formatCurrency(user.balance)}`;
        }
            
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(currentVip ? '⏰ Extend VIP' : '✅ Confirm Upgrade', 'confirm_vip')],
            [Markup.button.callback('❌ Cancel', 'menu')]
        ]);
        
        await this.sendPhotoWithCaption(ctx, IMAGES.vipFirst, message, keyboard, 'HTML');
    },

    async handleConfirmVIP(ctx) {
        const user = ctx.state.user;
        const vipPrice = config.prices?.vipSubscription || 5.00;
        
        if (user.balance < vipPrice) {
            const message = 
                `❌ <b>Insufficient Balance</b>\n\n` +
                `Required: ${formatCurrency(vipPrice)}\n` +
                `Available: ${formatCurrency(user.balance)}\n\n` +
                `Deposit first with /deposit`;
            return this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, 
                KEYBOARDS.depositOrBack(), 'HTML'
            );
        }
        
        const expiryDate = new Date();
        if (this._isVipActive(user) && user.vipExpiry) {
            expiryDate.setTime(new Date(user.vipExpiry).getTime());
        }
        expiryDate.setMonth(expiryDate.getMonth() + 1);
        
        try {
            await User.updateOne(
                { userId: user.userId },
                {
                    $inc: { balance: -vipPrice },
                    $set: { 
                        mode: 'VIP', 
                        vipExpiry: expiryDate, 
                        vipDailyUsed: 0, 
                        vipDailyReset: new Date() 
                    }
                }
            );

            await Transaction.create({
                txId: `VIP_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'VIP_SUBSCRIPTION',
                amount: -vipPrice,
                status: 'COMPLETED',
                metadata: { expiryDate, source: 'VIP_MENU' },
                createdAt: new Date()
            });

            const assignment = await this.assignVipNumber(user.userId, 'US');
            
            let numberText = '';
            if (assignment) {
                numberText = `\n\n📱 <b>Your VIP Number:</b> <code>${assignment.phoneNumber}</code>\n🏢 Provider: ${assignment.provider}`;
            } else {
                numberText = '\n\n⚠️ Your VIP number is being assigned. Use /mynumber to check.';
            }

            const message = 
                `👑 <b>VIP Activated!</b>\n\n` +
                `⏰ Valid until: ${expiryDate.toLocaleDateString()}\n` +
                `✅ 50 OTPs per day\n` +
                `⚡ Priority delivery enabled${numberText}\n\n` +
                `Enjoy premium service!`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 My Number', 'view_my_number')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('VIP purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.otpFailed, 
                '❌ VIP upgrade failed. Please try again.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    },

    async handleCancelVipSubscription(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return ctx.answerCbQuery('❌ No active VIP subscription');
        }

        const message = 
            `❌ <b>Cancel VIP Subscription?</b>\n\n` +
            `📞 Your number: <code>${user.vipPhoneNumber || 'N/A'}</code>\n` +
            `⏰ Expires: <code>${user.vipExpiry ? new Date(user.vipExpiry).toLocaleDateString() : 'N/A'}</code>\n\n` +
            `⚠️ <b>Warning:</b> Your dedicated number will be released immediately.\n\n` +
            `Are you sure?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Yes, Cancel VIP', 'confirm_vip_cancel')],
            [Markup.button.callback('❌ No, Keep VIP', 'view_my_number')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message, keyboard, 'HTML');
    },

    async handleConfirmVipCancel(ctx) {
        const userId = ctx.from.id.toString();
        const user = ctx.state.user;
        
        try {
            await this.releaseVipNumber(userId);
            
            await User.updateOne(
                { userId },
                { 
                    $set: { 
                        vipExpiry: new Date(0), 
                        vipDailyUsed: 0,
                        mode: 'FREE'
                    } 
                }
            );

            const message = 
                `✅ <b>VIP Cancelled</b>\n\n` +
                `Your VIP subscription has been cancelled.\n` +
                `📞 Your dedicated number has been released.\n\n` +
                `You can still use FREE and CHEAP modes.`;
                
            await this.sendPhotoWithCaption(ctx, IMAGES.vipOther, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]), 'HTML'
            );
        } catch (error) {
            logger.error('VIP cancel failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Failed to cancel VIP');
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  BUNDLE QUANTITY HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    
async handleBuyBundleOtp(ctx) {
        const user = ctx.state.user;
        const prices = config.prices?.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        
        let message = `📦 <b>Buy Bundle OTPs</b>\n\nSelect quantity:\n\n`;
        const buttons = [];
        
        for (const [qty, price] of Object.entries(prices)) {
            message += `• <code>${qty}</code> OTPs — <code>${formatCurrency(price)}</code>\n`;
            buttons.push([Markup.button.callback(`📦 ${qty} OTPs (${formatCurrency(price)})`, `bundle_qty_${qty}`)]);
        }
        
        message += `\n💰 Your Balance: <code>${formatCurrency(user.balance)}</code>`;
        
        buttons.push(
            [Markup.button.callback('✏️ Custom Amount', 'bundle_qty_custom')],
            [Markup.button.callback('🔙 Back', 'view_my_number')]
        );
        
        await this.sendPhotoWithCaption(ctx, IMAGES.bundleFirst, message, Markup.inlineKeyboard(buttons), 'HTML');
    },

    async handleBundleQuantity(ctx, quantity) {
        const user = ctx.state.user;
        const prices = config.prices?.bundleOtp || { 5: 0.50, 10: 0.90, 25: 2.00, 50: 3.50 };
        const price = prices[quantity] || (quantity * 0.10);
        
        if (user.balance < price) {
            return this.sendPhotoWithCaption(
                ctx, IMAGES.bundleOther,
                `❌ <b>Insufficient Balance</b>\n\nRequired: <code>${formatCurrency(price)}</code>\nAvailable: <code>${formatCurrency(user.balance)}</code>\n\nDeposit first with /deposit`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit', 'deposit')],
                    [Markup.button.callback('🔙 Back', 'buy_bundle_otp')]
                ]),
                'HTML'
            );
        }

        ctx.session = ctx.session || {};
        ctx.session.bundlePurchase = { quantity, price };

        const message = 
            `📦 <b>Confirm Bundle Purchase</b>\n\n` +
            `Quantity: <code>${quantity}</code> OTPs\n` +
            `Price: <code>${formatCurrency(price)}</code>\n` +
            `Balance After: <code>${formatCurrency(user.balance - price)}</code>\n\n` +
            `These OTPs never expire and can be used with your VIP number.`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_bundle_purchase')],
            [Markup.button.callback('❌ Cancel', 'buy_bundle_otp')]
        ]);

        await this.sendPhotoWithCaption(ctx, IMAGES.bundleOther, message, keyboard, 'HTML');
    },

    async handleBundleQuantityCustom(ctx) {
        ctx.session = ctx.session || {};
        ctx.session.awaitingBundleQuantity = true;
        
        await this.sendPhotoWithCaption(
            ctx, IMAGES.bundleOther,
            '✏️ <b>Custom Bundle Quantity</b>\n\nSend the number of OTPs you want to purchase:\n\n<i>Minimum: 5 | Price: $0.10 per OTP</i>',
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', 'buy_bundle_otp')]
            ]),
            'HTML'
        );
    },

    async handleConfirmBundlePurchase(ctx) {
        const user = ctx.state.user;
        const purchase = ctx.session?.bundlePurchase;
        
        if (!purchase) {
            return ctx.answerCbQuery('❌ Session expired. Please start over.');
        }

        try {
            await User.updateOne(
                { userId: user.userId },
                { $inc: { balance: -purchase.price, bundleRemaining: purchase.quantity } }
            );

            await Transaction.create({
                txId: `BUNDLE_${Date.now()}_${user.userId}`,
                userId: user.userId,
                type: 'BUNDLE_PURCHASE',
                amount: -purchase.price,
                status: 'COMPLETED',
                metadata: { 
                    quantity: purchase.quantity, 
                    pricePerOtp: purchase.price / purchase.quantity,
                    source: 'BUNDLE_OTP_MENU'
                },
                createdAt: new Date()
            });

            ctx.session.bundlePurchase = null;

            const message = 
                `✅ <b>Bundle Purchased!</b>\n\n` +
                `📦 <code>${purchase.quantity}</code> OTPs added\n` +
                `💰 <code>${formatCurrency(purchase.price)}</code> deducted\n` +
                `📦 Total Available: <code>${(user.bundleRemaining || 0) + purchase.quantity}</code> OTPs\n\n` +
                `Use /otp to start requesting.`;

            await this.sendPhotoWithCaption(
                ctx, IMAGES.bundleOther, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 View My Number', 'view_my_number')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );

        } catch (error) {
            logger.error('Bundle purchase failed', { userId: user.userId, error: error.message });
            await this.sendPhotoWithCaption(
                ctx, IMAGES.otpFailed,
                '❌ <b>Purchase Failed</b>\n\nPlease try again or contact support.',
                KEYBOARDS.supportOrRetry(), 'HTML'
            );
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  REQUEST OTP VIP (direct from My Number screen)
    // ═══════════════════════════════════════════════════════════════════════

    

async handleRequestOtpVip(ctx) {
        const user = ctx.state.user;
        
        if (!this._isVipActive(user)) {
            return ctx.answerCbQuery('❌ VIP required');
        }
        
        if (!this._canUseVip(user)) {
            return ctx.answerCbQuery('❌ Daily limit reached');
        }
        
        if (!user.vipPhoneNumber) {
            const assignment = await this.assignVipNumber(user.userId, 'US');
            if (!assignment) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.vipOther,
                    '⚠️ <b>Number Assignment Pending</b>\n\nPlease try again shortly.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Retry', 'request_otp_vip')],
                        [Markup.button.callback('🔙 Back', 'view_my_number')]
                    ]),
                    'HTML'
                );
            }
            user.vipPhoneNumber = assignment.phoneNumber;
        }

        ctx.session = ctx.session || {};
        ctx.session.otpMode = 'VIP';
        ctx.session.useVipNumber = true;
        
        await this.showServiceSelection(ctx, 'VIP', IMAGES.vipOther);
    }
};

export default bundleVipMethods;
