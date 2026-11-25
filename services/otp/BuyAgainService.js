// services/otp/BuyAgainService.js — "🔄 Buy Again" for normal OTP sessions and OTHERS.
// Every Buy Again creates a brand-new activation; old numbers / provider ids are never reused.
import logger from '../../utils/logger.js';
import { OTHERS_REBUY_ELIGIBLE } from '../others/constants.js';

const SESSION_ELIGIBLE = ['TIMEOUT', 'FAILED', 'CANCELLED'];
const cents = (n) => Math.round(Number(n) * 100);

export class BuyAgainService {
    constructor({ sessionModel, userModel, sessionManager, smsProviderManager, othersManager, now = () => new Date() }) {
        Object.assign(this, { sessionModel, userModel, sessionManager, smsProviderManager, othersManager, now });
    }

    // ───────────── eligibility (also used by My Orders to decide whether to show the button) ─────────────
    isSessionEligible(s) {
        return !!s && s.mode === 'CHEAP' && SESSION_ELIGIBLE.includes(s.status) && !s.otpCode && !s.rebuyClaimedAt && !s.rebuyClaimedBy;
    }
    isOthersEligible(a) {
        return !!a && OTHERS_REBUY_ELIGIBLE.includes(a.status) && !a.otpCode && !a.rebuyClaimedBy;
    }

    async _available(userId) {
        const u = await this.userModel.findOne({ userId: String(userId) }).lean();
        return u ? (u.balance || 0) - (u.lockedBalance || 0) : 0;
    }

    // ───────────── normal OTP sessions ─────────────
    async quoteSession(userId, sessionId) {
        const s = await this.sessionModel.findOne({ sessionId, userId: String(userId) }).lean(); // ownership in the query
        if (!s) return { ok: false, reason: 'NOT_FOUND' };
        if (!this.isSessionEligible(s)) return { ok: false, reason: 'NOT_ELIGIBLE' };
        let p;
        try { p = await this.smsProviderManager.getCheapPrice(s.country, s.service); }
        catch (e) { return { ok: false, reason: 'PROVIDER_ERROR', detail: e.message }; }
        if (!p || p.available === false || !(p.displayPrice > 0)) return { ok: false, reason: 'NO_STOCK' };
        const balance = await this._available(userId);
        return { ok: true, session: s, price: p.displayPrice, previous: s.cost, changed: cents(p.displayPrice) !== cents(s.cost || 0),
            balance, sufficient: balance + 1e-9 >= p.displayPrice, shortfall: Math.max(0, p.displayPrice - balance) };
    }

    async buySession(userId, sessionId, { confirmedPrice = null } = {}) {
        const q = await this.quoteSession(userId, sessionId);
        if (!q.ok) return { status: q.reason, detail: q.detail };
        if (q.changed && (confirmedPrice == null || cents(confirmedPrice) !== cents(q.price))) return { status: 'CONFIRM_PRICE', price: q.price, previous: q.previous };
        if (!q.sufficient) return { status: 'INSUFFICIENT_FUNDS', required: q.price, shortfall: q.shortfall };

        // atomic claim: repeated taps cannot create two purchases
        const claim = await this.sessionModel.findOneAndUpdate(
            { sessionId, userId: String(userId), status: { $in: SESSION_ELIGIBLE }, otpCode: null, rebuyClaimedAt: null, rebuyClaimedBy: null },
            { $set: { rebuyClaimedAt: this.now() } }, { new: true }).lean();
        if (!claim) return { status: 'DUPLICATE' };

        const release = () => this.sessionModel.updateOne({ sessionId }, { $set: { rebuyClaimedAt: null } });
        try {
            const created = await this.sessionManager.createSession(String(userId), 'CHEAP', claim.service, claim.country);
            if (cents(created.cost) > cents(q.price)) { // never silently charge more than what was shown
                await this.sessionManager.cancelSession(created.sessionId, String(userId)).catch(() => {});
                await release();
                return { status: 'CONFIRM_PRICE', price: created.cost, previous: q.price };
            }
            await this.sessionModel.updateOne({ sessionId: created.sessionId }, { $set: { rebuyOf: sessionId } });
            await this.sessionModel.updateOne({ sessionId }, { $set: { rebuyClaimedBy: created.sessionId } });
            logger.info('Buy Again (session) created', { userId, from: sessionId, to: created.sessionId });
            return { status: 'OK', session: created };
        } catch (e) {
            await release();
            const m = String(e.message || '');
            if (m.includes('INSUFFICIENT_FUNDS')) return { status: 'INSUFFICIENT_FUNDS', required: q.price, shortfall: q.shortfall };
            if (m.includes('ACTIVE_SESSION_EXISTS')) return { status: 'ACTIVE_SESSION_EXISTS' };
            if (m.includes('USER_BLACKLISTED')) return { status: 'RESTRICTED' };
            if (m.includes('NUMBER_UNAVAILABLE')) return { status: 'NO_STOCK' };
            logger.error('Buy Again (session) failed', { userId, sessionId, error: m });
            return { status: 'ERROR', detail: m };
        }
    }

    // ───────────── OTHERS ─────────────
    async quoteOthers(userId, activationId) {
        const a = await this.othersManager.get(userId, activationId);
        if (!a) return { ok: false, reason: 'NOT_FOUND' };
        if (!this.isOthersEligible(a)) return { ok: false, reason: 'NOT_ELIGIBLE' };
        let offers;
        try { offers = await this.othersManager.getOffers(a.country, { fresh: true }); }
        catch (e) { return { ok: false, reason: 'PROVIDER_ERROR', detail: e.code || e.message }; }
        if (!offers.length) return { ok: false, reason: 'NO_STOCK' };
        let offer = offers.find(o => o.operator === a.operator);
        const operatorChanged = !offer;
        if (!offer) offer = offers[0]; // cheapest in stock; user must confirm because it differs
        const balance = await this._available(userId);
        return { ok: true, activation: a, operator: offer.operator, operatorChanged, price: offer.price, previous: a.priceUsd,
            changed: operatorChanged || cents(offer.price) !== cents(a.priceUsd), balance, sufficient: balance + 1e-9 >= offer.price,
            shortfall: Math.max(0, offer.price - balance) };
    }

    async buyOthers(userId, activationId, { confirmedPrice = null } = {}) {
        const q = await this.quoteOthers(userId, activationId);
        if (!q.ok) return { status: q.reason, detail: q.detail };
        if (q.changed && (confirmedPrice == null || cents(confirmedPrice) !== cents(q.price))) return { status: 'CONFIRM_PRICE', price: q.price, previous: q.previous, operatorChanged: q.operatorChanged };
        if (!q.sufficient) return { status: 'INSUFFICIENT_FUNDS', required: q.price, shortfall: q.shortfall };
        const r = await this.othersManager.purchase({
            userId, country: q.activation.country, operator: q.operator, expectedPrice: q.price,
            requestKey: `rebuy:${q.activation.activationId}`, rebuyOf: q.activation.activationId
        });
        if (r.status === 'PRICE_CHANGED') return { status: 'CONFIRM_PRICE', price: r.price, previous: q.price };
        return r;
    }
}
export default BuyAgainService;
