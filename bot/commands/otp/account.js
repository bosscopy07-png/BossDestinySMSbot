// bot/commands/otp/account.js — Deposits, history, referral, stats, provider status, settings, FAQ, terms, support
// Mixed into OTPCommands.prototype by bot/commands/otp.js (bodies unchanged: `this` is the OTPCommands instance).
import { Markup } from 'telegraf';
import { Session, User, Number as NumberModel, Transaction } from '../../../models/index.js';
import { formatCurrency, maskOTP } from '../../../utils/helpers.js';
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import { IMAGES } from './constants.js';

export const accountMethods = {
    // ═══════════════════════════════════════════════════════════════════════
    //  DEPOSIT NOTIFICATION
    // ═══════════════════════════════════════════════════════════════════════

    
async handleDepositNotification(userId, data) {
        try {
            const message = 
                '✅ <b>Deposit Confirmed!</b>\n\n' +
                '💵 Amount Credited: <code>' + formatCurrency(data.amount) + '</code>\n' +
                (data.trackingFee > 0 ? '🔧 Tracking Fee: <code>' + formatCurrency(data.trackingFee) + '</code>\n' : '') +
                '🔗 TX Hash: <code>' + data.txHash + '</code>\n\n' +
                'Your balance has been updated. Use /otp to request OTPs!';

            await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });
        } catch (error) {
            logger.error('Deposit notification failed', { userId, error: error.message });
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  SUPPORT & UTILITY HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    
async handleContactSupport(ctx) {
        await ctx.reply(
            '📞 <b>Contact Support</b>\n\nNeed help? Contact us at @swiftsmssupport_bot\n\nOur team is available 24/7.',
            { 
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('📞 Contact @swiftsmssupport_bot', 'https://t.me/swiftsmssupport_bot')],
                    [Markup.button.callback('🔙 Back', 'menu')]
                ]).reply_markup
            }
        );
    },

    async handleCheckDeposit(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const result = await this.walletService.checkDeposit(userId);
            
            if (!result.found) {
                const message = 
                    '⏳ <b>No Deposit Found</b>\n\n' +
                    'Your deposit hasn\'t been detected yet.\n\n' +
                    'Make sure you:\n' +
                    '1️⃣ Sent to the correct address\n' +
                    '2️⃣ Sent exactly the shown amount\n' +
                    '3️⃣ Used BSC (BEP-20) network\n\n' +
                    '⏱ Check again in 1-2 minutes.';
                
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.default, message,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Check Again', 'check_deposit')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }
            
            if (result.status === 'CONFIRMING') {
                const message = 
                    `⏳ <b>Deposit Confirming</b>\n\n` +
                    `Amount: ${formatCurrency(result.amount)}\n` +
                    `Confirmations: ${result.confirmations || 0}/${config.blockchain?.blockConfirmations || 12}\n\n` +
                    `Please wait for full confirmation.`;
                return this.sendPhotoWithCaption(ctx, IMAGES.default, message, null, 'HTML');
            }
            
            if (result.status === 'CONFIRMED' || result.status === 'CREDITED') {
                const message = 
                    `✅ <b>Deposit Confirmed!</b>\n\n` +
                    `Amount Credited: ${formatCurrency(result.amount)}\n` +
                    (result.trackingFee > 0 ? `Tracking Fee: ${formatCurrency(result.trackingFee)}\n` : '') +
                    `TX Hash: <code>${result.txHash}</code>\n\n` +
                    `Your balance has been updated.`;
                return this.sendPhotoWithCaption(ctx, IMAGES.depositConfirmed, message, null, 'HTML');
            }
        } catch (error) {
            logger.error('Check deposit failed', { userId, error: error.message });
            await this.sendPhotoWithCaption(ctx, IMAGES.default, '❌ Error checking deposit. Please try again.');
        }
    },

    async handleDepositInfo(ctx) {
        const message = 
            '💳 <b>Deposit Information</b>\n\n' +
            'Send USDT (BEP-20) to your deposit address.\n\n' +
            'Your deposit will be credited automatically after confirmation.\n\n' +
            'Use /check_deposit to check status.';
        await this.sendPhotoWithCaption(ctx, IMAGES.default, message, null, 'HTML');
    },

            // ═══════════════════════════════════════════════════════════════════════════════
//  OTPCommands.js — Part 5: NEW FEATURES
// ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    //  HISTORY — View past OTP sessions
    // ═══════════════════════════════════════════════════════════════════════

    
