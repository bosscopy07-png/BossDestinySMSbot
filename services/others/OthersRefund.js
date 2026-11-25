// services/others/OthersRefund.js — idempotent refund handling for OTHERS.
// Funds are LOCKED at purchase and only CAPTURED when an SMS arrives, so a refund = releasing the lock.
// A refund is claimed atomically (store.claimRefund) so it can never run twice for one activation.
import logger from '../../utils/logger.js';

export class OthersRefund {
    constructor({ store, wallet, now = () => new Date() }) { this.store = store; this.wallet = wallet; this.now = now; }

    async refund(activation, reason) {
        if (!activation?.lockTxId) return { refunded: false, reason: 'NO_LOCK' };
        if (activation.status === 'RECEIVED' || activation.capture?.status === 'DONE') return { refunded: false, reason: 'ALREADY_CAPTURED' };

        const stale = new Date(this.now().getTime() - 2 * 60 * 1000);
        const claimed = await this.store.claimRefund(activation.activationId, stale);
        if (!claimed) return { refunded: false, duplicate: true };

        try {
            const r = await this.wallet.releaseFunds(activation.lockTxId, activation.userId, reason);
            // `success:false + alreadyReleased` means a previous attempt already released it: treat as done, never release twice
            const ok = r?.success || r?.alreadyReleased;
            if (!ok && r?.error === 'TRANSACTION_NOT_PENDING') throw new Error(`LOCK_NOT_PENDING:${r.currentStatus}`);
            await this.store.update(activation.activationId, {
                'refund.status': 'DONE', 'refund.at': this.now(), 'refund.amount': activation.priceUsd,
                'refund.reason': reason, 'refund.txId': activation.lockTxId, 'refund.error': null
            });
            logger.info('OTHERS refund done', { activationId: activation.activationId, userId: activation.userId, amount: activation.priceUsd, reason });
            return { refunded: true, amount: activation.priceUsd };
        } catch (e) {
            await this.store.update(activation.activationId, { 'refund.status': 'FAILED', 'refund.error': e.message });
            logger.error('OTHERS refund failed (will be retried by reconciliation)', { activationId: activation.activationId, error: e.message });
            return { refunded: false, error: e.message };
        }
    }
}
export default OthersRefund;
      
