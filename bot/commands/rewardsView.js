// bot/commands/rewardsView.js — pure view builders for the 🎁 Rewards wallet (cashback)
import { fmt4, CASHBACK_RATE } from '../../services/rewards/cashbackMath.js';
const btn = (text, data) => ({ text, callback_data: data });
const usd2 = (n) => `$${Number(n || 0).toFixed(2)}`;

export function rewardsWalletView(s, { notice = null } = {}) {
    const pct = `${Math.round(CASHBACK_RATE * 10000) / 100}%`;
    const text = (notice ? `${notice}\n\n` : '') +
        `🎁 <b>Rewards Wallet</b>\n\n` +
        `💰 Available rewards: <b>${fmt4(s.balance)}</b>\n` +
        `📈 Total earned: ${fmt4(s.earned)}\n` +
        `🔁 Moved to main wallet: ${fmt4(s.transferred)}\n` +
        `👛 Main wallet: ${usd2(s.mainBalance)}\n\n` +
        `You earn <b>${pct} cashback</b> on every purchase. Rewards stay here until you move them to your main wallet.`;
    const rows = [];
    if (s.balance > 0) rows.push([btn(`💸 Transfer ${fmt4(s.balance)} to Main Wallet`, 'rewards_transfer')]);
    rows.push([btn('👥 Referral Link', 'referral'), btn('🏠 Menu', 'menu')]);
    return { text, reply_markup: { inline_keyboard: rows } };
}

export function transferResultView(r, summary) {
    if (r.ok) return rewardsWalletView(summary, { notice: `✅ <b>${fmt4(r.amount)}</b> moved to your main wallet.\nMain balance: <b>${usd2(r.mainBalance)}</b>` });
    const msg = r.reason === 'EMPTY' ? 'ℹ️ Your rewards wallet is empty — nothing to transfer yet.' : '⚠️ Could not complete the transfer right now. Please try again.';
    return rewardsWalletView(summary, { notice: msg });
}
