// services/others/OthersStore.js — persistence layer (MongoDB). All state changes are single atomic updates.
import OthersActivation from '../../models/OthersActivation.js';

const lean = (q) => q.lean();
const dup = (e) => e && (e.code === 11000 || /E11000/.test(e.message || ''));

export class OthersStore {
    constructor(model = OthersActivation) { this.M = model; }

    async create(doc) {
        try { const d = await this.M.create(doc); return d.toObject(); }
        catch (e) { if (dup(e)) { const err = new Error('DUPLICATE_REQUEST'); err.code = 'DUPLICATE_REQUEST'; throw err; } throw e; }
    }
    findById(activationId) { return lean(this.M.findOne({ activationId })); }
    findOwned(userId, activationId) { return lean(this.M.findOne({ activationId, userId: String(userId) })); }
    findByRequestKey(requestKey) { return lean(this.M.findOne({ requestKey })); }

    /** Atomic state transition; returns the updated doc or null if the doc is not in one of `from`. */
    transition(activationId, from, patch) {
        return lean(this.M.findOneAndUpdate({ activationId, status: { $in: from } }, { $set: patch }, { new: true }));
    }
    update(activationId, patch) { return lean(this.M.findOneAndUpdate({ activationId }, { $set: patch }, { new: true })); }
    unsetRequestKey(activationId) { return this.M.updateOne({ activationId }, { $unset: { requestKey: 1 } }); }

    /** Claim due ACTIVE activations for polling (lease-based, safe with multiple workers). */
    async claimForPoll(now, lockMs, limit = 25) {
        const out = [];
        for (let i = 0; i < limit; i++) {
            const d = await lean(this.M.findOneAndUpdate(
                { status: 'ACTIVE', nextPollAt: { $lte: now }, $or: [{ pollLockUntil: null }, { pollLockUntil: { $lte: now } }] },
                { $set: { pollLockUntil: new Date(now.getTime() + lockMs) } }, { new: true, sort: { nextPollAt: 1 } }));
            if (!d) break; out.push(d);
        }
        return out;
    }

    claimRefund(activationId, staleBefore) {
        return lean(this.M.findOneAndUpdate(
            { activationId, $or: [{ 'refund.status': null }, { 'refund.status': 'FAILED' }, { 'refund.status': 'PROCESSING', 'refund.at': { $lt: staleBefore } }] },
            { $set: { 'refund.status': 'PROCESSING', 'refund.at': new Date() } }, { new: true }));
    }
    claimCapture(activationId, staleBefore) {
        return lean(this.M.findOneAndUpdate(
            { activationId, $or: [{ 'capture.status': null }, { 'capture.status': 'FAILED' }, { 'capture.status': 'PROCESSING', 'capture.at': { $lt: staleBefore } }] },
            { $set: { 'capture.status': 'PROCESSING', 'capture.at': new Date() } }, { new: true }));
    }

    listByUser(userId, { statuses = null, limit = 20, skip = 0 } = {}) {
        const q = { userId: String(userId) }; if (statuses) q.status = { $in: statuses };
        return lean(this.M.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit));
    }
    countByUser(userId, statuses = null) {
        const q = { userId: String(userId) }; if (statuses) q.status = { $in: statuses };
        return this.M.countDocuments(q);
    }
    countActive(userId) { return this.M.countDocuments({ userId: String(userId), status: { $in: ['PURCHASING', 'ACTIVE'] } }); }

    // Reconciliation queries
    needsCapture(before, limit = 20) {
        return lean(this.M.find({ status: 'RECEIVED', 'capture.status': { $ne: 'DONE' }, lockTxId: { $ne: null }, receivedAt: { $lt: before } }).limit(limit));
    }
    needsRefund(before, limit = 20) {
        return lean(this.M.find({ status: { $in: ['EXPIRED', 'CANCELLED', 'FAILED'] }, lockTxId: { $ne: null },
            'refund.status': { $ne: 'DONE' }, endedAt: { $lt: before } }).limit(limit));
    }
    stalePurchasing(before, limit = 20) { return lean(this.M.find({ status: 'PURCHASING', createdAt: { $lt: before } }).limit(limit)); }
    // Admin queries
    list(filter = {}, limit = 20) { return lean(this.M.find(filter).sort({ createdAt: -1 }).limit(limit)); }
    findByPhoneOrProviderId(q) { return lean(this.M.findOne({ $or: [{ phone: q }, { phone: `+${q}` }, { providerId: q }, { activationId: q }] })); }
}
export default OthersStore;
