// bot/commands/admin/pool.js — Pool management, orphan SMS review, RPC control and number inventory
// Methods are mixed into AdminCommands.prototype by bot/commands/admin.js (bodies unchanged: `this` is the AdminCommands instance).
import { Markup } from 'telegraf';
import { User, Session, Transaction, Number as NumberModel } from '../../../models/index.js';
import { generateId, formatCurrency } from '../../../utils/helpers.js';
import logger from '../../../utils/logger.js';
import { TX_TYPES, NUMBER_STATUS } from './constants.js';

export const poolMethods = {
    
                    
    // ═══════════════════════════════════════════════════════════
    //  POOL MANAGEMENT
    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════
//  ORPHAN SMS REVIEW — Admin Panel Integration
// ═══════════════════════════════════════════════════════════════════════

/**
 * Handle orphan SMS review button click
 */
async handleOrphanReview(ctx) {
    try {
        if (!this._checkCooldown(ctx.from.id, 'orphan_review', 2000)) {
            return ctx.answerCbQuery?.('Please wait...').catch(() => {});
        }

        const { OrphanSMS } = await import('../../../models/index.js');

        // Get counts
        const [unreviewedCount, totalCount, recentOrphans] = await Promise.all([
            OrphanSMS.countDocuments({ reviewed: false }),
            OrphanSMS.countDocuments(),
            OrphanSMS.find({ reviewed: false })
                .sort({ receivedAt: -1 })
                .limit(10)
                .lean()
        ]);

        if (recentOrphans.length === 0) {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'admin_orphan_review')],
                [Markup.button.callback('⬅️ Back to Admin', 'admin_dashboard')]
            ]);

            return this.replySuccess(ctx, 
                '✅ <b>No Unreviewed Orphan SMS</b>\n\n' +
                `Total orphans in database: <code>${totalCount}</code>\n` +
                'All caught SMS have been matched to sessions.',
                { reply_markup: keyboard.reply_markup }
            );
        }

        // Build message
        const lines = recentOrphans.map((orphan, i) => {
            const timeAgo = this._formatTimeAgo(orphan.receivedAt);
            const bodyPreview = orphan.body 
                ? orphan.body.slice(0, 40).replace(/</g, '&lt;') + (orphan.body.length > 40 ? '...' : '')
                : 'N/A';
            
            return [
                `${i + 1}. <code>${this._maskPhone(orphan.to)}</code> | ${orphan.provider}`,
                `   🕐 ${timeAgo} | 📱 ${this._maskPhone(orphan.from || 'unknown')}`,
                `   💬 ${bodyPreview}`,
                `   🔢 OTP: <code>${orphan.extractedOtp || 'None'}</code>`,
                `   [${orphan.reviewed ? '✅' : '⏳'}]`
            ].join('\n');
        });

        const message = 
            `📨 <b>Orphan SMS Review</b>\n\n` +
            `⏳ Unreviewed: <code>${unreviewedCount}</code>\n` +
            `📊 Total: <code>${totalCount}</code>\n\n` +
            `<b>Recent Unreviewed (${recentOrphans.length}):</b>\n\n` +
            lines.join('\n\n');

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Mark All Reviewed', 'admin_orphan_markall'),
                Markup.button.callback('🔄 Refresh', 'admin_orphan_review')
            ],
            [
                Markup.button.callback('📋 Export CSV', 'admin_orphan_export'),
                Markup.button.callback('🔍 Search Number', 'admin_orphan_search')
            ],
            [
                Markup.button.callback('⬅️ Back to Admin', 'admin_dashboard')
            ]
        ]);

        await this._safeEditMessage(ctx, message, keyboard);

    } catch (error) {
        logger.error('Orphan review error', { error: error.message, userId: ctx.from?.id });
        await this.replyError(ctx, '❌ Failed to load orphan SMS review.');
    }
},

/**
 * Mark all orphan SMS as reviewed
 */
async handleOrphanMarkAll(ctx) {
    try {
        const { OrphanSMS } = await import('../../../models/index.js');

        const result = await OrphanSMS.updateMany(
            { reviewed: false },
            { 
                $set: { 
                    reviewed: true, 
                    reviewedAt: new Date(),
                    reviewedBy: ctx.from.id.toString()
                } 
            }
        );

        await ctx.answerCbQuery?.(`Marked ${result.modifiedCount} as reviewed`).catch(() => {});

        // Refresh the view
        return this.handleOrphanReview(ctx);

    } catch (error) {
        logger.error('Orphan mark all error', { error: error.message });
        await this.replyError(ctx, '❌ Failed to mark orphans as reviewed.');
    }
},

/**
 * Export orphan SMS to CSV
 */
