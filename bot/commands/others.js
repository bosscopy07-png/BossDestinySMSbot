// bot/commands/others.js — Telegram handlers for 📱 OTHERS (generic number rental).
// All state-changing callbacks verify ownership through the manager (queries are scoped by userId).
import logger from '../../utils/logger.js';
import { show, safeAnswer } from './_show.js';
import { countriesView, offersView, confirmView, activationView, buyAgainConfirmView, failureView } from './othersView.js';

const T = '[a-z0-9_\\-]{1,32}', ID = '[0-9a-f\\-]{36}';

export default class OthersCommands {
    constructor(bot, { manager, buyAgain, userModel, walletService }) {
        Object.assign(this, { bot, manager, buyAgain, userModel, walletService });
        this.inflight = new Set();
    }

    register() {
        const b = this.bot;
        b.command('others', (ctx) => this.menu(ctx, 0));
        b.action('others_menu', (ctx) => this.menu(ctx, 0));
        b.action(/^ocp:(\d{1,3})$/, (ctx) => this.menu(ctx, +ctx.match[1]));
        b.action(new RegExp(`^oc:(${T})$`), (ctx) => this.offers(ctx, ctx.match[1]));
        b.action(new RegExp(`^oo:(${T}):(${T}):(\\d{1,7})$`), (ctx) => this.confirm(ctx, ctx.match[1], ctx.match[2], +ctx.match[3]));
        b.action(new RegExp(`^ob:(${T}):(${T}):(\\d{1,7})$`), (ctx) => this.buy(ctx, ctx.match[1], ctx.match[2], +ctx.match[3]));
        b.action(new RegExp(`^or:(${ID})$`), (ctx) => this.refresh(ctx, ctx.match[1]));
        b.action(new RegExp(`^ov:(${ID})$`), (ctx) => this.view(ctx, ctx.match[1]));
        b.action(new RegExp(`^ox:(${ID})$`), (ctx) => this.cancelAsk(ctx, ctx.match[1]));
        b.action(new RegExp(`^oxy:(${ID})$`), (ctx) => this.cancel(ctx, ctx.match[1]));
        b.action(new RegExp(`^oba:(${ID})$`), (ctx) => this.buyAgainStart(ctx, ctx.match[1]));
        b.action(new RegExp(`^obac:(${ID}):(\\d{1,7})$`), (ctx) => this.buyAgainConfirm(ctx, ctx.match[1], +ctx.match[2]));
        logger.info('OTHERS commands registered');
    }

    uid(ctx) { return ctx.from?.id ? String(ctx.from.id) : null; }

    async _blocked(ctx) {
        try {
            const u = await this.userModel.findOne({ userId: this.uid(ctx) }).select('isBlacklisted').lean();
            if (u?.isBlacklisted) { await show(ctx, failureView({ status: 'RESTRICTED' })); return true; }
        } catch (e) { logger.warn('OTHERS blocked-check failed', { error: e.message }); }
        return false;
    }

    async _balance(userId) {
        const u = await this.userModel.findOne({ userId }).select('balance lockedBalance').lean();
        return u ? (u.balance || 0) - (u.lockedBalance || 0) : 0;
    }

    async menu(ctx, page = 0) {
        await safeAnswer(ctx);
        if (!this.uid(ctx) || await this._blocked(ctx)) return;
        try { await show(ctx, countriesView(await this.manager.listCountries(), page)); }
        catch (e) { logger.error('OTHERS countries failed', { error: e.code || e.message }); await show(ctx, failureView({ status: 'PROVIDER_ERROR' })); }
    }

    async offers(ctx, slug) {
        await safeAnswer(ctx);
        try {
            const [offers, name, list] = await Promise.all([this.manager.getOffers(slug), this.manager.countryName(slug), this.manager.listCountries()]);
            await show(ctx, offersView(name, slug, offers, list.find(c => c.slug === slug)?.iso));
        } catch (e) { await show(ctx, failureView({ status: 'PROVIDER_ERROR' })); }
    }

