// ═══════════════════════════════════════════════════════════════════════════════
// bot/middleware/tierFlowMiddleware.js — Telegram Callback Router for Tier Flow
// FIXED: Added missing closing braces for _fallback methods and class
// ═══════════════════════════════════════════════════════════════════════════════

import { Markup } from 'telegraf';
import logger from '../../utils/logger.js';

class TierFlowMiddleware {
    constructor(tierIntegrationService, otpCommandsInstance) {
        this.tierService = tierIntegrationService;
        this.otpCommands = otpCommandsInstance;
        this.SESSION_PREFIX = 'tier_flow';
        logger.info('TierFlowMiddleware initialized');
    }

    register(bot) {
        if (!bot) {
            logger.error('TierFlowMiddleware: bot instance required');
            return;
        }

        bot.action(/^service_(.+)$/, this._handleServiceSelect.bind(this));
        bot.action('service_search_prompt', this._handleServiceSearchPrompt.bind(this));
        bot.action(/^service_cat_(.+)$/, this._handleServiceCategory.bind(this));
        bot.action(/^service_page_(\d+)$/, this._handleServicePage.bind(this));
        bot.action(/^tier_(budget|standard|premium)$/, this._handleTierSelect.bind(this));
        bot.action('tier_back_service', this._handleTierBackService.bind(this));
        bot.action('tier_back_tier', this._handleTierBackTier.bind(this));
        bot.action(/^tier_country_([A-Z]{2})$/, this._handleTierCountrySelect.bind(this));
        bot.action(/^tier_fallback_(.+)$/, this._handleTierFallback.bind(this));
        bot.action(/^country_page_(\d+)$/, this._handleCountryPage.bind(this));
        bot.action('country_search_prompt', this._handleCountrySearchPrompt.bind(this));
        bot.on('text', this._handleSearchInput.bind(this));

        logger.info('TierFlowMiddleware callbacks registered');
    }

    async _handleServiceSelect(ctx) {
        try {
            const service = ctx.match[1];
            if (!this.tierService.isValidService(service)) {
                return ctx.answerCbQuery('❌ Invalid service');
            }
            ctx.session = ctx.session || {};
            ctx.session.otpService = service;
            ctx.session.otpMode = 'CHEAP';
            ctx.session.tierFlowStep = 'tier_selection';
            await ctx.answerCbQuery(`✅ ${service} selected`);
            if (this.otpCommands?.showTierSelection) {
                return this.otpCommands.showTierSelection(ctx, service);
            }
            return this._fallbackServiceSelect(ctx, service);
        } catch (error) {
            logger.error('Service select failed', { error: error.message, service: ctx.match?.[1] });
            return ctx.answerCbQuery('❌ Error selecting service');
        }
    }