async handleOrphanExport(ctx) {
    try {
        const { OrphanSMS } = await import('../../../models/index.js');

        const orphans = await OrphanSMS.find()
            .sort({ receivedAt: -1 })
            .limit(1000)
            .lean();

        if (orphans.length === 0) {
            return this.replyError(ctx, 'No orphan SMS to export.');
        }

        // Build CSV
        const headers = ['Received At', 'Provider', 'To', 'From', 'Body', 'Extracted OTP', 'Reviewed', 'Reviewed At'];
        const rows = orphans.map(o => [
            o.receivedAt?.toISOString() || '',
            o.provider,
            o.to,
            o.from || '',
            `"${(o.body || '').replace(/"/g, '""')}"`,
            o.extractedOtp || '',
            o.reviewed ? 'Yes' : 'No',
            o.reviewedAt?.toISOString() || ''
        ]);

        const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

        // Send as document
        await ctx.replyWithDocument({
            source: Buffer.from(csv),
            filename: `orphan_sms_${new Date().toISOString().split('T')[0]}.csv`
        }, {
            caption: `📊 Orphan SMS Export\nTotal: ${orphans.length} records`
        });

    } catch (error) {
        logger.error('Orphan export error', { error: error.message });
        await this.replyError(ctx, '❌ Failed to export orphan SMS.');
    }
},

/**
 * Search orphan SMS by phone number
 */
async handleOrphanSearch(ctx) {
    // Set admin state to wait for phone number input
    ctx.session = ctx.session || {};
    ctx.session.adminState = {
        state: 'ORPHAN_SEARCH',
        timestamp: Date.now()
    };

    await this.replySuccess(ctx, 
        '🔍 <b>Search Orphan SMS</b>\n\n' +
        'Please send the phone number to search for (with or without +):',
        { reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel', 'admin_orphan_review')]
        ]).reply_markup }
    );
},

/**
 * Process orphan search text input
 */
async processOrphanSearch(ctx, phoneNumber) {
    try {
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        
        const { OrphanSMS } = await import('../../../models/index.js');

        const matches = await OrphanSMS.find({
            $or: [
                { to: { $regex: cleanPhone } },
                { from: { $regex: cleanPhone } }
            ]
        }).sort({ receivedAt: -1 }).limit(20).lean();

        if (matches.length === 0) {
            return this.replyError(ctx, `No orphan SMS found for <code>${phoneNumber}</code>.`);
        }

        const lines = matches.map((o, i) => 
            `${i + 1}. <code>${this._maskPhone(o.to)}</code> → <code>${this._maskPhone(o.from)}</code>\n` +
            `   🕐 ${this._formatTimeAgo(o.receivedAt)}\n` +
            `   💬 ${o.body?.slice(0, 50) || 'N/A'}\n` +
            `   🔢 <code>${o.extractedOtp || 'None'}</code>`
        );

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔍 New Search', 'admin_orphan_search')],
            [Markup.button.callback('⬅️ Back to Review', 'admin_orphan_review')]
        ]);

        await this.replySuccess(ctx,
            `🔍 <b>Search Results for ${phoneNumber}</b>\n\n` +
            `Found: <code>${matches.length}</code>\n\n` +
            lines.join('\n\n'),
            { reply_markup: keyboard.reply_markup }
        );

    } catch (error) {
        logger.error('Orphan search error', { error: error.message, phone: phoneNumber });
        await this.replyError(ctx, '❌ Search failed.');
    }
},

                                     
        // ═══════════════════════════════════════════════════════════════════════
    //  ADMIN POOL PURCHASE — FULL REWRITE
    //  Flow: Provider → Available Countries+Prices → Pick Country → 
    //        Quantity → Balance Check → Confirm → Purchase
    // ═══════════════════════════════════════════════════════════════════════
   /**
/**
 * Show RPC Mode Control Panel
 * Handles both text messages and photo messages (with captions)
 */
async showRpcControlPanel(ctx) {
    if (!this.walletService) {
        return await this.replyError(ctx, '❌ Wallet service not initialized.');
    }

    const ws = this.walletService;
    const now = Date.now();
    
    const isIdle = ws.scanMode === 'IDLE';
    const isActive = ws.scanMode === 'ACTIVE';
    const expiresIn = ws.activeModeExpiry > now 
        ? `${Math.ceil((ws.activeModeExpiry - now) / 1000)}s` 
        : 'Expired';

    const message = 
        '⛓️ <b>RPC Mode Control</b>\n\n' +
        `Current Mode: <code>${ws.scanMode || 'UNKNOWN'}</code>\n` +
        `Provider: <code>${ws.currentProviderType || 'none'}</code>\n` +
        `Wallet Ready: ${ws.isReady ? '✅' : '❌'}\n\n` +
        (isActive 
            ? `⏳ Active mode expires in: <code>${expiresIn}</code>\n\n`
            : '<i>System is in low-power idle mode.</i>\n\n'
        ) +
        '<b>Actions:</b>';

    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🟢 Force IDLE', 'rpc_force_idle'),
            Markup.button.callback('🔵 Force ACTIVE', 'rpc_force_active')
        ],
        [
            Markup.button.callback('📊 Status', 'rpc_status')
        ],
        [
            Markup.button.callback('🏠 Admin Dashboard', 'admin_dashboard')
        ]
    ]);

    try {
        // Try to edit existing message text first
        if (ctx.callbackQuery?.message?.text) {
            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        } 
        // If it's a photo with caption, edit the caption
        else if (ctx.callbackQuery?.message?.caption) {
            await ctx.editMessageCaption(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        } 
        // Fallback: send new message
        else {
            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
        }
    } catch (err) {
        // If edit fails for any reason, send a new message
        logger.warn('Failed to edit message, sending new one', { error: err.message });
        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        });
    }
},

    
    
    // ═══════════════════════════════════════════════════════════════════════
    //  POOL MANAGEMENT — COMPLETE REWRITE
    //  Flow: Menu → Buy → Provider → Countries+Prices → Country → 
    //        Quantity → Balance Check → Confirm → Execute
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Show pool management menu
     */
    
