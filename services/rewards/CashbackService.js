// services/rewards/CashbackService.js — 1% cashback into a SEPARATE rewards wallet.
// Rewards never touch the main balance automatically: the user moves them with "Transfer to Main Wallet".
// Both operations are single-document atomic updates, so they are safe without MongoDB transactions.
import logger from '../../utils/logger.js';
import { CASHBACK_RATE, computeCashback, round4 } from './cashbackMath.js';

export class CashbackService {
    constructor({ User, Transaction, rate = CASHBACK_RATE, now = () => new Date() }) { Object.assign(this, { User, Transaction, rate, now }); }

    /** Idempotent: the same purchase (sourceTxId) can only ever earn cashback once. */
    async credit({ userId, amount, sourceTxId }) {
        const cashback = computeCashback(amount, this.rate);
        if (cashback <= 0 || !sourceTxId) return { credited: false, amount: 0 };
        const ref = `CB_${sourceTxId}`;
        const upd = await this.User.updateOne(
            { userId: String(userId), cashbackRefs: { $ne: ref } },
            { $inc: { cashbackBalance: cashback, cashbackEarned: cashback }, $push: { cashbackRefs: { $each: [ref], $slice: -500 } } }
        );
        if (!upd.matchedCount) return { credited: false, amount: 0, duplicate: true };
        try {
            await this.Transaction.updateOne({ txId: ref }, { $setOnInsert: {
                txId: ref, userId: String(userId), type: 'CASHBACK', amount: cashback, currency: 'USD', status: 'COMPLETED',
                metadata: { sourceTxId, rate: this.rate, purchaseAmount: Math.abs(Number(amount)), wallet: 'REWARDS' }, createdAt: this.now()
            } }, { upsert: true });
        } catch (e) { logger.warn('Cashback ledger write failed (balance already credited)', { ref, error: e.message }); }
        logger.info('Cashback credited', { userId, amount: cashback, sourceTxId });
        return { credited: true, amount: cashback };
    }

    async summary(userId) {
        const u = await this.User.findOne({ userId: String(userId) }).select('cashbackBalance cashbackEarned cashbackTransferred balance').lean();
        return { balance: u?.cashbackBalance || 0, earned: u?.cashbackEarned || 0, transferred: u?.cashbackTransferred || 0, mainBalance: u?.balance || 0, exists: !!u };
    }

    /** Move the whole rewards balance to the main wallet. Atomic + double-tap safe. */
    async transfer(userId) {
        userId = String(userId);
        for (let attempt = 0; attempt < 3; attempt++) {
            const u = await this.User.findOne({ userId }).select('cashbackBalance').lean();
            const raw = u?.cashbackBalance || 0;
            const amount = round4(raw);
            if (!(amount > 0)) return { ok: false, reason: 'EMPTY' };
            const dust = Math.round((raw - amount) * 1e8) / 1e8;
            // Only succeeds if the rewards balance is still EXACTLY what we read => a second tap/worker cannot move it twice
            const r = await this.User.updateOne(
                { userId, cashbackBalance: raw },
                { $inc: { balance: amount, cashbackTransferred: amount }, $set: { cashbackBalance: dust } }
            );
            if (!r.matchedCount) continue;
            try {
                await this.Transaction.create({
                    txId: `CBT_${userId}_${this.now().getTime()}_${Math.random().toString(36).slice(2, 7)}`, userId, type: 'CASHBACK_TRANSFER',
                    amount, currency: 'USD', status: 'COMPLETED', metadata: { from: 'REWARDS', to: 'MAIN' }, createdAt: this.now()
                });
            } catch (e) { logger.warn('Cashback transfer ledger write failed (funds already moved)', { userId, error: e.message }); }
            logger.info('Cashback transferred to main wallet', { userId, amount });
            const s = await this.summary(userId);
            return { ok: true, amount, mainBalance: s.mainBalance, remaining: s.balance };
        }
        return { ok: false, reason: 'BUSY' };
    }
}

let singleton = null;
/** Lazy singleton bound to the real models (kept out of module scope so tests can inject fakes). */
export async function getCashbackService() {
    if (!singleton) { const { User, Transaction } = await import('../../models/index.js'); singleton = new CashbackService({ User, Transaction }); }
    return singleton;
}
export default CashbackService;