    async _handleServiceSearchPrompt(ctx) {
        try {
            ctx.session = ctx.session || {};
            ctx.session.tierFlowStep = 'searching_service';
            ctx.session.searchType = 'service';
            await ctx.answerCbQuery('🔍 Enter service name...');
            const message = 
                `🔍 <b>Search Service</b>\n\n` +
                `Type the service name (e.g., "WhatsApp", "Telegram"):\n\n` +
                `Minimum 2 characters.`;
            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Cancel', 'tier_back_service')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Service search prompt failed', { error: error.message });
        }
    }

    async _handleServiceCategory(ctx) {
        try {
            const category = ctx.match[1];
            const services = this.tierService.getServicesByCategory(category);
            if (!services || services.length === 0) {
                return ctx.answerCbQuery('❌ No services in this category');
            }
            let message = `📂 <b>${category}</b>\n\nSelect a service:`;
            const buttons = [];
            for (const s of services.slice(0, 20)) {
                buttons.push([Markup.button.callback(
                    `${s.isPopular ? '🔥 ' : ''}${s.name}`,
                    `service_${s.name}`
                )]);
            }
            buttons.push([Markup.button.callback('🔙 Back', 'tier_back_service')]);
            await ctx.editMessageCaption(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery(`📂 ${category}`);
        } catch (error) {
            logger.error('Service category failed', { error: error.message, category: ctx.match?.[1] });
        }
    }

    async _handleServicePage(ctx) {
        try {
            const page = parseInt(ctx.match[1], 10) || 1;
            const result = this.tierService.getServicesPage(page, 15);
            if (!result || result.services.length === 0) {
                return ctx.answerCbQuery('❌ No more services');
            }
            let message = `📋 <b>All Services</b> (Page ${page}/${result.pagination.totalPages})\n\n`;
            const buttons = [];
            for (const s of result.services) {
                buttons.push([Markup.button.callback(
                    `${s.isPopular ? '🔥 ' : ''}${s.name} — ${s.category}`,
                    `service_${s.name}`
                )]);
            }
            const navButtons = [];
            if (result.pagination.hasPrev) {
                navButtons.push(Markup.button.callback('◀️ Prev', `service_page_${page - 1}`));
            }
            if (result.pagination.hasNext) {
                navButtons.push(Markup.button.callback('Next ▶️', `service_page_${page + 1}`));
            }
            if (navButtons.length > 0) buttons.push(navButtons);
            buttons.push([Markup.button.callback('🔙 Back', 'tier_back_service')]);
            await ctx.editMessageCaption(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery(`Page ${page}`);
        } catch (error) {
            logger.error('Service page failed', { error: error.message, page: ctx.match?.[1] });
        }
    }

    async _handleTierSelect(ctx) {
        try {
            const tierKey = ctx.match[1];
            const service = ctx.session?.otpService;
            if (!service) {
                return ctx.answerCbQuery('❌ Session expired. Start over.', { show_alert: true });
            }
            const tierInfo = this.tierService.getTierInfo(tierKey);
            if (!tierInfo) {
                return ctx.answerCbQuery('❌ Invalid tier');
            }
            ctx.session = ctx.session || {};
            ctx.session.selectedTier = tierKey;
            ctx.session.tierFlowStep = 'country_selection';
            await ctx.answerCbQuery(`✅ ${tierInfo.label} selected`);
            if (this.otpCommands?.showTierCountrySelection) {
                return this.otpCommands.showTierCountrySelection(ctx, service, tierKey, 1);
            }
            return this._fallbackTierSelect(ctx, service, tierKey);
        } catch (error) {
            logger.error('Tier select failed', { error: error.message, tier: ctx.match?.[1] });
            return ctx.answerCbQuery('❌ Error selecting tier');
        }
    }

    async _handleTierBackService(ctx) {
        try {
            ctx.session = ctx.session || {};
            delete ctx.session.otpService;
            delete ctx.session.selectedTier;
            delete ctx.session.tierFlowStep;
            delete ctx.session.searchQuery;
            await ctx.answerCbQuery('🔙 Back to services');
            if (this.otpCommands?.showServiceSelection) {
                return this.otpCommands.showServiceSelection(ctx, 'CHEAP', this.otpCommands.IMAGES?.cheapMode);
            }
            await ctx.reply('🔙 Returning to main menu...', Markup.inlineKeyboard([
                [Markup.button.callback('📱 OTP Services', 'otp')]
            ]));
        } catch (error) {
            logger.error('Tier back service failed', { error: error.message });
        }
    }

    async _handleTierBackTier(ctx) {
        try {
            const service = ctx.session?.otpService;
            if (!service) {
                return ctx.answerCbQuery('❌ Session expired', { show_alert: true });
            }
            delete ctx.session.selectedTier;
            delete ctx.session.tierFlowStep;
            ctx.session.tierFlowStep = 'tier_selection';
            await ctx.answerCbQuery('🔙 Back to tiers');
            if (this.otpCommands?.showTierSelection) {
                return this.otpCommands.showTierSelection(ctx, service);
            }
        } catch (error) {
            logger.error('Tier back tier failed', { error: error.message });
        }
    }

    async _handleTierCountrySelect(ctx) {
        try {
            const countryCode = ctx.match[1];
            const service = ctx.session?.otpService;
            const tierKey = ctx.session?.selectedTier;
            if (!service || !tierKey) {
                return ctx.answerCbQuery('❌ Session expired. Start over.', { show_alert: true });
            }
            await ctx.answerCbQuery('⏳ Processing...');
            if (this.otpCommands?.handleTierCountrySelect) {
                return this.otpCommands.handleTierCountrySelect(ctx, countryCode);
            }
            return this._fallbackCountryPurchase(ctx, countryCode);
        } catch (error) {
            logger.error('Country select failed', { error: error.message, country: ctx.match?.[1] });
            return ctx.answerCbQuery('❌ Error processing selection');
        }
    }

    async _handleTierFallback(ctx) {
        try {
            const operator = ctx.match[1];
            const service = ctx.session?.otpService;
            const tierKey = ctx.session?.selectedTier;
            const countryCode = ctx.session?.selectedCountry;
            if (!service || !tierKey || !countryCode) {
                return ctx.answerCbQuery('❌ Session expired', { show_alert: true });
            }
            await ctx.answerCbQuery(`🔄 Trying ${operator}...`);
            const result = await this.tierService.purchaseNumber(tierKey, countryCode, service, {
                timeoutMs: 15000,
                allowFallback: false
            });
            if (!result.success) {
                return ctx.reply(
                    `❌ <b>Fallback Failed</b>\n\n${result.error}\n\nTry another country or tier.`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔙 Back to Countries', `tier_${tierKey}`)]
                        ]).reply_markup
                    }
                );
            }
            ctx.session.tierOperator = result.operator;
            ctx.session.tierKey = tierKey;
            ctx.session.selectedCountry = countryCode;
            if (this.otpCommands?._createTierSession) {
                return this.otpCommands._createTierSession(ctx, result);
            }
            return this._createSessionFromPurchase(ctx, result);
        } catch (error) {
            logger.error('Fallback handler failed', { error: error.message });
            return ctx.answerCbQuery('❌ Fallback error');
        }
    }

    async _handleCountryPage(ctx) {
        try {
            const page = parseInt(ctx.match[1], 10) || 1;
            const service = ctx.session?.otpService;
            const tierKey = ctx.session?.selectedTier;
            if (!service || !tierKey) {
                return ctx.answerCbQuery('❌ Session expired', { show_alert: true });
            }
            await ctx.answerCbQuery(`Page ${page}`);
            if (this.otpCommands?.showTierCountrySelection) {
                return this.otpCommands.showTierCountrySelection(ctx, service, tierKey, page);
            }
        } catch (error) {
            logger.error('Country page failed', { error: error.message, page: ctx.match?.[1] });
        }
    }

    async _handleCountrySearchPrompt(ctx) {
        try {
            ctx.session = ctx.session || {};
            ctx.session.tierFlowStep = 'searching_country';
            ctx.session.searchType = 'country';
            await ctx.answerCbQuery('🔍 Enter country name or code...');
            const message = 
                `🔍 <b>Search Country</b>\n\n` +
                `Type country name (e.g., "USA", "United Kingdom") or ISO code (e.g., "US", "UK"):\n\n` +
                `Minimum 2 characters.`;
            await ctx.reply(message, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Cancel', `tier_${ctx.session?.selectedTier || 'standard'}`)]
                ]).reply_markup
            });
        } catch (error) {
            logger.error('Country search prompt failed', { error: error.message });
        }
    }

    async _handleSearchInput(ctx, next) {
        try {
            if (!ctx.session?.tierFlowStep?.startsWith('searching_')) {
                return next();
            }
            const query = ctx.message?.text?.trim();
            if (!query || query.length < 2) {
                await ctx.reply('❌ Please enter at least 2 characters.');
                return;
            }
            const searchType = ctx.session.searchType;
            if (searchType === 'service') {
                if (this.otpCommands?.handleTierSearchService) {
                    return this.otpCommands.handleTierSearchService(ctx, query);
                }
                const results = this.tierService.searchServices(query, 10);
                if (!results || results.length === 0) {
                    return ctx.reply(
                        `❌ No services found for "${query}"`,
                        Markup.inlineKeyboard([
                            [Markup.button.callback('🔍 Search Again', 'service_search_prompt')],
                            [Markup.button.callback('🔙 Back', 'menu')]
                        ])
                    );
                }
                let message = `🔍 <b>Results for "${query}"</b>\n\n`;
                const buttons = results.map(r => [
                    Markup.button.callback(
                        `${r.isPopular ? '🔥 ' : ''}${r.name}`,
                        `service_${r.name}`
                    )
                ]);
                buttons.push([Markup.button.callback('🔍 New Search', 'service_search_prompt')]);
                buttons.push([Markup.button.callback('🔙 Back', 'menu')]);
                await ctx.reply(message, {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard(buttons).reply_markup
                });
            } else if (searchType === 'country') {
                const service = ctx.session?.otpService;
                const tierKey = ctx.session?.selectedTier;
                if (!service || !tierKey) {
                    await ctx.reply('❌ Session expired. Please start over with /otp');
                    return;
                }
                if (this.otpCommands?.handleTierSearchCountry) {
                    return this.otpCommands.handleTierSearchCountry(ctx, query);
                }
                if (this.otpCommands?.showTierCountrySelection) {
                    return this.otpCommands.showTierCountrySelection(ctx, service, tierKey, 1, query);
                }
            }
            delete ctx.session.tierFlowStep;
            delete ctx.session.searchType;
        } catch (error) {
            logger.error('Search input handler failed', { error: error.message });
            delete ctx.session.tierFlowStep;
            delete ctx.session.searchType;
            return next();
        }
    }

    async _fallbackServiceSelect(ctx, service) {
        const message = `📱 <b>${service}</b>\n\nSelect quality tier:`;
        const tiers = this.tierService.getAllTierInfos();
        const buttons = tiers.map(t => [
            Markup.button.callback(
                `${t.emoji} ${t.label}`,
                `tier_${t.key}`
            )
        ]);
        buttons.push([Markup.button.callback('🔙 Back', 'tier_back_service')]);
        await ctx.editMessageCaption(message, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard(buttons).reply_markup
        });
    }

    async _fallbackTierSelect(ctx, service, tierKey) {
        const tierInfo = this.tierService.getTierInfo(tierKey);
        const message = 
            `${tierInfo.emoji} <b>${tierInfo.label} Tier</b>\n\n` +
            `Service: ${service}\n\n` +
            `Select a country:`;
        await ctx.editMessageCaption(message, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🇺🇸 USA', 'tier_country_US')],
                [Markup.button.callback('🇬🇧 UK', 'tier_country_UK')],
                [Markup.button.callback('🇨🇦 Canada', 'tier_country_CA')],
                [Markup.button.callback('🔙 Back', 'tier_back_tier')]
            ]).reply_markup
        });
    }

    async _fallbackCountryPurchase(ctx, countryCode) {
        const service = ctx.session?.otpService;
        const tierKey = ctx.session?.selectedTier;
        const message = 
            `⏳ <b>Processing Order</b>\n\n` +
            `Service: ${service}\n` +
            `Country: ${countryCode}\n` +
            `Tier: ${tierKey}\n\n` +
            `Creating your session...`;
        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', 'tier_back_tier')]
            ]).reply_markup
        });
    }

    async _createSessionFromPurchase(ctx, result) {
        const message = 
            `✅ <b>Number Purchased</b>\n\n` +
            `Number: <code>${result.number || 'N/A'}</code>\n` +
            `Operator: ${result.operator || 'N/A'}\n` +
            `Expires: ${result.expiresAt ? new Date(result.expiresAt).toLocaleString() : 'N/A'}\n\n` +
            `Waiting for SMS...`;
        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Check SMS', 'check_sms')],
                [Markup.button.callback('❌ Cancel', 'cancel_session')]
            ]).reply_markup
        });
    }
}

export default TierFlowMiddleware;
        