async handlePoolMenu(ctx) {
        try {
            const stats = this.smsProviderManager?.getPoolStats?.() || { available: false, pools: {} };
            
            let poolSummary = '';
            if (stats.pools) {
                for (const [country, data] of Object.entries(stats.pools)) {
                    poolSummary += `• ${country}: <code>${data.available || 0}</code> avail / <code>${data.active || 0}</code> act\n`;
                }
            }

            const message = `
<b>📦 Number Pool Management</b>

<b>Quick Stats:</b>
${poolSummary || '<i>No pool data</i>'}

Manage your Twilio/Telnyx number pool:
            `;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🛒 Buy Numbers', 'pool_buy_numbers')],
                [Markup.button.callback('📊 Pool Monitor', 'pool_monitor')],
                [Markup.button.callback('👥 VIP Users', 'pool_vip_users')],
                [Markup.button.callback('🗑 Retire Numbers', 'pool_retire')],
                [Markup.button.callback('🔙 Back', 'admin')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Pool menu error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load pool menu.</b>');
        }
    },

    /**
     * Step 1: Show provider selection with balance info
     */
    
async handlePoolBuyMenu(ctx) {
        if (!this.smsProviderManager) {
            return this.replyError(ctx, '❌ <b>Pool not available.</b>\n\nSMS Provider Manager not configured.');
        }

        // Check provider balances
        let balanceInfo = '';
        try {
            const balances = await this.smsProviderManager.checkBalances();
            
            if (balances['TWILIO']?.success) {
                const bal = balances['TWILIO'].balance;
                balanceInfo += `🏢 Twilio: <code>${bal > 900 ? 'Post-paid' : '$' + bal.toFixed(2)}</code>\n`;
            }
            if (balances['TELNYX']?.success) {
                const bal = balances['TELNYX'].balance;
                balanceInfo += `🏢 Telnyx: <code>${bal > 900 ? 'Post-paid' : '$' + bal.toFixed(2)}</code>\n`;
            }
            if (balances['CHEAP_PANEL']?.success) {
                balanceInfo += `💰 5SIM: <code>${balances['CHEAP_PANEL'].balance.toFixed(2)} ${balances['CHEAP_PANEL'].currency}</code>\n`;
            }
        } catch (e) {
            balanceInfo = '<i>Balance check unavailable</i>';
        }

        const message = `
<b>🛒 Buy Numbers for Pool</b>

<b>Provider Balances:</b>
${balanceInfo || '<i>Unknown</i>'}

Select provider to see available countries and prices:
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🏢 Twilio', 'pool_provider_twilio')],
            [Markup.button.callback('🏢 Telnyx', 'pool_provider_telnyx')],
            [Markup.button.callback('🎲 Any Available', 'pool_provider_any')],
            [Markup.button.callback('🔙 Back', 'admin_pool')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    /**
     * Step 2: Provider selected — fetch available countries + prices
     */
    
async handlePoolProviderSelect(ctx, provider) {
        ctx.session = ctx.session || {};
        ctx.session.poolPurchase = { preferredProvider: provider };
        this._setAdminState(ctx, 'AWAITING_POOL_COUNTRY', { provider });

        const providerUpper = provider?.toUpperCase() || 'ANY';
        let availabilityInfo = '';
        let countryButtons = [];
        let availableCountries = [];

        try {
            if (this.smsProviderManager) {
                const targetProvider = providerUpper === 'ANY' 
                    ? null 
                    : this.smsProviderManager.getProvider(providerUpper);

                if (targetProvider && typeof targetProvider.hasAvailableNumbers === 'function') {
                    const checkCountries = [
                        { code: 'US', flag: '🇺🇸', name: 'United States' },
                        { code: 'CA', flag: '🇨🇦', name: 'Canada' },
                        { code: 'GB', flag: '🇬🇧', name: 'United Kingdom' },
                        { code: 'AU', flag: '🇦🇺', name: 'Australia' },
                        { code: 'DE', flag: '🇩🇪', name: 'Germany' },
                        { code: 'FR', flag: '🇫🇷', name: 'France' },
                        { code: 'ES', flag: '🇪🇸', name: 'Spain' },
                        { code: 'IT', flag: '🇮🇹', name: 'Italy' },
                        { code: 'NL', flag: '🇳🇱', name: 'Netherlands' },
                        { code: 'SE', flag: '🇸🇪', name: 'Sweden' },
                        { code: 'IE', flag: '🇮🇪', name: 'Ireland' },
                        { code: 'PL', flag: '🇵🇱', name: 'Poland' },
                        { code: 'BE', flag: '🇧🇪', name: 'Belgium' },
                        { code: 'AT', flag: '🇦🇹', name: 'Austria' },
                        { code: 'PT', flag: '🇵🇹', name: 'Portugal' },
                        { code: 'DK', flag: '🇩🇰', name: 'Denmark' },
                        { code: 'FI', flag: '🇫🇮', name: 'Finland' },
                        { code: 'NO', flag: '🇳🇴', name: 'Norway' },
                        { code: 'CH', flag: '🇨🇭', name: 'Switzerland' },
                        { code: 'NZ', flag: '🇳🇿', name: 'New Zealand' },
                        { code: 'JP', flag: '🇯🇵', name: 'Japan' },
                        { code: 'SG', flag: '🇸🇬', name: 'Singapore' },
                        { code: 'HK', flag: '🇭🇰', name: 'Hong Kong' },
                        { code: 'BR', flag: '🇧🇷', name: 'Brazil' },
                        { code: 'MX', flag: '🇲🇽', name: 'Mexico' },
                        { code: 'ZA', flag: '🇿🇦', name: 'South Africa' },
                        { code: 'IN', flag: '🇮🇳', name: 'India' },
                        { code: 'AE', flag: '🇦🇪', name: 'UAE' },
                        { code: 'IL', flag: '🇮🇱', name: 'Israel' },
                        { code: 'TR', flag: '🇹🇷', name: 'Turkey' }
                    ];

                    for (const country of checkCountries) {
                        try {
                            const hasStock = await targetProvider.hasAvailableNumbers(country.code);
                            if (hasStock) {
                                const cost = targetProvider.estimateMonthlyCost?.(country.code) || 1.00;
                                availableCountries.push({ ...country, cost });
                            }
                        } catch (e) {
                            // Skip unavailable
                        }
                    }
                } else if (providerUpper === 'ANY') {
                    // Check both providers
                    const twilio = this.smsProviderManager.getProvider('TWILIO');
                    const telnyx = this.smsProviderManager.getProvider('TELNYX');
                    
                    const checkCountries = ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE'];
                    
                    for (const code of checkCountries) {
                        let hasStock = false;
                        let cost = 1.00;
                        let providerName = '';
                        
                        try {
                            if (twilio?.isActive && await twilio.hasAvailableNumbers(code)) {
                                hasStock = true;
                                cost = twilio.estimateMonthlyCost?.(code) || 1.00;
                                providerName = 'Twilio';
                            }
                        } catch (e) {}
                        
                        if (!hasStock && telnyx?.isActive) {
                            try {
                                if (await telnyx.hasAvailableNumbers(code)) {
                                    hasStock = true;
                                    cost = telnyx.estimateMonthlyCost?.(code) || 1.50;
                                    providerName = 'Telnyx';
                                }
                            } catch (e) {}
                        }
                        
                        if (hasStock) {
                            const flagMap = {
                                'US': '🇺🇸', 'CA': '🇨🇦', 'GB': '🇬🇧', 'AU': '🇦🇺',
                                'DE': '🇩🇪', 'FR': '🇫🇷', 'ES': '🇪🇸', 'IT': '🇮🇹',
                                'NL': '🇳🇱', 'SE': '🇸🇪'
                            };
                            availableCountries.push({
                                code,
                                flag: flagMap[code] || '🏳️',
                                name: code,
                                cost,
                                provider: providerName
                            });
                        }
                    }
                }
            }
        } catch (e) {
            logger.error('Pool availability check failed', { provider, error: e.message });
        }

        // Build display and buttons
        if (availableCountries.length > 0) {
            const rows = [];
            for (let i = 0; i < availableCountries.length; i += 2) {
                const row = [];
                row.push(Markup.button.callback(
                    `${availableCountries[i].flag} ${availableCountries[i].code} (~$${availableCountries[i].cost.toFixed(2)})`,
                    `adminpool_co_${availableCountries[i].code}`
                ));
                if (availableCountries[i + 1]) {
                    row.push(Markup.button.callback(
                        `${availableCountries[i + 1].flag} ${availableCountries[i + 1].code} (~$${availableCountries[i + 1].cost.toFixed(2)})`,
                        `adminpool_co_${availableCountries[i + 1].code}`
                    ));
                }
                rows.push(row);
            }
            countryButtons = rows;

            availabilityInfo = availableCountries.map(c => 
                `${c.flag} <b>${c.code}</b>: ~$${c.cost.toFixed(2)}/mo${c.provider ? ` (${c.provider})` : ''}`
            ).join('\n');
        } else {
            availabilityInfo = '<i>No countries available from this provider right now.</i>\n\nYou can still try sending any 2-letter country code.';
        }

        countryButtons.push([Markup.button.callback('✏️ Type Custom Code', 'adminpool_co_custom')]);
        countryButtons.push([Markup.button.callback('🔙 Back', 'pool_buy_numbers')]);

        const message = `
<b>🛒 Buy Numbers — ${providerUpper}</b>

<b>Available Countries with Prices:</b>
${availabilityInfo}

<i>Tap a country or type a custom 2-letter code</i>
        `;

        await this.replySuccess(ctx, message, {
            reply_markup: Markup.inlineKeyboard(countryButtons).reply_markup,
            parse_mode: 'HTML'
        });
    },

    /**
     * Step 3: Country selected from button
     */
    
async handlePoolCountryButton(ctx, countryCode) {
        return this.handlePoolCountrySelect(ctx, countryCode);
    },

    /**
     * Step 3: Country selected — ask for quantity
     */
    
async handlePoolCountrySelect(ctx, country) {
        ctx.session.poolPurchase = { ...ctx.session.poolPurchase, country };
        this._setAdminState(ctx, 'AWAITING_POOL_QTY', { country });

        let priceEstimate = '';
        try {
            const provider = ctx.session.poolPurchase.preferredProvider;
            const providerInstance = provider && provider !== 'any'
                ? this.smsProviderManager?.getProvider(provider.toUpperCase())
                : null;
            
            if (providerInstance?.estimateMonthlyCost) {
                const cost = providerInstance.estimateMonthlyCost(country);
                priceEstimate = `\n💰 Est. cost: <code>~$${cost.toFixed(2)}</code> per number/month`;
            }
        } catch (e) {}

        const message = `
<b>🛒 Buy Numbers — ${ctx.session.poolPurchase.preferredProvider?.toUpperCase() || 'ANY'}</b>

🌍 Country: <code>${country}</code>${priceEstimate}

How many numbers do you want?
        `;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('1️⃣  1', 'pool_qty_1'),
                Markup.button.callback('5️⃣  5', 'pool_qty_5'),
                Markup.button.callback('🔟  10', 'pool_qty_10')
            ],
            [
                Markup.button.callback('2️⃣0️⃣  20', 'pool_qty_20'),
                Markup.button.callback('5️⃣0️⃣  50', 'pool_qty_50'),
                Markup.button.callback('1️⃣0️⃣0️⃣  100', 'pool_qty_100')
            ],
            [
                Markup.button.callback('✏️ Custom Amount', 'pool_qty_custom')
            ],
            [
                Markup.button.callback('🔙 Back', 'pool_buy_numbers'),
                Markup.button.callback('❌ Cancel', 'admin_pool')
            ]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    /**
     * Step 4: Quantity selected
     */
    
async handlePoolQuantitySelect(ctx, qty) {
        ctx.session.poolPurchase = { ...ctx.session.poolPurchase, quantity: parseInt(qty) || 1 };
        return this.showPoolPurchaseConfirm(ctx);
    },

    /**
     * Step 5: Show confirmation with balance check
     */
    
async showPoolPurchaseConfirm(ctx) {
        const purchase = ctx.session.poolPurchase;
        if (!purchase?.country || !purchase?.quantity) {
            return this.replyError(ctx, '❌ <b>Invalid purchase data.</b>\n\nPlease start over.');
        }

        let totalEstimate = 0;
        let providerBalance = null;
        
        try {
            const providerName = purchase.preferredProvider === 'any' 
                ? 'TWILIO' 
                : purchase.preferredProvider.toUpperCase();
            
            const providerInstance = this.smsProviderManager?.getProvider(providerName);
            if (providerInstance?.estimateMonthlyCost) {
                totalEstimate = providerInstance.estimateMonthlyCost(purchase.country) * purchase.quantity;
            } else {
                totalEstimate = purchase.quantity * 1.50;
            }

            const balanceCheck = await this.smsProviderManager?.hasSufficientBalance?.(providerName, totalEstimate);
            providerBalance = balanceCheck;
        } catch (e) {
            logger.warn('Balance check failed for confirmation', { error: e.message });
        }

        const balanceWarning = providerBalance && !providerBalance.sufficient
            ? `\n\n⚠️ <b>Warning:</b> ${providerBalance.reason}\nAvailable: $${providerBalance.available?.toFixed(2) || 0}\nRequired: ~$${totalEstimate.toFixed(2)}`
            : '';

        const message = `
<b>✅ Confirm Pool Purchase</b>

🏢 Provider: <code>${(purchase.preferredProvider || 'any').toUpperCase()}</code>
🌍 Country: <code>${purchase.country}</code>
📦 Quantity: <code>${purchase.quantity}</code>
💰 Est. Total: <code>~$${totalEstimate.toFixed(2)}</code>${balanceWarning}

Proceed with purchase?
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Purchase', 'confirm_pool_purchase')],
            [Markup.button.callback('🔙 Back', `pool_country_${purchase.country}`)],
            [Markup.button.callback('❌ Cancel', 'admin_pool')]
        ]);

        await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
    },

    /**
     * Step 6: Execute purchase with balance validation
     */
    
