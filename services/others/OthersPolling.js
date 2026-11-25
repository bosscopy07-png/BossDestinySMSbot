// services/others/OthersPolling.js — DB-driven poller (restart-safe: no in-memory timers per activation)
import logger from '../../utils/logger.js';
import { OTHERS_DEFAULTS as D } from './constants.js';

export class OthersPolling {
    constructor({ manager, store, intervalMs = D.pollIntervalMs, now = () => new Date() }) {
        this.manager = manager; this.store = store; this.intervalMs = intervalMs; this.now = now;
        this.timer = null; this.running = false; this.ticks = 0;
    }
    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick().catch(e => logger.error('OTHERS poll tick failed', { error: e.message })), this.intervalMs);
        this.timer.unref?.();
        logger.info('OTHERS polling started', { intervalMs: this.intervalMs });
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    async tick() {
        if (this.running) return { skipped: true };
        this.running = true;
        try {
            const due = await this.store.claimForPoll(this.now(), D.pollLockMs, 25);
            const results = await Promise.allSettled(due.map(a => this.manager.pollOne(a)));
            results.forEach((r, i) => { if (r.status === 'rejected') logger.error('OTHERS pollOne failed', { activationId: due[i].activationId, error: r.reason?.message }); });
            if (++this.ticks % 12 === 0) await this.manager.reconcile().catch(e => logger.error('OTHERS reconcile failed', { error: e.message }));
            return { polled: due.length };
        } finally { this.running = false; }
    }
}
export default OthersPolling;