async handleHistory(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const sessions = await Session.find({ userId })
                .sort({ createdAt: -1 })
                .limit(10)
                .lean();

            if (!sessions.length) {
                return this.sendPhotoWithCaption(
                    ctx, IMAGES.history,
                    '📜 <b>No History</b>\n\nYou haven\'t requested any OTPs yet.\n\nUse /otp to get started!',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('📱 Request OTP', 'menu')],
                        [Markup.button.callback('🔙 Back', 'menu')]
                    ]),
                    'HTML'
                );
            }

            let message = '📜 <b>Recent OTP History</b>\n\n';
            
            for (const s of sessions) {
                const statusEmoji = {
                    RECEIVED: '✅',
                    TIMEOUT: '⏰',
                    CANCELLED: '❌',
                    WAITING: '⏳',
                    CHECKING: '🔍'
                }[s.status] || '❓';
                
                const date = new Date(s.createdAt).toLocaleDateString();
                const time = new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                
                message += `${statusEmoji} <b>${s.service}</b> — ${date} ${time}\n`;
                message += `   📱 ${this.maskPhone(s.number)} | ${s.mode}`;
                if (s.otpCode) message += ` | 🔢 ${s.otpCode}`;
                message += '\n\n';
            }

            await this.sendPhotoWithCaption(
                ctx, IMAGES.history, message,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Request OTP', 'menu')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );
        } catch (error) {
            logger.error('History fetch failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error loading history');
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  REFERRAL — Invite friends, earn credits
    // ═══════════════════════════════════════════════════════════════════════

    
async handleReferral(ctx) {
        const user = ctx.state.user;
        const botUsername = ctx.botInfo?.username || 'SwiftSMSBot';
        const referralLink = `https://t.me/${botUsername}?start=ref_${user.userId}`;
        
        const referralBonus = config.referral?.bonus || 0.50;
        const referralCount = user.referrals?.length || 0;
        const referralEarnings = user.referralEarnings || 0;

        const message = 
            `👥 <b>Referral Program</b>\n\n` +
            `Invite friends and earn <code>${formatCurrency(referralBonus)}</code> per signup!\n\n` +
            `📊 <b>Your Stats:</b>\n` +
            `• Invited: <code>${referralCount}</code> users\n` +
            `• Earned: <code>${formatCurrency(referralEarnings)}</code>\n\n` +
            `🔗 <b>Your Link:</b>\n<code>${referralLink}</code>\n\n` +
            `<i>Share this link with friends. When they make their first deposit, you get paid!</i>`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.referral, message,
            Markup.inlineKeyboard([
                [Markup.button.url('📤 Share Link', `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Get OTPs instantly with SwiftSMS!')}`)],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  STATS — User statistics dashboard
    // ═══════════════════════════════════════════════════════════════════════

    
async handleStats(ctx) {
        const user = ctx.state.user;
        const stats = this._getUserStats(user);

        const totalSessions = await Session.countDocuments({ userId: user.userId });
        const successfulSessions = await Session.countDocuments({ userId: user.userId, status: 'RECEIVED' });
        const successRate = totalSessions > 0 ? Math.round((successfulSessions / totalSessions) * 100) : 0;

        const message = 
            `📊 <b>Your Statistics</b>\n\n` +
            `👤 <b>Account</b>\n` +
            `• Balance: <code>${formatCurrency(stats.balance)}</code>\n` +
            `• Available: <code>${formatCurrency(stats.available)}</code>\n\n` +
            `📱 <b>OTP Usage</b>\n` +
            `• Total Requests: <code>${totalSessions}</code>\n` +
            `• Successful: <code>${successfulSessions}</code>\n` +
            `• Success Rate: <code>${successRate}%</code>\n\n` +
            `👑 <b>VIP Status</b>\n` +
            `• Active: ${stats.isVip ? '✅ Yes' : '❌ No'}\n` +
            `• Days Left: <code>${stats.vipDays}</code>\n` +
            `• Daily Remaining: <code>${stats.vipRemaining}</code>\n\n` +
            `📦 <b>Credits</b>\n` +
            `• Free Today: <code>${stats.freeRemaining}</code>\n` +
            `• Bundle Left: <code>${stats.bundleRemaining}</code>`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.stats, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('📜 Full History', 'history')],
                [Markup.button.callback('💳 Deposit', 'deposit')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  PROVIDER STATUS — Check system health
    // ═══════════════════════════════════════════════════════════════════════

    
async handleProviderStatus(ctx) {
        try {
            let statusMessage = '🔌 <b>System Status</b>\n\n';
            
            if (this.smsProviderManager) {
                const providers = await this.smsProviderManager.getProviderStatus?.() || [];
                
                for (const p of providers) {
                    const emoji = p.healthy ? '🟢' : '🔴';
                    statusMessage += `${emoji} <b>${p.name}</b>: ${p.healthy ? 'Online' : 'Offline'}`;
                    if (p.balance !== undefined) statusMessage += ` | Balance: ${formatCurrency(p.balance)}`;
                    statusMessage += '\n';
                }
            } else {
                statusMessage += '⚠️ Provider manager not available\n';
            }

            statusMessage += '\n📊 <b>General:</b>\n';
            statusMessage += `• Uptime: <code>99.9%</code>\n`;
            statusMessage += `• Avg Delivery: <code>12s</code>\n`;
            statusMessage += `• Queue: <code>Normal</code>`;

            await this.sendPhotoWithCaption(
                ctx, IMAGES.default, statusMessage,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'provider_status')],
                    [Markup.button.callback('🔙 Main Menu', 'menu')]
                ]),
                'HTML'
            );
        } catch (error) {
            logger.error('Provider status failed', { error: error.message });
            await ctx.answerCbQuery('❌ Error checking status');
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  SETTINGS — User preferences
    // ═══════════════════════════════════════════════════════════════════════

    
async handleSettings(ctx) {
        const user = ctx.state.user;
        
        const message = 
            `⚙️ <b>Settings</b>\n\n` +
            `🔔 Notifications: ${user.notifications !== false ? '✅ On' : '❌ Off'}\n` +
            `🌐 Language: <code>English</code>\n` +
            `💱 Currency: <code>USD</code>\n\n` +
            `Manage your preferences:`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback(`${user.notifications !== false ? '🔕' : '🔔'} Toggle Notifications`, 'toggle_notifications')],
                [Markup.button.callback('📜 Terms of Service', 'terms')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    },

    async handleToggleNotifications(ctx) {
        const userId = ctx.from.id.toString();
        
        try {
            const user = await User.findOne({ userId });
            const newState = !(user.notifications !== false);
            
            await User.updateOne({ userId }, { $set: { notifications: newState } });
            
            await ctx.answerCbQuery(newState ? '🔔 Notifications enabled' : '🔕 Notifications disabled');
            return this.handleSettings(ctx);
        } catch (error) {
            logger.error('Toggle notifications failed', { userId, error: error.message });
            await ctx.answerCbQuery('❌ Error updating settings');
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  FAQ — Frequently asked questions
    // ═══════════════════════════════════════════════════════════════════════

    
async handleFaq(ctx) {
        const message = 
            `❓ <b>Frequently Asked Questions</b>\n\n` +
            `<b>Q: How long do I wait for an OTP?</b>\n` +
            `A: Usually 5-30 seconds. VIP/CHEAP are fastest. Free may take longer.\n\n` +
            `<b>Q: What if I don't receive my OTP?</b>\n` +
            `A: Free mode has no guarantee. For CHEAP/VIP, contact support if timed out.\n\n` +
            `<b>Q: Can I reuse my VIP number?</b>\n` +
            `A: Yes! Your VIP number is dedicated to you for the subscription period.\n\n` +
            `<b>Q: Do bundle OTPs expire?</b>\n` +
            `A: No, bundle OTPs never expire.\n\n` +
            `<b>Q: What payment methods?</b>\n` +
            `A: We accept USDT (BEP-20) on Binance Smart Chain.\n\n` +
            `<b>Q: Is there a refund policy?</b>\n` +
            `A: Free mode: no refunds. Paid modes: refunded if provider fails.\n\n` +
            `Need more help? Contact @Swiftsmssupport`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('📞 Contact Support', 'contact_support')],
                [Markup.button.callback('📜 Terms', 'terms')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  TERMS — Terms of service
    // ═══════════════════════════════════════════════════════════════════════

    
async handleTerms(ctx) {
        const message = 
            `📜 <b>Terms of Service</b>\n\n` +
            `By using this bot, you agree to:\n\n` +
            `1️⃣ <b>Legal Use Only</b>\n` +
            `OTP services must be used for legitimate purposes only.\n\n` +
            `2️⃣ <b>No Abuse</b>\n` +
            `Spam, harassment, or fraudulent use will result in permanent ban.\n\n` +
            `3️⃣ <b>Service Availability</b>\n` +
            `We do not guarantee 100% uptime. Free tier is best-effort.\n\n` +
            `4️⃣ <b>Refunds</b>\n` +
            `Refunds are issued only for provider failures, not user error.\n\n` +
            `5️⃣ <b>Data</b>\n` +
            `We store minimal data required for service operation.\n\n` +
            `6️⃣ <b>Changes</b>\n` +
            `Terms may change. Continued use means acceptance.\n\n` +
            `Violation of these terms may result in account suspension.`;

        await this.sendPhotoWithCaption(
            ctx, IMAGES.default, message,
            Markup.inlineKeyboard([
                [Markup.button.callback('❓ FAQ', 'faq')],
                [Markup.button.callback('🔙 Main Menu', 'menu')]
            ]),
            'HTML'
        );
    }
};

export default accountMethods;