    async confirm(ctx, slug, operator, cents) {
        await safeAnswer(ctx);
        try {
            const offers = await this.manager.getOffers(slug, { fresh: true });
            const o = offers.find(x => x.operator === operator);
            if (!o) return show(ctx, failureView({ status: 'NO_STOCK' }));
            const [name, balance] = await Promise.all([this.manager.countryName(slug), this._balance(this.uid(ctx))]);
            await show(ctx, confirmView({ countryName: name, price: o.price, balance, slug, operator })); // always shows the LIVE price
        } catch (e) { await show(ctx, failureView({ status: 'PROVIDER_ERROR' })); }
    }

    async buy(ctx, slug, operator, cents) {
        const userId = this.uid(ctx);
        if (!userId) return;
        if (this.inflight.has(userId)) return safeAnswer(ctx, 'Please wait…');
        this.inflight.add(userId);
        try {
            await safeAnswer(ctx, 'Requesting your number…');
            if (await this._blocked(ctx)) return;
            await show(ctx, { text: '⏳ <b>Requesting your number…</b>\nThis usually takes a few seconds.', reply_markup: { inline_keyboard: [] } });
            const key = `buy:${userId}:${ctx.callbackQuery?.message?.message_id}:${ctx.callbackQuery?.data}`;
            const r = await this.manager.purchase({ userId, country: slug, operator, expectedPrice: cents / 100, requestKey: key });
            await this._renderPurchase(ctx, r, slug, operator);
        } catch (e) {
            logger.error('OTHERS buy failed', { userId, error: e.message });
            await show(ctx, failureView({ status: 'ERROR' }));
        } finally { this.inflight.delete(userId); }
    }

    async _renderPurchase(ctx, r, slug, operator) {
        if (r.status === 'OK' || r.status === 'DUPLICATE') {
            const a = r.activation; return show(ctx, activationView(a, { canRebuy: this.buyAgain.isOthersEligible(a) }));
        }
        if (r.status === 'PRICE_CHANGED') {
            const [name, balance] = await Promise.all([this.manager.countryName(slug), this._balance(this.uid(ctx))]);
            return show(ctx, { ...confirmView({ countryName: name, price: r.price, balance, slug, operator }), text: `💲 <b>The price changed to ${'$' + r.price.toFixed(2)}.</b>\n\n` + confirmView({ countryName: name, price: r.price, balance, slug, operator }).text });
        }
        return show(ctx, failureView(r));
    }

    async view(ctx, id) {
        await safeAnswer(ctx);
        const a = await this.manager.get(this.uid(ctx), id);
        if (!a) return show(ctx, failureView({ status: 'NOT_FOUND' }));
        await show(ctx, activationView(a, { canRebuy: this.buyAgain.isOthersEligible(a) }));
    }

    async refresh(ctx, id) {
        await safeAnswer(ctx, 'Checking…');
        const userId = this.uid(ctx);
        let a = await this.manager.get(userId, id);
        if (!a) return show(ctx, failureView({ status: 'NOT_FOUND' }));
        if (a.status === 'ACTIVE') { try { await this.manager.pollOne(a); } catch (e) { logger.warn('OTHERS manual poll failed', { error: e.message }); } a = await this.manager.get(userId, id); }
        await show(ctx, activationView(a, { canRebuy: this.buyAgain.isOthersEligible(a) }));
    }

    async cancelAsk(ctx, id) {
        await safeAnswer(ctx);
        const a = await this.manager.get(this.uid(ctx), id);
        if (!a || a.status !== 'ACTIVE') return this.view(ctx, id);
        await show(ctx, { text: `❌ <b>Cancel this number?</b>\n\nIf no SMS has arrived, the provider cancels it and your reserved <b>$${a.priceUsd.toFixed(2)}</b> is released.`,
            reply_markup: { inline_keyboard: [[{ text: '✅ Yes, cancel', callback_data: `oxy:${id}` }], [{ text: '◀️ Keep it', callback_data: `ov:${id}` }]] } });
    }