async executePoolPurchase(ctx) {
        const purchase = ctx.session?.poolPurchase;
        if (!purchase) {
            return this.replyError(ctx, '❌ <b>Session expired.</b>\n\nPlease start over.');
        }

        try {
            const providerName = purchase.preferredProvider === 'any' 
                ? null 
                : purchase.preferredProvider.toUpperCase();

            // Calculate estimated cost
            let estimatedCost = 0;
            try {
                const p = providerName ? this.smsProviderManager?.getProvider(providerName) : null;
                if (p?.estimateMonthlyCost) {
                    estimatedCost = p.estimateMonthlyCost(purchase.country) * purchase.quantity;
                } else {
                    estimatedCost = purchase.quantity * 1.50;
                }
            } catch (e) {
                estimatedCost = purchase.quantity * 1.50;
            }

            // Check provider balance before purchase
            if (providerName && this.smsProviderManager?.hasSufficientBalance) {
                const balanceCheck = await this.smsProviderManager.hasSufficientBalance(
                    providerName, 
                    estimatedCost
                );
                
                if (!balanceCheck.sufficient) {
                    ctx.session.poolPurchase = null;
                    return this.replyError(ctx, 
                        `❌ <b>Insufficient ${providerName} Balance</b>\n\n` +
                        `💰 Required: ~$${estimatedCost.toFixed(2)}\n` +
                        `💳 Available: $${balanceCheck.available?.toFixed(2) || 0}\n\n` +
                        `Please top up your ${providerName} account before purchasing.`, {
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('🔄 Try Again', 'pool_buy_numbers')],
                                [Markup.button.callback('🔙 Back', 'admin_pool')]
                            ]).reply_markup
                        });
                }
            }

            // Execute purchase
            const result = await this.smsProviderManager.buyPoolNumbers(
                purchase.country,
                purchase.quantity,
                purchase.preferredProvider
            );

            ctx.session.poolPurchase = null;

            if (result.purchased?.length > 0) {
                // Store purchased numbers
                for (const num of result.purchased) {
                    try {
                        await NumberModel.create({
                            numberId: generateId(),
                            phoneNumber: num.phoneNumber,
                            provider: num.provider,
                            country: purchase.country,
                            status: 'AVAILABLE',
                            purchasedAt: new Date(),
                            cost: num.cost || 0,
                            metadata: num
                        });
                    } catch (dbError) {
                        logger.warn('Failed to store number in DB', { 
                            phone: num.phoneNumber, 
                            error: dbError.message 
                        });
                    }
                }

                const numbersList = result.purchased.map(n => 
                    `• <code>${n.phoneNumber}</code> (${n.provider})`
                ).join('\n');

                const actualCost = result.totalCost || (result.purchased.length * 1.00);

                                const message = `
<b>✅ Pool Purchase Complete!</b>

🏢 Provider: <code>${purchase.preferredProvider?.toUpperCase() || 'ANY'}</code>
🌍 Country: <code>${purchase.country}</code>
📦 Purchased: <code>${result.purchased.length}</code> numbers
❌ Failed: <code>${result.failed || 0}</code>
💰 Total Cost: <code>$${actualCost.toFixed(2)}</code>

<b>Numbers:</b>
${numbersList}
                `;

                await this.replySuccess(ctx, message, {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🛒 Buy More', 'pool_buy_numbers')],
                        [Markup.button.callback('📊 Pool Monitor', 'pool_monitor')],
                        [Markup.button.callback('🔙 Back', 'admin_pool')]
                    ]).reply_markup
                });

                await this.logAdminAction(
                    ctx.from.id.toString(),
                    'POOL_PURCHASE',
                    null,
                    { 
                        country: purchase.country, 
                        quantity: purchase.quantity, 
                        purchased: result.purchased.length,
                        provider: purchase.preferredProvider,
                        cost: actualCost
                    }
                );
            } else {
                await this.replyError(ctx, 
                    `❌ <b>Purchase Failed</b>\n\nNo numbers were purchased.\nError: ${result.errors?.[0]?.error || 'Unknown error'}`, {
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔄 Retry', 'pool_buy_numbers')],
                            [Markup.button.callback('🔙 Back', 'admin_pool')]
                        ]).reply_markup
                    });
            }
        } catch (error) {
            ctx.session.poolPurchase = null;
            logger.error('Pool purchase failed', { error: error.message, purchase });
            await this.replyError(ctx, `❌ <b>Purchase Failed:</b> ${error.message}`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Retry', 'pool_buy_numbers')],
                    [Markup.button.callback('🔙 Back', 'admin_pool')]
                ]).reply_markup
            });
        }
    },

                
    async handlePoolMonitor(ctx) {
        try {
            if (!this.smsProviderManager?.numberPool) {
                return this.replyError(ctx, '❌ <b>Pool not available.</b>');
            }

            const stats = this.smsProviderManager.getPoolStats();
            const detailed = this.smsProviderManager.numberPool?.getDetailedStats?.();

            let message = `
<b>📊 Pool Monitor</b>

<b>Pool Status:</b> ${stats.available ? '✅ Active' : '❌ Inactive'}
            `;

            if (stats.pools) {
                message += '\n\n<b>By Country:</b>\n';
                for (const [country, data] of Object.entries(stats.pools)) {
                    message += `• ${country}: <code>${data.available}</code> available / <code>${data.active}</code> active / <code>${data.total}</code> total\n`;
                }
            }

            if (detailed) {
                message += `\n<b>Total Active Assignments:</b> <code>${detailed.totalActive || 0}</code>\n`;
                message += `<b>Max Hold Time:</b> <code>${detailed.maxHoldMinutes || 30}</code> min\n`;
                
                if (detailed.activeAssignments?.length > 0) {
                    message += '\n<b>Active Assignments (top 5):</b>\n';
                    detailed.activeAssignments.slice(0, 5).forEach(a => {
                        message += `• <code>${a.phone}</code> | ${a.country} | ${a.service} | ${a.heldMinutes}min\n`;
                    });
                }
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'pool_monitor')],
                [Markup.button.callback('🛒 Buy Numbers', 'pool_buy_numbers')],
                [Markup.button.callback('🔙 Back', 'admin_pool')]
            ]);

            await this.replySuccess(ctx, message, { reply_markup: keyboard.reply_markup });
        } catch (error) {
            logger.error('Pool monitor error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load pool stats.</b>');
        }
    },

    async handlePoolVipUsers(ctx) {
        try {
            const vipUsers = await User.find({
                vipExpiry: { $gt: new Date() },
                vipPhoneNumber: { $ne: null }
            }).select('userId username firstName vipPhoneNumber vipProvider vipExpiry vipNumberAssignedAt').lean();

            if (!vipUsers.length) {
                return this.replyError(ctx, '<b>👥 No VIP users with assigned numbers.</b>', {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', 'admin_pool')]
                    ]).reply_markup
                });
            }

            let message = `<b>👑 VIP Users with Numbers</b> (${vipUsers.length} total)\n\n`;
            const buttons = [];

            for (const user of vipUsers) {
                const daysLeft = Math.ceil((new Date(user.vipExpiry) - new Date()) / (1000 * 60 * 60 * 24));
                const displayName = user.username ? `@${user.username}` : (user.firstName || user.userId);
                
                message += `👑 <b>${displayName}</b>\n`;
                message += `   📞 <code>${user.vipPhoneNumber}</code> (${user.vipProvider})\n`;
                message += `   ⏰ ${daysLeft} days left | ID: <code>${user.userId}</code>\n\n`;

                buttons.push([Markup.button.callback(
                    `❌ Cancel VIP ${displayName.substring(0, 15)}`,
                    `quick_cancelvip_${user.userId}`
                )]);
            }

            buttons.push([Markup.button.callback('🔙 Back', 'admin_pool')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Pool VIP users error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load VIP users.</b>');
        }
    },

    async handlePoolRetireMenu(ctx) {
        await this.replySuccess(ctx, 
            '<b>🗑 Retire Numbers</b>\n\nSelect a number from inventory below',
            { reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('📱 View Inventory', 'number_inventory_all')],
                [Markup.button.callback('📊 Go to Monitor', 'pool_monitor')],
                [Markup.button.callback('🔙 Back', 'admin_pool')]
            ]).reply_markup }
        );
    },

    // ═══════════════════════════════════════════════════════════
    //  NUMBER INVENTORY (NEW FEATURE)
    // ═══════════════════════════════════════════════════════════

    

    
