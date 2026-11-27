// services/others/OthersManager.js — orchestrates the OTHERS (generic number) lifecycle.
// Dependencies are injected so the whole flow is unit-testable without MongoDB/Telegram/5sim.
import { randomUUID } from 'crypto';
import logger from '../../utils/logger.js';
import { OTHERS_STATUS as S, OTHERS_DEFAULTS as D, TOKEN_RE } from './constants.js';
import { OthersPricing } from './OthersPricing.js';
import { OthersRefund } from './OthersRefund.js';
import { groupByCountry, extractOtp, titleCase } from './OthersParser.js';

const POPULAR = ['usa', 'england', 'canada', 'germany', 'france', 'netherlands', 'poland', 'spain', 'italy', 'australia'];

export class OthersManager {
    constructor({ store, provider, wallet, pricing = new OthersPricing(), refund = null, notifier = null,
        now = () => new Date(), timeoutMin = parseInt(process.env.OTHERS_TIMEOUT_MIN || '10', 10), maxActive = parseInt(process.env.OTHERS_MAX_ACTIVE || '3', 10) } = {}) {
        this.store = store; this.provider = provider; this.wallet = wallet; this.pricing = pricing;
        this.refunds = refund || new OthersRefund({ store, wallet, now });
        this.notifier = notifier; this.now = now; this.maxActive = maxActive; this.timeoutMin = timeoutMin;
        this._cache = new Map(); this._names = null; this._namesAt = 0;
    }

    setNotifier(fn) { this.notifier = fn; }
    async _notify(a, event) { try { if (this.notifier) await this.notifier(a.userId, a, event); } catch (e) { logger.warn('OTHERS notify failed', { activationId: a.activationId, event, error: e.message }); } }

    // ───────────────────────── catalogue (real provider data only) ─────────────────────────
    async _names_() {
        if (!this._names || this.now().getTime() - this._namesAt > 3600e3) { this._names = await this.provider.getCountryNames(); this._namesAt = this.now().getTime(); }
        return this._names;
    }