    async cancel(ctx, id) {
        await safeAnswer(ctx, 'Cancelling…');
        const userId = this.uid(ctx);
        const r = await this.manager.cancelByUser(userId, id);
        const a = await this.manager.get(userId, id);
        if (r.status === 'OK') return show(ctx, activationView(a, { canRebuy: this.buyAgain.isOthersEligible(a), refund: r.refund }));
        const note = { HAS_SMS: '📨 An SMS already arrived, so this number can no longer be cancelled.', PROVIDER_REFUSED: '⚠️ The provider did not confirm the cancellation (it may not be allowed yet). Nothing was refunded — try again shortly, or wait for it to expire for an automatic release.', NOT_CANCELLABLE: 'ℹ️ This number can no longer be cancelled.' }[r.status] || '⚠️ Could not cancel.';
        const v = a ? activationView(a, { canRebuy: this.buyAgain.isOthersEligible(a) }) : failureView({ status: 'NOT_FOUND' });
        await show(ctx, { ...v, text: `${note}\n\n${v.text}` });
    }

    async buyAgainStart(ctx, id) {
        const userId = this.uid(ctx);
        await safeAnswer(ctx);
        if (!userId || await this._blocked(ctx)) return;
        const q = await this.buyAgain.quoteOthers(userId, id);
        if (!q.ok) return show(ctx, failureView({ status: q.reason === 'PROVIDER_ERROR' ? 'PROVIDER_ERROR' : q.reason }));
        if (q.changed || !q.sufficient) {
            return show(ctx, buyAgainConfirmView({ activationId: id, price: q.price, previous: q.previous, operatorChanged: q.operatorChanged, countryName: q.activation.countryName || q.activation.country, balance: q.balance }));
        }
        return this._doBuyAgain(ctx, id, q.price);
    }

    async buyAgainConfirm(ctx, id, cents) { await safeAnswer(ctx); return this._doBuyAgain(ctx, id, cents / 100); }

    async _doBuyAgain(ctx, id, price) {
        const userId = this.uid(ctx);
        if (this.inflight.has(userId)) return safeAnswer(ctx, 'Please wait…');
        this.inflight.add(userId);
        try {
            await show(ctx, { text: '⏳ <b>Getting you a fresh number…</b>', reply_markup: { inline_keyboard: [] } });
            const r = await this.buyAgain.buyOthers(userId, id, { confirmedPrice: price });
            if (r.status === 'OK' || r.status === 'DUPLICATE') return show(ctx, activationView(r.activation, { canRebuy: false }));
            if (r.status === 'CONFIRM_PRICE') {
                const q = await this.buyAgain.quoteOthers(userId, id);
                if (q.ok) return show(ctx, buyAgainConfirmView({ activationId: id, price: r.price, previous: r.previous, operatorChanged: r.operatorChanged, countryName: q.activation.countryName || q.activation.country, balance: q.balance }));
            }
            return show(ctx, failureView(r));
        } catch (e) { logger.error('OTHERS buy again failed', { userId, error: e.message }); await show(ctx, failureView({ status: 'ERROR' })); }
        finally { this.inflight.delete(userId); }
    }

    /** Called by the manager's notifier when an SMS arrives or an activation expires. */
    async notify(userId, a, event) {
        const view = activationView(a, { canRebuy: this.buyAgain.isOthersEligible(a), refund: a._refund });
        const head = event === 'OTP' ? '🔔 <b>Your code has arrived!</b>\n\n' : event === 'EXPIRED' ? '🔔 <b>Your number expired without an SMS.</b>\n\n' : '';
        await this.bot.telegram.sendMessage(userId, head + view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup });
    }
          }
                                                       
