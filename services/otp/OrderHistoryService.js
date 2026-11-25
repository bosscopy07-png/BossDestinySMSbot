// services/otp/OrderHistoryService.js — unified, paginated, ownership-checked activation history
// (normal OTP sessions + OTHERS). Read-only: never modifies existing records.
const FILTERS = {
    all: { s: null, o: null },
    active: { s: ['WAITING', 'CHECKING'], o: ['PURCHASING', 'ACTIVE'] },
    completed: { s: ['RECEIVED'], o: ['RECEIVED'] },
    expired: { s: ['TIMEOUT', 'FAILED'], o: ['EXPIRED', 'FAILED'] },
    cancelled: { s: ['CANCELLED'], o: ['CANCELLED'] }
};
export const ORDER_FILTERS = Object.keys(FILTERS);

export class OrderHistoryService {
    constructor({ sessionModel, othersStore, buyAgain = null }) { Object.assign(this, { sessionModel, othersStore, buyAgain }); }

    _fromSession(s) {
        return { kind: 'S', id: s.sessionId, service: s.service, country: s.country, number: s.number, status: s.status, price: s.cost || 0,
            otp: s.otpCode || null, createdAt: s.startTime || s.createdAt, endedAt: s.endTime || null,
            rebuy: this.buyAgain ? this.buyAgain.isSessionEligible(s) : false, provider: s.provider };
    }
    _fromOthers(a) {
        return { kind: 'O', id: a.activationId, service: 'OTHERS', country: a.countryName || a.country, number: a.phone, status: a.status, price: a.priceUsd || 0,
            otp: a.otpCode || null, createdAt: a.createdAt, endedAt: a.endedAt || null, expiresAt: a.expiresAt || null,
            messages: a.messages || [], refund: a.refund?.status === 'DONE', rebuy: this.buyAgain ? this.buyAgain.isOthersEligible(a) : false };
    }

    async list(userId, { page = 0, pageSize = 6, filter = 'all' } = {}) {
        userId = String(userId);
        const f = FILTERS[filter] || FILTERS.all;
        page = Math.max(0, parseInt(page, 10) || 0);
        const need = (page + 1) * pageSize;
        const sq = { userId, ...(f.s ? { status: { $in: f.s } } : {}) };
        const [ss, os, sc, oc] = await Promise.all([
            this.sessionModel.find(sq).sort({ startTime: -1 }).limit(need).lean(),
            this.othersStore.listByUser(userId, { statuses: f.o, limit: need }),
            this.sessionModel.countDocuments(sq),
            this.othersStore.countByUser(userId, f.o)
        ]);
        const merged = [...ss.map(x => this._fromSession(x)), ...os.map(x => this._fromOthers(x))]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const total = sc + oc;
        return { items: merged.slice(page * pageSize, page * pageSize + pageSize), page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), filter };
    }

    async detail(userId, kind, id) {
        userId = String(userId);
        if (kind === 'S') { const s = await this.sessionModel.findOne({ sessionId: id, userId }).lean(); return s ? this._fromSession(s) : null; }
        if (kind === 'O') { const a = await this.othersStore.findOwned(userId, id); return a ? this._fromOthers(a) : null; }
        return null;
    }
}
export default OrderHistoryService;
              