async handleNumberInventoryList(ctx, filter) {
        try {
            const query = {};
            if (filter !== 'all') query.status = filter.toUpperCase();

            const numbers = await NumberModel.find(query)
                .sort({ updatedAt: -1 })
                .limit(20)
                .lean();

            if (!numbers.length) {
                return this.replyError(ctx, `<b>📱 No ${filter} numbers found.</b>`, {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('🔙 Back', 'admin_numberinventory')]
                    ]).reply_markup
                });
            }

            let message = `<b>📱 ${filter.charAt(0).toUpperCase() + filter.slice(1)} Numbers</b> (${numbers.length} shown)\n\n`;
            const buttons = [];

            for (const num of numbers) {
                const statusEmoji = num.status === NUMBER_STATUS.AVAILABLE ? '✅' :
                    num.status === NUMBER_STATUS.ASSIGNED ? '🔒' :
                    num.status === NUMBER_STATUS.RETIRED ? '🗑' : '⚪';

                message += `${statusEmoji} <code>${num.phoneNumber}</code>\n`;
                message += `   ${num.provider} | ${num.country} | ${num.status}\n`;
                if (num.assignedTo) message += `   👤 <code>${num.assignedTo}</code>\n`;
                message += '\n';

                buttons.push([Markup.button.callback(
                    `🔍 ${num.phoneNumber}`,
                    `number_detail_${num.numberId}`
                )]);
            }

            buttons.push([Markup.button.callback('🔙 Back', 'admin_numberinventory')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Number inventory error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load number inventory.</b>');
        }
    },

    async showNumberDetail(ctx, numberId) {
        try {
            const num = await NumberModel.findOne({ numberId }).lean();
            if (!num) {
                return this.replyError(ctx, '❌ <b>Number not found.</b>');
            }

            const message = `
<b>📱 Number Detail</b>

<b>Phone:</b> <code>${num.phoneNumber}</code>
<b>Provider:</b> <code>${num.provider}</code>
<b>Country:</b> <code>${num.country}</code>
<b>Status:</b> <code>${num.status}</code>
<b>Purchased:</b> <code>${num.purchasedAt ? new Date(num.purchasedAt).toLocaleDateString() : 'N/A'}</code>
<b>Cost:</b> <code>${formatCurrency(num.cost || 0)}</code>
${num.assignedTo ? `<b>Assigned To:</b> <code>${num.assignedTo}</code>\n` : ''}
${num.assignedAt ? `<b>Assigned At:</b> <code>${new Date(num.assignedAt).toLocaleDateString()}</code>\n` : ''}
${num.retiredAt ? `<b>Retired At:</b> <code>${new Date(num.retiredAt).toLocaleDateString()}</code>\n` : ''}
            `;

            const buttons = [];
            if (num.status !== NUMBER_STATUS.RETIRED) {
                buttons.push([Markup.button.callback('🗑 Retire Number', `number_retire_confirm_${num.numberId}`)]);
            }
            buttons.push([Markup.button.callback('🔙 Back', 'number_inventory_all')]);

            await this.replySuccess(ctx, message, { reply_markup: { inline_keyboard: buttons } });
        } catch (error) {
            logger.error('Number detail error', { error: error.message });
            await this.replyError(ctx, '❌ <b>Failed to load number detail.</b>');
        }
    },

    

    async executeRetireNumber(ctx, numberId) {
        try {
            const num = await NumberModel.findOne({ numberId });
            if (!num) {
                return this.replyError(ctx, `❌ <b>Number not found:</b> <code>${numberId}</code>`);
            }

            if (num.status === NUMBER_STATUS.RETIRED) {
                return this.replyError(ctx, `❌ <b>Number already retired:</b> <code>${numberId}</code>`);
            }

            // Release from provider if assigned
            if (num.status === NUMBER_STATUS.ASSIGNED && this.smsProviderManager?.numberPool) {
                try {
                    await this.smsProviderManager.numberPool.releaseNumber(numberId, 'ADMIN_RETIRED');
                } catch (e) {
                    logger.warn('Failed to release from provider pool', { numberId, error: e.message });
                }
            }

            // Update user if assigned
            if (num.assignedTo) {
                await User.updateOne(
                    { userId: num.assignedTo },
                    { $unset: { vipPhoneNumber: 1, vipNumberId: 1, vipProvider: 1 } }
                );
            }

            await NumberModel.updateOne(
                { numberId },
                {
                    $set: {
                        status: NUMBER_STATUS.RETIRED,
                        retiredAt: new Date(),
                        retiredBy: ctx.from.id.toString()
                    }
                }
            );

            await Transaction.create({
                txId: generateId(),
                type: TX_TYPES.NUMBER_RETIRE,
                amount: 0,
                status: 'COMPLETED',
                metadata: { numberId, phoneNumber: num.phoneNumber, adminId: ctx.from.id.toString() },
                createdAt: new Date()
            });

            await this.logAdminAction(
                ctx.from.id.toString(),
                'RETIRE_NUMBER',
                num.assignedTo,
                { numberId, phoneNumber: num.phoneNumber }
            );

            await this.replySuccess(ctx, `🗑 <b>Number Retired!</b>\n\n<code>${num.phoneNumber}</code> has been retired.`, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Inventory', 'admin_numberinventory')],
                    [Markup.button.callback('🔙 Back', 'admin')]
                ]).reply_markup
            });

        } catch (error) {
            logger.error('Retire number error', { error: error.message, numberId });
            await this.replyError(ctx, '❌ <b>Failed to retire number.</b>');
        }
    },

    async processRetireNumber(ctx, input) {
        // Input can be numberId or phone number
        const num = await NumberModel.findOne({
            $or: [{ numberId: input }, { phoneNumber: input }]
        }).lean();

        if (!num) {
            return this.replyError(ctx, `❌ <b>Number not found:</b> <code>${input}</code>`);
        }

        return this.executeRetireNumber(ctx, num.numberId);
                                                   }
};

export default poolMethods;
                                                   