    async listCountries({ fresh = false } = {}) {
        const key = '__countries__'; const hit = this._cache.get(key);
        if (!fresh && hit && this.now().getTime() - hit.at < D.cacheTtlMs) return hit.v;
        const offers = await this.provider.getOffers(null);
        const names = await this._names_();
        const list = groupByCountry(offers).map(g => ({
            slug: g.country, name: names[g.country]?.name || titleCase(g.country), iso: names[g.country]?.iso || null,
            price: this.pricing.userPrice(g.minCost), stock: g.stock
        })).filter(c => c.price);
        list.sort((a, b) => { const pa = POPULAR.indexOf(a.slug), pb = POPULAR.indexOf(b.slug); if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb); return a.name.localeCompare(b.name); });
        this._cache.set(key, { at: this.now().getTime(), v: list });
        return list;
    }

    async getOffers(country, { fresh = false } = {}) {
        if (!TOKEN_RE.test(country || '')) throw Object.assign(new Error('BAD_COUNTRY'), { code: 'BAD_COUNTRY' });
        const key = `o:${country}`; const hit = this._cache.get(key);
        if (!fresh && hit && this.now().getTime() - hit.at < 20000) return hit.v;
        const raw = await this.provider.getOffers(country);
        const v = raw.filter(o => o.count > 0).map(o => ({ operator: o.operator, cost: o.cost, price: this.pricing.userPrice(o.cost), stock: o.count }))
            .filter(o => o.price).sort((a, b) => a.price - b.price);
        this._cache.set(key, { at: this.now().getTime(), v });
        return v;
    }

    async countryName(slug) { const n = await this._names_().catch(() => ({})); return n[slug]?.name || titleCase(slug); }

    // ───────────────────────── purchase ─────────────────────────
    async purchase({ userId, country, operator = 'any', expectedPrice = null, requestKey = null, rebuyOf = null }) {
        userId = String(userId);
        if (!TOKEN_RE.test(country || '') || !TOKEN_RE.test(operator || '')) return { status: 'INVALID_INPUT' };
        if (!this.provider.isConfigured) return { status: 'PROVIDER_NOT_CONFIGURED' };

        if (requestKey) { const ex = await this.store.findByRequestKey(requestKey); if (ex) return { status: 'DUPLICATE', activation: ex }; }
        if ((await this.store.countActive(userId)) >= this.maxActive) return { status: 'TOO_MANY_ACTIVE', max: this.maxActive };

        // 1. live inventory + live price (never cached for a purchase)
        let offers;
        try { offers = await this.getOffers(country, { fresh: true }); }
        catch (e) { return { status: 'PROVIDER_ERROR', code: e.code || 'PROVIDER_ERROR' }; }
        const offer = offers.find(o => o.operator === operator && o.stock > 0);
        if (!offer) return { status: 'NO_STOCK' };
        if (expectedPrice != null && OthersPricing.toCents(offer.price) !== OthersPricing.toCents(expectedPrice)) {
            return { status: 'PRICE_CHANGED', price: offer.price, operator };
        }

        // 2. create the record first (idempotency key makes double-taps harmless)
        let act;
        try {
            act = await this.store.create({
                activationId: randomUUID(), userId, country, countryName: await this.countryName(country), operator,
                product: this.provider.product || 'other', provider: '5SIM', priceUsd: offer.price, status: S.PURCHASING,
                requestKey: requestKey || undefined, rebuyOf, createdAt: this.now()
            });
        } catch (e) {
            if (e.code === 'DUPLICATE_REQUEST') { const ex = await this.store.findByRequestKey(requestKey); return { status: 'DUPLICATE', activation: ex }; }
            throw e;
        }

        // 3. reserve funds atomically (no money leaves the wallet yet)
        let lockTxId;
        try { lockTxId = await this.wallet.lockFunds(userId, offer.price, `OTHERS_${country}`); }
        catch (e) {
            await this._fail(act, e.message?.includes('INSUFFICIENT') ? 'INSUFFICIENT_FUNDS' : `WALLET_${e.message}`);
            return e.message?.includes('INSUFFICIENT') ? { status: 'INSUFFICIENT_FUNDS', required: offer.price } : { status: 'WALLET_ERROR' };
        }
        await this.store.update(act.activationId, { lockTxId });
        act.lockTxId = lockTxId;

        // 4. buy a brand-new activation from the provider
        let bought;
        try { bought = await this.provider.buy(country, operator, { maxPrice: offer.cost }); }
        catch (e) {
            await this._fail({ ...act, lockTxId }, e.code || 'PROVIDER_ERROR', { ambiguous: !!e.ambiguous });
            const code = e.code || 'PROVIDER_ERROR';
            return { status: code === 'NO_NUMBERS' ? 'NO_STOCK' : 'PROVIDER_ERROR', code, ambiguous: !!e.ambiguous };
        }

        // 5. activate. If we cannot persist, undo at the provider and release the funds.
        try {
            // Our own deadline is SHORTER than the provider's (5sim keeps numbers ~20-30 min): the user can still cancel any time,
            // and we cancel + refund ourselves at OTHERS_TIMEOUT_MIN (default 10) so the provider never expires first.
            const ownDeadline = new Date(this.now().getTime() + this.timeoutMin * 60000);
            const expiresAt = bought.expiresAt && bought.expiresAt < ownDeadline ? bought.expiresAt : ownDeadline;
            const active = await this.store.transition(act.activationId, [S.PURCHASING], {
                status: S.ACTIVE, providerId: bought.providerId, phone: bought.phone, providerCost: bought.cost,
                operator: bought.operator || operator, expiresAt, nextPollAt: new Date(this.now().getTime() + 3000), lastProviderStatus: bought.status
            });
            if (!active) throw new Error('STATE_CHANGED');
            if (rebuyOf) await this.store.update(rebuyOf, { rebuyClaimedBy: active.activationId });
            logger.info('OTHERS activation started', { activationId: active.activationId, userId, country, price: offer.price, providerCost: bought.cost });
            return { status: 'OK', activation: active };
        } catch (e) {
            logger.error('OTHERS persist after buy failed; reverting', { activationId: act.activationId, error: e.message });
            await this.provider.cancel(bought.providerId).catch(() => {});
            await this._fail({ ...act, lockTxId, providerId: bought.providerId }, 'PERSIST_FAILED', { ambiguous: true });
            return { status: 'PROVIDER_ERROR', code: 'PERSIST_FAILED' };
        }
    }

    async _fail(act, reason, { ambiguous = false } = {}) {
        const upd = await this.store.transition(act.activationId, [S.PURCHASING, S.ACTIVE], {
            status: S.FAILED, failureReason: reason, ambiguous, endedAt: this.now()
        });
        await this.store.unsetRequestKey(act.activationId); // allow a clean retry
        if (upd?.lockTxId || act.lockTxId) await this.refunds.refund({ ...(upd || act), lockTxId: upd?.lockTxId || act.lockTxId }, reason);
        return upd;
    }

    // ───────────────────────── user actions ─────────────────────────
    async get(userId, activationId) { return this.store.findOwned(userId, activationId); } // ownership enforced in the query

    async cancelByUser(userId, activationId) {
        const a = await this.store.findOwned(userId, activationId);
        if (!a) return { status: 'NOT_FOUND' };
        if (a.status !== S.ACTIVE) return { status: 'NOT_CANCELLABLE', current: a.status };
        const c = await this.provider.cancel(a.providerId);
        if (c.hasSms) { await this.pollOne(a); return { status: 'HAS_SMS' }; }
        if (!c.cancelled) return { status: 'PROVIDER_REFUSED', error: c.error || 'UNCONFIRMED' };
        const upd = await this.store.transition(a.activationId, [S.ACTIVE], { status: S.CANCELLED, endedAt: this.now(), failureReason: 'USER_CANCELLED' });
        if (!upd) return { status: 'NOT_CANCELLABLE' };
        const r = await this.refunds.refund(upd, 'USER_CANCELLED');
        return { status: 'OK', activation: upd, refund: r };
    }

    // ───────────────────────── polling ─────────────────────────
    _next(a, ms) { return this.store.update(a.activationId, { nextPollAt: new Date(this.now().getTime() + ms), pollLockUntil: null }); }

    async pollOne(a) {
        const now = this.now();
        let check;
        try { check = await this.provider.check(a.providerId); }
        catch (e) {
            const errorCount = (a.errorCount || 0) + 1;
            await this.store.update(a.activationId, { errorCount });
            if (a.expiresAt && now.getTime() > new Date(a.expiresAt).getTime() + 10 * 60000) return this.expire(a, 'PROVIDER_UNREACHABLE', { force: true });
            return this._next(a, 15000);
        }
        if (a.errorCount) await this.store.update(a.activationId, { errorCount: 0 });

        if (check.messages.length > 0) return this.handleSms(a, check.messages);
        if (['CANCELLED', 'EXPIRED', 'BANNED'].includes(check.status)) return this.expire(a, `PROVIDER_${check.status}`, { force: true });
        if (a.expiresAt && now.getTime() >= new Date(a.expiresAt).getTime() + D.expiryGraceMs) return this.expire(a, 'TIMEOUT');

        const age = now.getTime() - new Date(a.createdAt).getTime();
        return this._next(a, age < 120000 ? 4000 : 8000);
    }

    async handleSms(a, messages) {
        const latest = messages[messages.length - 1];
        const otp = extractOtp(latest.text, latest.code);
        const upd = await this.store.transition(a.activationId, [S.ACTIVE], {
            status: S.RECEIVED, messages, otpCode: otp.code, receivedAt: this.now(), endedAt: this.now(), pollLockUntil: null
        });
        if (!upd) return null; // already handled elsewhere
        await this._capture(upd);
        this.provider.finish(upd.providerId).catch(() => {});
        await this._notify(upd, 'OTP');
        return upd;
    }

    async _capture(a) {
        if (!a.lockTxId) return;
        const claimed = await this.store.claimCapture(a.activationId, new Date(this.now().getTime() - 2 * 60000));
        if (!claimed) return;
        try {
            await this.wallet.captureFunds(a.lockTxId, a.userId);
            await this.store.update(a.activationId, { 'capture.status': 'DONE', 'capture.at': this.now(), 'capture.error': null });
        } catch (e) {
            await this.store.update(a.activationId, { 'capture.status': 'FAILED', 'capture.error': e.message });
            logger.error('OTHERS capture failed (will retry)', { activationId: a.activationId, error: e.message });
        }
    }

    async expire(a, reason, { force = false } = {}) {
        if (!force && a.providerId) {
            const c = await this.provider.cancel(a.providerId);
            if (c.hasSms) { const chk = await this.provider.check(a.providerId).catch(() => null); if (chk?.messages?.length) return this.handleSms(a, chk.messages); }
            if (!c.cancelled && !c.hasSms) {
                const tooOld = a.expiresAt && this.now().getTime() > new Date(a.expiresAt).getTime() + 10 * 60000;
                if (!tooOld) return this._next(a, 15000); // provider not confirming yet: retry, do not refund prematurely
            }
        }
        const upd = await this.store.transition(a.activationId, [S.ACTIVE], { status: S.EXPIRED, endedAt: this.now(), failureReason: reason, pollLockUntil: null });
        if (!upd) return null;
        const r = await this.refunds.refund(upd, reason);
        await this._notify({ ...upd, _refund: r }, 'EXPIRED');
        return upd;
    }

    /** Retry captures/refunds that did not complete (crash, DB hiccup). Safe to run repeatedly. */
    async reconcile() {
        const before = new Date(this.now().getTime() - 60000); let fixed = 0;
        for (const a of await this.store.stalePurchasing(new Date(this.now().getTime() - 120000))) { await this._fail(a, 'STALE_PURCHASE', { ambiguous: true }); fixed++; }
        for (const a of await this.store.needsCapture(before)) { await this._capture(a); fixed++; }
        for (const a of await this.store.needsRefund(before)) { const r = await this.refunds.refund(a, a.failureReason || 'RECONCILE'); if (r.refunded) fixed++; }
        return { fixed };
    }
}
export default OthersManager;
        
