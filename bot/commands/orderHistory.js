// bot/commands/orderHistory.js — 📦 My Orders + 🔄 Buy Again for normal OTP sessions.
import logger from '../../utils/logger.js';
import { show, safeAnswer } from './_show.js';
import { ordersView, orderDetailView, buyAgainSessionView, newSessionView, failureView } from './othersView.js';
import { ORDER_FILTERS } from '../../services/otp/OrderHistoryService.js';

export default class OrderHistoryCommands {
    constructor(bot, { history, buyAgain, userModel }) { Object.assign(this, { bot, history, buyAgain, userModel }); this.inflight = new Set(); }

    register() {
        const b = this.bot;
        b.command('orders', (ctx) => this.list(ctx, 'all', 0));
        b.action('my_orders', (ctx) => this.list(ctx, 'all', 0));
        b.action(new RegExp(`^mof:(${ORDER_FILTERS.join('|')})$`), (ctx) => this.list(ctx, ctx.match[1], 0));
        b.action(new RegExp(`^mop:(${ORDER_FILTERS.join('|')}):(\\d{1,4})$`), (ctx) => this.list(ctx, ctx.match[1], +ctx.match[2]));
        b.action(/^mod:([SO]):([A-Za-z0-9_\-]{1,48})$/, (ctx) => this.detail(ctx, ctx.match[1], ctx.match[2]));
        b.action(/^bas:([A-Za-z0-9_\-]{1,48})$/, (ctx) => this.buyAgainStart(ctx, ctx.match[1]));
        b.action(/^basc:([A-Za-z0-9_\-]{1,48}):(\d{1,7})$/, (ctx) => this.buyAgainConfirm(ctx, ctx.match[1], +ctx.match[2]));
        logger.info('My Orders / Buy Again commands registered');
    }
    uid(ctx) { return ctx.from?.id ? String(ctx.from.id) : null; }

    async list(ctx, filter, page) {
        await safeAnswer(ctx);
        if (!this.uid(ctx)) return;
        try { await show(ctx, ordersView(await this.history.list(this.uid(ctx), { filter, page }))); }
        catch (e) { logger.error('My Orders failed', { error: e.message }); await show(ctx, failureView({ status: 'ERROR' })); }
    }

    async detail(ctx, kind, id) {
        await safeAnswer(ctx);
        const d = await this.history.detail(this.uid(ctx), kind, id); // ownership enforced in the query
        if (!d) return show(ctx, failureView({ status: 'NOT_FOUND' }));
        await show(ctx, orderDetailView(d));
    }

    async _blocked(ctx) {
        const u = await this.userModel.findOne({ userId: this.uid(ctx) }).select('isBlacklisted').lean().catch(() => null);
        if (u?.isBlacklisted) { await show(ctx, failureView({ status: 'RESTRICTED' })); return true; }
        return false;
    }

    async buyAgainStart(ctx, sessionId) {
        await safeAnswer(ctx);
        if (!this.uid(ctx) || await this._blocked(ctx)) return;
        const q = await this.buyAgain.quoteSession(this.uid(ctx), sessionId);
        if (!q.ok) return show(ctx, failureView({ status: q.reason }));
        if (q.changed || !q.sufficient) return show(ctx, buyAgainSessionView(q));
        return this._do(ctx, sessionId, q.price);
    }
    async buyAgainConfirm(ctx, sessionId, cents) { await safeAnswer(ctx); return this._do(ctx, sessionId, cents / 100); }

    async _do(ctx, sessionId, price) {
        const userId = this.uid(ctx);
        if (this.inflight.has(userId)) return safeAnswer(ctx, 'Please wait…');
        this.inflight.add(userId);
        try {
            await show(ctx, { text: '⏳ <b>Getting you a fresh number…</b>', reply_markup: { inline_keyboard: [] } });
            const r = await this.buyAgain.buySession(userId, sessionId, { confirmedPrice: price });
            if (r.status === 'OK') return show(ctx, newSessionView(r.session));
            if (r.status === 'CONFIRM_PRICE') { const q = await this.buyAgain.quoteSession(userId, sessionId); if (q.ok) return show(ctx, buyAgainSessionView(q)); }
            return show(ctx, failureView(r));
        } catch (e) { logger.error('Buy Again (session) handler failed', { userId, error: e.message }); await show(ctx, failureView({ status: 'ERROR' })); }
        finally { this.inflight.delete(userId); }
    }
}
