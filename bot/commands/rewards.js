// bot/commands/rewards.js — 🎁 Rewards wallet: view + "Transfer to Main Wallet" (button only, no slash commands)
import logger from '../../utils/logger.js';
import { show, safeAnswer } from './_show.js';
import { rewardsWalletView, transferResultView } from './rewardsView.js';

export default class RewardsCommands {
    constructor(bot, { cashback }) { Object.assign(this, { bot, cashback }); this.inflight = new Set(); }
    register() {
        this.bot.action('rewards_wallet', (ctx) => this.open(ctx));
        this.bot.action('rewards_transfer', (ctx) => this.transfer(ctx));
        logger.info('Rewards wallet commands registered');
    }
    uid(ctx) { return ctx.from?.id ? String(ctx.from.id) : null; }
    async open(ctx) {
        await safeAnswer(ctx); const u = this.uid(ctx); if (!u) return;
        await show(ctx, rewardsWalletView(await this.cashback.summary(u)));
    }
    async transfer(ctx) {
        const u = this.uid(ctx); if (!u) return;
        if (this.inflight.has(u)) return safeAnswer(ctx, 'Please wait…');
        this.inflight.add(u);
        try {
            await safeAnswer(ctx, 'Transferring…');
            const r = await this.cashback.transfer(u);
            await show(ctx, transferResultView(r, await this.cashback.summary(u)));
        } catch (e) { logger.error('Rewards transfer failed', { userId: u, error: e.message }); await show(ctx, transferResultView({ ok: false, reason: 'ERROR' }, await this.cashback.summary(u).catch(() => ({ balance: 0, earned: 0, transferred: 0, mainBalance: 0 })))); }
        finally { this.inflight.delete(u); }
    }
}
