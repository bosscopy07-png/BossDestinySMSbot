// bot/commands/admin/settings.js — Settings, price/VIP/free/provider configuration, exports and bulk menus
// Methods are mixed into AdminCommands.prototype by bot/commands/admin.js (bodies unchanged: `this` is the AdminCommands instance).
import { Markup } from 'telegraf';
import { User, Transaction, Settings } from '../../../models/index.js';
import { formatCurrency } from '../../../utils/helpers.js';
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import { ADMIN_STATE } from './constants.js';

export const settingsMethods = {
    // ═══════════════════════════════════════════════════════════
    //  BUNDLE PRICES
    // ═══════════════════════════════════════════════════════════

    

    
async processSetBundleOtpPrices(ctx, text) {
        try {
            const pairs = text.split(',').map(p => p.trim());
            const prices = {};
            
            for (const pair of pairs) {
                const [qty, price] = pair.split(':').map(s => s.trim());
                const quantity = parseInt(qty);
                const cost = parseFloat(price);
                
                if (isNaN(quantity) || isNaN(cost) || quantity < 1 || cost < 0) {
                    return this.replyError(ctx, '❌ <b>Invalid format.</b>\n\nUse: <code>5:0.50,10:0.90</code>');
                }
                prices[quantity] = cost;
            }

            if (!config.prices) config.prices = {};
            config.prices.bundleOtp = prices;
            await this._saveSettings();

            await this.replySuccess(ctx, `✅ <b>Bundle OTP Prices Updated!</b>\n\n${Object.entries(prices).map(([q, p]) => `• ${q} OTPs: ${formatCurrency(p)}`).join('\n')}`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back', 'admin_bundleprices')]
                ]).reply_markup
            });

            await this.logAdminAction(ctx.from.id.toString(), 'SET_BUNDLE_OTP_PRICES', null, { prices });

        } catch (error) {
            logger.error('Set bundle OTP prices error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to update prices.</b>');
        }
    },

    async processSetBundlePackPrice(ctx, text) {
        try {
            const pairs = text.split(',').map(p => p.trim());
            let price, count;

            for (const pair of pairs) {
                const [key, value] = pair.split(':').map(s => s.trim());
                if (key === 'price') price = parseFloat(value);
                if (key === 'count') count = parseInt(value);
            }

            if (isNaN(price) || isNaN(count) || price < 0 || count < 1) {
                return this.replyError(ctx, '❌ <b>Invalid format.</b>\n\nUse: <code>price:5.00,count:100</code>');
            }

            if (!config.prices) config.prices = {};
            config.prices.bundlePrice = price;
            config.prices.bundleOtpCount = count;
            await this._saveSettings();

            await this.replySuccess(ctx, `✅ <b>Bundle Pack Price Updated!</b>\n\nPrice: <code>${formatCurrency(price)}</code>\nCount: <code>${count}</code> OTPs`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back', 'admin_bundleprices')]
                ]).reply_markup
            });

            await this.logAdminAction(ctx.from.id.toString(), 'SET_BUNDLE_PACK_PRICE', null, { price, count });

        } catch (error) {
            logger.error('Set bundle pack price error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to update price.</b>');
        }
    },

    async handleSetBundlePriceCommand(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/setbundleprice &lt;otp|pack&gt;</code>\n\nUse buttons for easier setup.');
        }
        const type = args[1].toLowerCase();
        if (type === 'otp') {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SET_BUNDLE_OTP_PRICE);
            return this.replySuccess(ctx, 
                '💰 <b>Set Bundle OTP Prices</b>\n\n' +
                'Send prices in format:\n' +
                '<code>5:0.50,10:0.90,25:2.00,50:3.50</code>'
            );
        } else if (type === 'pack') {
            this._setAdminState(ctx, ADMIN_STATE.AWAITING_SET_BUNDLE_PRICE);
            return this.replySuccess(ctx, 
                '💰 <b>Set Bundle Pack Price</b>\n\n' +
                'Send price and count:\n' +
                '<code>price:5.00,count:100</code>'
            );
        } else {
            return this.replyError(ctx, '❌ <b>Invalid type.</b>\n\nUse <code>otp</code> or <code>pack</code>.');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  SETTINGS (with DB Persistence)
    // ═══════════════════════════════════════════════════════════

    
async handleSettings(ctx) {
        try {
            const settings = await this.getCurrentSettings();

            const message = `
<b>🔧 Admin Settings</b>

<b>💰 OTP Prices:</b>
• Cheap OTP: <code>${formatCurrency(settings.cheapOtpPrice)}</code>
• VIP OTP: <code>${formatCurrency(settings.vipOtpPrice)}</code>

<b>👑 VIP Subscription:</b>
• Price: <code>${formatCurrency(settings.vipPrice)}</code>
• Duration: <code>${settings.vipDuration}</code> days

<b>🆓 Free Limits:</b>
• Daily: <code>${settings.freeDaily}</code> OTPs
• Per Number: <code>${settings.freePerNumber}</code>

<b>⚡ Providers:</b>
• Twilio: ${settings.twilioEnabled ? '✅' : '❌'}
• Telnyx: ${settings.telnyxEnabled ? '✅' : '❌'}
• Cheap Panel: ${settings.cheapPanelEnabled ? '✅' : '❌'}
• Free Public: ${settings.freePublicEnabled ? '✅' : '❌'}

<b>📦 Pool:</b>
• Auto-buy: ${settings.poolAutoBuy ? '✅' : '❌'}
• Min stock: <code>${settings.poolMinStock}</code>

<b>🛠 Maintenance:</b> ${settings.maintenanceMode ? '🔴 ON' : '🟢 OFF'}
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💰 OTP Prices', 'settings_prices')],
                [Markup.button.callback('👑 VIP Config', 'settings_vip')],
                [Markup.button.callback('🆓 Free Limits', 'settings_free')],
                [Markup.button.callback('⚡ Providers', 'settings_providers')],
                [Markup.button.callback('📦 Pool', 'settings_pool')],
                [Markup.button.callback('🛠 Maintenance', 'settings_maintenance')],
                [Markup.button.callback('🔙 Back', 'admin')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Settings error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to load settings.</b>');
        }
    },

    async getCurrentSettings() {
        return {
            cheapOtpPrice: config.prices?.cheapOtp || 0.50,
            vipOtpPrice: config.prices?.vipOtp || 0.30,
            vipPrice: config.prices?.vipSubscription || 5.00,
            vipDuration: config.prices?.vipDuration || 30,
            freeDaily: config.limits?.freeDaily || 3,
            freePerNumber: config.limits?.freePerNumber || 1,
            twilioEnabled: config.providers?.twilio !== false,
            telnyxEnabled: config.providers?.telnyx !== false,
            cheapPanelEnabled: config.providers?.cheapPanel !== false,
            freePublicEnabled: config.providers?.freePublic !== false,
            poolAutoBuy: config.pool?.autoBuy !== false,
            poolMinStock: config.pool?.minStock || 5,
            maintenanceMode: config.maintenance || false
        };
    },

    // ─── Settings Submenus ───

    
async handleSettingsPrices(ctx) {
        const currentCheap = formatCurrency(config.prices?.cheapOtp || 0.50);
        const currentVip = formatCurrency(config.prices?.vipOtp || 0.30);

        const message = `
<b>💰 Update OTP Prices</b>

<b>Current:</b>
• Cheap OTP: <code>${currentCheap}</code>
• VIP OTP: <code>${currentVip}</code>

<b>To update, use:</b>
<code>/setprice cheap &lt;amount&gt;</code>
<code>/setprice vip &lt;amount&gt;</code>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    async handleSettingsVip(ctx) {
        const currentPrice = formatCurrency(config.prices?.vipSubscription || 5.00);
        const currentDuration = config.prices?.vipDuration || 30;

        const message = `
<b>👑 VIP Configuration</b>

<b>Current:</b>
• Price: <code>${currentPrice}</code>
• Duration: <code>${currentDuration}</code> days

<b>To update, use:</b>
<code>/setvip price &lt;amount&gt;</code>
<code>/setvip days &lt;number&gt;</code>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    async handleSettingsFree(ctx) {
        const currentDaily = config.limits?.freeDaily || 3;
        const currentPerNumber = config.limits?.freePerNumber || 1;

        const message = `
<b>🆓 Free OTP Limits</b>

<b>Current:</b>
• Daily per user: <code>${currentDaily}</code>
• Per number: <code>${currentPerNumber}</code>

<b>To update, use:</b>
<code>/setfree daily &lt;number&gt;</code>
<code>/setfree pernumber &lt;number&gt;</code>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    async handleSettingsProviders(ctx) {
        const twilio = config.providers?.twilio !== false ? '✅' : '❌';
        const telnyx = config.providers?.telnyx !== false ? '✅' : '❌';
        const cheapPanel = config.providers?.cheapPanel !== false ? '✅' : '❌';
        const freePublic = config.providers?.freePublic !== false ? '✅' : '❌';

        const message = `
<b>⚡ Provider Settings</b>

<b>Current Status:</b>
• Twilio: ${twilio}
• Telnyx: ${telnyx}
• Cheap Panel: ${cheapPanel}
• Free Public: ${freePublic}

<b>Toggle providers on/off:</b>
<code>/toggleprovider twilio</code>
<code>/toggleprovider telnyx</code>
<code>/toggleprovider cheappanel</code>
<code>/toggleprovider freepublic</code>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    async handleSettingsPool(ctx) {
        const autoBuy = config.pool?.autoBuy !== false ? '✅' : '❌';
        const minStock = config.pool?.minStock || 5;

        const message = `
<b>📦 Pool Settings</b>

<b>Current:</b>
• Auto-buy: ${autoBuy}
• Min stock: <code>${minStock}</code>

<i>Pool auto-buy triggers when available numbers fall below minimum stock.</i>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'admin_settings')]
        ]);

        await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    async handleSettingsMaintenance(ctx) {
        try {
            const current = config.maintenance || false;
            config.maintenance = !current;

            // Persist to DB immediately
            await this._saveSettings();

            // Notify other admins about the change
            const adminIds = (config.bot?.adminId || '')
                .toString()
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            for (const adminId of adminIds) {
                if (adminId === ctx.from.id.toString()) continue;
                await ctx.telegram.sendMessage(adminId, `
<b>🛠 Maintenance Mode ${!current ? 'ENABLED' : 'DISABLED'}</b>

Changed by admin: <code>${ctx.from.id}</code>

Users will ${!current ? 'see a maintenance message' : 'have normal access'}.
                `, { parse_mode: 'HTML' }).catch(() => {});
            }

            const message = `
<b>🛠 Maintenance Mode ${!current ? 'ENABLED' : 'DISABLED'}</b>

Users will ${!current ? 'see a maintenance message' : 'have normal access'}.

<i>Setting has been saved to database.</i>
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Back', 'admin_settings')]
            ]);

            await this.editCaption(ctx, message, { reply_markup: keyboard.reply_markup });

            logger.info('Maintenance mode toggled', {
                admin: ctx.from.id,
                enabled: !current
            });
        } catch (error) {
            logger.error('Maintenance toggle error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to toggle maintenance mode.</b>');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  SET COMMANDS (with DB Persistence)
    // ═══════════════════════════════════════════════════════════

    
async handleSetPrice(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/setprice &lt;cheap|vip&gt; &lt;amount&gt;</code>');
        }

        const type = args[1].toLowerCase();
        const amount = parseFloat(args[2]);

        if (isNaN(amount) || amount < 0) {
            return this.replyError(ctx, '❌ <b>Invalid amount.</b>\n\nAmount must be a non-negative number.');
        }

        if (!config.prices) config.prices = {};

        if (type === 'cheap') {
            config.prices.cheapOtp = amount;
        } else if (type === 'vip') {
            config.prices.vipOtp = amount;
        } else {
            return this.replyError(ctx, '❌ <b>Invalid type.</b>\n\nUse: <code>cheap</code> or <code>vip</code>');
        }

        // Persist to DB
        await this._saveSettings();

        await this.replySuccess(ctx, `✅ <b>Price Updated!</b>\n\n${type === 'cheap' ? 'Cheap' : 'VIP'} OTP price set to <code>${formatCurrency(amount)}</code>\n\n<i>Saved to database.</i>`);

        await this.logAdminAction(
            ctx.from.id.toString(),
            'SET_PRICE',
            null,
            { type, amount }
        );
    },

    async handleSetVip(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/setvip &lt;price|days&gt; &lt;value&gt;</code>');
        }

        const type = args[1].toLowerCase();
        const value = parseFloat(args[2]);

        if (isNaN(value) || value < 0) {
            return this.replyError(ctx, '❌ <b>Invalid value.</b>\n\nValue must be a non-negative number.');
        }

        if (!config.prices) config.prices = {};

        if (type === 'price') {
            config.prices.vipSubscription = value;
        } else if (type === 'days') {
            config.prices.vipDuration = Math.floor(value);
        } else {
            return this.replyError(ctx, '❌ <b>Invalid type.</b>\n\nUse: <code>price</code> or <code>days</code>');
        }

        // Persist to DB
        await this._saveSettings();

        const displayValue = type === 'price' ? formatCurrency(value) : `${Math.floor(value)} days`;
        await this.replySuccess(ctx, `✅ <b>VIP Config Updated!</b>\n\nVIP ${type === 'price' ? 'price' : 'duration'} set to <code>${displayValue}</code>\n\n<i>Saved to database.</i>`);

        await this.logAdminAction(
            ctx.from.id.toString(),
            'SET_VIP',
            null,
            { type, value }
        );
    },

    async handleSetFree(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 3) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/setfree &lt;daily|pernumber&gt; &lt;number&gt;</code>');
        }

        const type = args[1].toLowerCase();
        const value = parseInt(args[2]);

        if (isNaN(value) || value < 0) {
            return this.replyError(ctx, '❌ <b>Invalid value.</b>\n\nValue must be a non-negative integer.');
        }

        if (!config.limits) config.limits = {};

        if (type === 'daily') {
            config.limits.freeDaily = value;
        } else if (type === 'pernumber') {
            config.limits.freePerNumber = value;
        } else {
            return this.replyError(ctx, '❌ <b>Invalid type.</b>\n\nUse: <code>daily</code> or <code>pernumber</code>');
        }

        // Persist to DB
        await this._saveSettings();

        const label = type === 'daily' ? 'daily limit' : 'per-number limit';
        await this.replySuccess(ctx, `✅ <b>Free Limits Updated!</b>\n\nFree ${label} set to <code>${value}</code>\n\n<i>Saved to database.</i>`);

        await this.logAdminAction(
            ctx.from.id.toString(),
            'SET_FREE',
            null,
            { type, value }
        );
    },

    async handleToggleProvider(ctx) {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return this.replyError(ctx, '❌ <b>Usage:</b> <code>/toggleprovider &lt;twilio|telnyx|cheappanel|freepublic&gt;</code>');
        }

        const name = args[1].toLowerCase();
        const valid = ['twilio', 'telnyx', 'cheappanel', 'freepublic'];

        if (!valid.includes(name)) {
            return this.replyError(ctx, '❌ <b>Invalid provider name.</b>\n\nValid: <code>twilio, telnyx, cheappanel, freepublic</code>');
        }

        if (!config.providers) config.providers = {};

        const current = config.providers[name] !== false;
        config.providers[name] = !current;

        // Persist to DB
        await this._saveSettings();

        const status = !current ? '✅ Enabled' : '❌ Disabled';
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);

        await this.replySuccess(ctx, `✅ <b>Provider Updated!</b>\n\n${displayName}: <b>${status}</b>\n\n<i>Saved to database.</i>`);

        await this.logAdminAction(
            ctx.from.id.toString(),
            'TOGGLE_PROVIDER',
            null,
            { provider: name, enabled: !current }
        );
    },

    // ═══════════════════════════════════════════════════════════
    //  DATA EXPORT COMMANDS
    // ═══════════════════════════════════════════════════════════

    
async handleExportUsers(ctx) {
        try {
            const users = await User.find().lean();

            if (!users.length) {
                return this.replyError(ctx, '<b>📥 No users to export.</b>');
            }

            const headers = [
                'userId', 'username', 'firstName', 'lastName', 'balance',
                'lockedBalance', 'bundleRemaining', 'mode', 'vipExpiry',
                'isBlacklisted', 'referralCode', 'referredBy', 'referralCount',
                'createdAt', 'lastActive'
            ];

            const rows = users.map(u => headers.map(h => this.escapeCSV(u[h])).join(','));
            const csv = [headers.join(','), ...rows].join('\n');

            // Send as document if too long, otherwise as text
            if (csv.length > 4000) {
                const buffer = Buffer.from(csv, 'utf-8');
                await ctx.replyWithDocument(
                    { source: buffer, filename: `users_export_${Date.now()}.csv` },
                    { caption: '<b>📥 Users Export</b>', parse_mode: 'HTML' }
                );
            } else {
                await this.replySuccess(ctx, `<b>📥 Users Export</b>\n\n<pre>${csv.substring(0, 4000)}</pre>`);
            }

            await this.logAdminAction(ctx.from.id.toString(), 'EXPORT_USERS', null, { count: users.length });

        } catch (error) {
            logger.error('Export users error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to export users.</b>');
        }
    },

    async handleExportTransactions(ctx) {
        try {
            const args = ctx.message.text.split(' ');
            const startDate = args[1] ? new Date(args[1]) : new Date(0);
            const endDate = args[2] ? new Date(args[2]) : new Date();

            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                return this.replyError(ctx, '❌ <b>Invalid date format.</b>\n\nUsage: <code>/export_transactions [YYYY-MM-DD] [YYYY-MM-DD]</code>');
            }

            const transactions = await Transaction.find({
                createdAt: { $gte: startDate, $lte: endDate }
            }).lean();

            if (!transactions.length) {
                return this.replyError(ctx, '<b>📥 No transactions found for the given period.</b>');
            }

            const headers = ['txId', 'userId', 'type', 'amount', 'status', 'metadata', 'createdAt'];
            const rows = transactions.map(t => headers.map(h => {
                if (h === 'metadata') return this.escapeCSV(JSON.stringify(t[h] || {}));
                return this.escapeCSV(t[h]);
            }).join(','));

            const csv = [headers.join(','), ...rows].join('\n');

            if (csv.length > 4000) {
                const buffer = Buffer.from(csv, 'utf-8');
                await ctx.replyWithDocument(
                    { source: buffer, filename: `transactions_export_${Date.now()}.csv` },
                    { caption: '<b>📥 Transactions Export</b>', parse_mode: 'HTML' }
                );
            } else {
                await this.replySuccess(ctx, `<b>📥 Transactions Export</b>\n\n<pre>${csv.substring(0, 4000)}</pre>`);
            }

            await this.logAdminAction(ctx.from.id.toString(), 'EXPORT_TRANSACTIONS', null, { count: transactions.length, startDate, endDate });

        } catch (error) {
            logger.error('Export transactions error', { error: error.message, stack: error.stack });
            await this.replyError(ctx, '❌ <b>Failed to export transactions.</b>');
        }
    },

    // ─── CSV Escaping Helper ───
    
escapeCSV(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    },

    // ═══════════════════════════════════════════════════════════
    //  BULK ACTIONS (NEW FEATURE)
    // ═══════════════════════════════════════════════════════════

    

    
async handleBulkBroadcastMenu(ctx) {
        this._setAdminState(ctx, ADMIN_STATE.AWAITING_BROADCAST_MESSAGE, { mode: 'bulk' });
        await this.replySuccess(ctx, `
<b>📢 Bulk Broadcast</b>

Send the message to broadcast to ALL users:

<i>This will send to every non-blacklisted user. Use with caution.</i>
        `);
    },

    async handleBulkAddBalanceMenu(ctx) {
        await this.replySuccess(ctx, `
<b>💰 Bulk Add Balance</b>

Use the command:
Open a user (Users → Search) and tap <b>Add Balance</b>

For multiple users, use the button flow for each user individually.
        `, {
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('👥 Go to Users', 'admin_users')],
                [Markup.button.callback('🔙 Back', 'admin_bulkactions')]
            ]).reply_markup
        });
    },

    async handleBulkGiveVipMenu(ctx) {
        await this.replySuccess(ctx, `
<b>👑 Bulk Give VIP</b>

Open a user via <b>Search User</b>, then use the quick VIP button.

Or grant VIP via:
<code>/givevip &lt;user_id&gt; &lt;days&gt;</code>
        `, {
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('👥 Go to Users', 'admin_users')],
                [Markup.button.callback('🔙 Back', 'admin_bulkactions')]
            ]).reply_markup
        });
    },

    async handleBulkResetFreeMenu(ctx) {
        await this.replySuccess(ctx, `
<b>🔄 Bulk Reset Free</b>

Open a user via <b>Search User</b>, then use the quick reset button.

Or reset via:
<code>/resetfree &lt;user_id&gt;</code>
        `, {
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('👥 Go to Users', 'admin_users')],
                [Markup.button.callback('🔙 Back', 'admin_bulkactions')]
            ]).reply_markup
        });
    }
};

export default settingsMethods;
