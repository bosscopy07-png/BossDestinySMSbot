// bot/commands/adminTools.js — 🔎 Admin Investigation panel. 100% BUTTON-driven (no slash commands).
// Entry: "🔎 Investigation" button on the Admin Dashboard. Free-text inputs (user id, amount, reason) are
// collected through ctx.session.atAwait and routed here by handleTextInput() from the bot's text handler.
// Every action re-checks admin authorisation. Mutations (credit / restrict / unrestrict) are audited.
import logger from '../../utils/logger.js';
import { escapeHtml as h } from '../../services/others/constants.js';
import { show, safeAnswer } from './_show.js';

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const dt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');
const b = (text, data) => ({ text, callback_data: data });
const N = 12;

export default class AdminTools {
    constructor(bot, { isAdmin, models, walletService }) { Object.assign(this, { bot, isAdmin, m: models, walletService }); }

    register() {
        const guard = (fn) => async (ctx) => {
            if (!ctx.from || !this.isAdmin(ctx.from.id)) return safeAnswer(ctx, 'Not allowed');
            await safeAnswer(ctx);
            try { await fn.call(this, ctx); }
            catch (e) { logger.error('Admin tool failed', { error: e.message }); await show(ctx, this._wrap(`⚠️ ${h(e.message)}`)); }
        };
        const a = (pattern, fn) => this.bot.action(pattern, guard(fn));
        a('at_menu', this.menu);
        a('at_cancel', async (ctx) => { delete ctx.session?.atAwait; return this.menu(ctx); });
        a(/^at_in:(user|find|credit|restrict|unrestrict)$/, (ctx) => this.startInput(ctx, ctx.match[1]));
        a('at_credits', (ctx) => this.report(ctx, 'at_credits', () => this.creditsReport()));
        a('at_refunds', (ctx) => this.report(ctx, 'at_refunds', () => this.refundsReport()));
        a('at_unres', (ctx) => this.report(ctx, 'at_unres', () => this.unresolvedReport()));
        a('at_failed', (ctx) => this.report(ctx, 'at_failed', () => this.failedReport()));
        a('at_others', (ctx) => this.report(ctx, 'at_others', () => this.othersReport()));
        a('at_rebuys', (ctx) => this.report(ctx, 'at_rebuys', () => this.rebuysReport()));
        a('at_prov', (ctx) => this.report(ctx, 'at_prov', () => this.providersReport()));
        a(/^at_cr:(\d{3,20})$/, (ctx) => this.startInput(ctx, 'credit', { userId: ctx.match[1] }));
        a(/^at_rs:(\d{3,20})$/, (ctx) => this.startInput(ctx, 'restrict', { userId: ctx.match[1] }));
        a(/^at_un:(\d{3,20})$/, (ctx) => this.startInput(ctx, 'unrestrict', { userId: ctx.match[1] }));
        a(/^at_dur:(1|24|168|perm)$/, this.pickDuration);
        a('at_reason_default', async (ctx) => this.onText(ctx, 'Admin review', true));
        a('at_confirm', this.confirm);
        logger.info('Admin investigation panel registered (buttons only)');
    }

    _wrap(text, rows = []) { return { text, reply_markup: { inline_keyboard: [...rows, [b('◀️ Tools', 'at_menu'), b('🏠 Admin', 'admin')]] } }; }

    async menu(ctx) {
        await show(ctx, {
            text: '🔎 <b>Admin Investigation</b>\n\nLookup users, trace payments/activations, review refunds and manual credits.',
            reply_markup: { inline_keyboard: [
                [b('👤 User Lookup', 'at_in:user'), b('🔎 Find Record', 'at_in:find')],
                [b('🛠 Manual Credits', 'at_credits'), b('💸 Refunds', 'at_refunds')],
                [b('⚠️ Unresolved', 'at_unres'), b('❌ Failed', 'at_failed')],
                [b('📱 OTHERS', 'at_others'), b('🔄 Buy Again', 'at_rebuys')],
                [b('📊 Providers', 'at_prov')],
                [b('💰 Credit User', 'at_in:credit'), b('🚫 Restrict', 'at_in:restrict')],
                [b('✅ Unrestrict', 'at_in:unrestrict')],
                [b('◀️ Admin Dashboard', 'admin')]
            ] }
        });
    }

    async report(ctx, refreshData, build) {
        const lines = await build();
        let text = lines.join('\n'); if (text.length > 3900) text = text.slice(0, 3850) + '\n…(truncated)';
        await show(ctx, this._wrap(text, [[b('🔄 Refresh', refreshData)]]));
    }

    // ───────────── guided text input ─────────────
    async startInput(ctx, kind, preset = {}) {
        ctx.session = ctx.session || {};
        const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        ctx.session.atAwait = { kind, step: 0, data: { ...preset }, nonce };
        const aw = ctx.session.atAwait;
        if (preset.userId) { // coming from a user card
            if (kind === 'credit') aw.step = 1;
            else if (kind === 'restrict') return this.askDuration(ctx);
            else if (kind === 'unrestrict') aw.step = 1;
        }
        return this.prompt(ctx);
    }

    async prompt(ctx) {
        const aw = ctx.session.atAwait; const cancel = [[b('✖️ Cancel', 'at_cancel')]];
        const ask = {
            user: ['Send the <b>user ID or @username</b>'],
            find: ['Send a <b>phone number, activation/session ID, transaction ID or payment reference</b>'],
            credit: ['Send the <b>user ID</b> to credit', 'Send the <b>amount in USD</b> (e.g. 2.50)', 'Send the <b>reason</b> for this credit (required, recorded in the audit log)'],
            restrict: ['Send the <b>user ID</b> to restrict', null, 'Send the <b>reason</b> for the restriction (required)'],
            unrestrict: ['Send the <b>user ID</b> to restore', 'Send the <b>reason</b> for restoring (or tap the button)']
        }[aw.kind][aw.step];
        const rows = aw.kind === 'unrestrict' && aw.step === 1 ? [[b('Admin review', 'at_reason_default')], ...cancel] : cancel;
        await show(ctx, { text: `✍️ ${ask}`, reply_markup: { inline_keyboard: rows } });
    }

    async askDuration(ctx) {
        ctx.session.atAwait.step = 1;
        await show(ctx, { text: '⏱ <b>Restriction length?</b> (temporary restrictions expire automatically)',
            reply_markup: { inline_keyboard: [[b('1 hour', 'at_dur:1'), b('24 hours', 'at_dur:24')], [b('7 days', 'at_dur:168'), b('Permanent', 'at_dur:perm')], [b('✖️ Cancel', 'at_cancel')]] } });
    }

    async pickDuration(ctx) {
        const aw = ctx.session?.atAwait; if (!aw || aw.kind !== 'restrict') return this.menu(ctx);
        aw.data.hours = ctx.match[1] === 'perm' ? null : Number(ctx.match[1]); aw.step = 2;
        return this.prompt(ctx);
    }

    /** Called from bot/index.js text handler for admins. Returns true when the message was consumed. */
    async handleTextInput(ctx) {
        const aw = ctx.session?.atAwait;
        if (!aw || !ctx.from || !this.isAdmin(ctx.from.id)) return false;
        const text = (ctx.message?.text || '').trim();
        if (!text) return true;
        try { await this.onText(ctx, text); }
        catch (e) { logger.error('Admin tool input failed', { error: e.message }); await show(ctx, this._wrap(`⚠️ ${h(e.message)}`)); delete ctx.session.atAwait; }
        return true;
    }

    async onText(ctx, text, fromButton = false) {
        const aw = ctx.session?.atAwait; if (!aw) return this.menu(ctx);
        const { kind, step, data } = aw;

        if (kind === 'user') { delete ctx.session.atAwait; return this.userCard(ctx, text); }
        if (kind === 'find') { delete ctx.session.atAwait; const lines = await this.findReport(text); return show(ctx, this._wrap(lines.join('\n').slice(0, 3900))); }

        if (step === 0) { // user id
            const u = await this._findUser(text);
            if (!u) return show(ctx, { text: '❌ User not found. Send another ID/@username.', reply_markup: { inline_keyboard: [[b('✖️ Cancel', 'at_cancel')]] } });
            data.userId = u.userId;
            if (kind === 'restrict') return this.askDuration(ctx);
            aw.step = 1; return this.prompt(ctx);
        }
        if (kind === 'credit' && step === 1) {
            const amt = parseFloat(text.replace('$', ''));
            if (!(amt > 0) || amt > 10000) return show(ctx, { text: '❌ Enter a valid amount between 0.01 and 10000.', reply_markup: { inline_keyboard: [[b('✖️ Cancel', 'at_cancel')]] } });
            data.amount = Math.round(amt * 100) / 100; aw.step = 2; return this.prompt(ctx);
        }
        if ((kind === 'credit' && step === 2) || (kind === 'restrict' && step === 2) || (kind === 'unrestrict' && step === 1)) {
            if (text.length < 3) return show(ctx, { text: '❌ Please give a meaningful reason.', reply_markup: { inline_keyboard: [[b('✖️ Cancel', 'at_cancel')]] } });
            data.reason = text.slice(0, 300); aw.step = 99;
            const summary = {
                credit: `💰 <b>Credit ${usd(data.amount)}</b> to <code>${data.userId}</code>\nReason: ${h(data.reason)}`,
                restrict: `🚫 <b>Restrict</b> <code>${data.userId}</code> ${data.hours ? `for ${data.hours}h` : 'permanently'}\nReason: ${h(data.reason)}\nBalance is not affected.`,
                unrestrict: `✅ <b>Restore</b> <code>${data.userId}</code>\nReason: ${h(data.reason)}`
            }[kind];
            return show(ctx, { text: `${summary}\n\nConfirm?`, reply_markup: { inline_keyboard: [[b('✅ Confirm', 'at_confirm')], [b('✖️ Cancel', 'at_cancel')]] } });
        }
    }

    async confirm(ctx) {
        const aw = ctx.session?.atAwait; if (!aw || aw.step !== 99) return this.menu(ctx);
        delete ctx.session.atAwait; // consumed: a second tap on the same button does nothing
        const adminId = String(ctx.from.id); const { kind, data, nonce } = aw;
        if (kind === 'credit') {
            const txId = await this.walletService.addBalance(data.userId, data.amount, adminId, data.reason, { idempotencyKey: `${adminId}_${data.userId}_${nonce}` });
            return show(ctx, this._wrap(`✅ Credited ${usd(data.amount)} to <code>${data.userId}</code>\nTx: <code>${h(txId)}</code>\nReason: ${h(data.reason)}`));
        }
        if (kind === 'restrict') {
            const hours = data.hours;
            await this.m.User.updateOne({ userId: data.userId }, {
                $set: { isBlacklisted: true, blacklistReason: data.reason, blacklistDate: new Date(), blacklistedBy: adminId, blacklistSource: 'ADMIN', blacklistExpiresAt: hours ? new Date(Date.now() + hours * 3600e3) : null },
                $push: { restrictionHistory: { action: hours ? 'TEMP_RESTRICT' : 'RESTRICT', reason: data.reason, by: adminId, source: 'ADMIN', at: new Date() } }
            });
            await this.m.AdminLog.create({ adminId, action: 'RESTRICT', targetUserId: data.userId, details: { reason: data.reason, hours } }).catch(() => {});
            return show(ctx, this._wrap(`🚫 <code>${data.userId}</code> restricted ${hours ? `for ${hours}h` : 'permanently'}. Reason recorded.`));
        }
        if (kind === 'unrestrict') {
            await this.m.User.updateOne({ userId: data.userId }, {
                $set: { isBlacklisted: false, blacklistReason: null, blacklistDate: null, blacklistExpiresAt: null, blacklistSource: null },
                $push: { restrictionHistory: { action: 'UNRESTRICT', reason: data.reason, by: adminId, source: 'ADMIN', at: new Date() } }
            });
            await this.m.AdminLog.create({ adminId, action: 'UNRESTRICT', targetUserId: data.userId, details: { reason: data.reason } }).catch(() => {});
            return show(ctx, this._wrap(`✅ <code>${data.userId}</code> restored.`));
        }
    }

    // ───────────── reports (read-only) ─────────────
    async _findUser(q) {
        q = String(q || '').trim(); if (!q) return null;
        return this.m.User.findOne(/^\d+$/.test(q) ? { userId: q } : { username: q.replace(/^@/, '') }).select('+restrictionHistory').lean();
    }

    async userCard(ctx, q) {
        const { Session, Transaction, OthersActivation } = this.m;
        const u = await this._findUser(q);
        if (!u) return show(ctx, this._wrap('❌ User not found.'));
        const [sc, oc, txs, others] = await Promise.all([
            Session.countDocuments({ userId: u.userId }), OthersActivation.countDocuments({ userId: u.userId }),
            Transaction.find({ userId: u.userId }).sort({ createdAt: -1 }).limit(6).lean(),
            OthersActivation.find({ userId: u.userId }).sort({ createdAt: -1 }).limit(3).lean()
        ]);
        const hist = (u.restrictionHistory || []).slice(-5);
        const text = [
            `👤 <b>${h(u.firstName || '')}</b> @${h(u.username || '-')} <code>${u.userId}</code>`,
            `💰 Balance ${usd(u.balance)} · 🔒 Locked ${usd(u.lockedBalance)} · Deposited ${usd(u.totalDeposited)} · Spent ${usd(u.totalSpent)}`,
            `📅 Joined ${dt(u.createdAt)} · Active ${dt(u.lastActive)} · Bot blocked: ${u.blockedBot ? 'yes' : 'no'}`,
            `🚦 Restricted: <b>${u.isBlacklisted ? 'YES' : 'no'}</b>` + (u.isBlacklisted ? `\n   Reason: ${h(u.blacklistReason || 'N/A')}\n   By: ${h(u.blacklistedBy || 'unknown')} (${h(u.blacklistSource || '?')}) since ${dt(u.blacklistDate)}\n   Expires: ${u.blacklistExpiresAt ? dt(u.blacklistExpiresAt) : 'never'}` : ''),
            hist.length ? `📜 History:\n` + hist.map(x => `   ${dt(x.at)} ${h(x.action)} by ${h(x.by)} — ${h(x.reason || '')}`).join('\n') : '',
            `📦 Sessions: ${sc} · OTHERS: ${oc}`,
            `🧾 Recent transactions:\n` + (txs.map(t => `   <code>${h(t.txId)}</code> ${h(t.type)} ${usd(t.amount)} ${h(t.status)} ${dt(t.createdAt)}`).join('\n') || '   —'),
            others.length ? `📱 Recent OTHERS:\n` + others.map(o => `   <code>${o.activationId.slice(0, 8)}</code> ${h(o.country)} ${h(o.status)} ${usd(o.priceUsd)}${o.failureReason ? ' · ' + h(o.failureReason) : ''}`).join('\n') : ''
        ].filter(Boolean).join('\n');
        await show(ctx, this._wrap(text.slice(0, 3900), [[b('💰 Credit', `at_cr:${u.userId}`), u.isBlacklisted ? b('✅ Unrestrict', `at_un:${u.userId}`) : b('🚫 Restrict', `at_rs:${u.userId}`)]]));
    }

    async findReport(q) {
        q = String(q || '').trim(); if (!q) return ['Nothing to search.'];
        const { Session, Transaction, Payment, OthersActivation } = this.m; const phone = q.startsWith('+') ? q : `+${q}`;
        const [s, o, t, p] = await Promise.all([
            Session.find({ $or: [{ sessionId: q }, { number: q }, { number: phone }, { providerNumberId: q }] }).limit(5).lean(),
            OthersActivation.find({ $or: [{ activationId: q }, { phone: q }, { phone }, { providerId: q }] }).limit(5).lean(),
            Transaction.find({ $or: [{ txId: q }, { 'metadata.paymentReference': q }] }).limit(5).lean(),
            Payment.find({ $or: [{ reference: q }, { providerTransactionId: q }] }).limit(5).lean()
        ]);
        const out = [`🔎 <b>Results for</b> <code>${h(q)}</code>`];
        s.forEach(x => out.push(`📨 Session <code>${x.sessionId}</code> u:${x.userId} ${h(x.service)}/${h(x.country)} ${h(x.status)} ${usd(x.cost)} prov:${h(x.provider)} id:${h(x.providerNumberId || '-')} ${dt(x.startTime)}`));
        o.forEach(x => out.push(`📱 OTHERS <code>${x.activationId}</code> u:${x.userId} ${h(x.country)} ${h(x.status)} ${usd(x.priceUsd)} ${h(x.phone || '')} prov:${h(x.providerId || '-')} refund:${h(x.refund?.status || '-')} capture:${h(x.capture?.status || '-')}${x.failureReason ? ' reason:' + h(x.failureReason) : ''}`));
        t.forEach(x => out.push(`🧾 Tx <code>${h(x.txId)}</code> u:${x.userId} ${h(x.type)} ${usd(x.amount)} ${h(x.status)} by:${h(x.processedBy || '-')} ${dt(x.createdAt)}`));
        p.forEach(x => out.push(`💳 Payment <code>${h(x.reference)}</code> u:${x.userId} ${h(x.status)} ₦${x.amountNaira} → ${usd(x.amountUsd)} ${dt(x.createdAt)}`));
        return out.length > 1 ? out : [...out, 'Nothing found.'];
    }

    async creditsReport() {
        const rows = await this.m.Transaction.find({ $or: [{ type: 'ADMIN_ADD' }, { 'metadata.manualCredit': true }] }).sort({ createdAt: -1 }).limit(N).lean();
        return [`🛠 <b>Manual credits (last ${rows.length})</b>`, ...rows.map(t => `<code>${h(t.txId)}</code> u:${t.userId} ${usd(t.amount)} ${h(t.status)} admin:${h(t.processedBy || t.confirmedBy || t.metadata?.manualCreditBy || '?')} ${dt(t.createdAt)}\n   ↳ ${h(t.metadata?.reason || t.metadata?.source || '')}`)];
    }

    async refundsReport() {
        const [o, t] = await Promise.all([
            this.m.OthersActivation.find({ 'refund.status': { $ne: null } }).sort({ updatedAt: -1 }).limit(N).lean(),
            this.m.Transaction.find({ type: 'REFUND' }).sort({ createdAt: -1 }).limit(N).lean()
        ]);
        return [`💸 <b>Refunds</b>`, ...o.map(x => `OTHERS <code>${x.activationId.slice(0, 8)}</code> u:${x.userId} ${usd(x.refund.amount ?? x.priceUsd)} ${h(x.refund.status)} ${h(x.refund.reason || '')} ${h(x.refund.error || '')}`),
            ...t.map(x => `Tx <code>${h(x.txId)}</code> u:${x.userId} ${usd(x.amount)} ${h(x.status)} ${dt(x.createdAt)}`)];
    }

    async unresolvedReport() {
        const old = new Date(Date.now() - 10 * 60000); const { Payment, Transaction, OthersActivation } = this.m;
        const [p, d, cap, ref, amb, stuck] = await Promise.all([
            Payment.find({ status: { $in: ['PENDING', 'PROCESSING'] }, createdAt: { $lt: old } }).sort({ createdAt: 1 }).limit(10).lean(),
            Transaction.find({ status: { $in: ['PENDING', 'CONFIRMING'] }, type: { $in: ['DEPOSIT', 'DEPOSIT_CONFIRMING', 'NAIRA_DEPOSIT'] }, createdAt: { $lt: old } }).limit(10).lean(),
            OthersActivation.find({ status: 'RECEIVED', 'capture.status': { $ne: 'DONE' } }).limit(8).lean(),
            OthersActivation.find({ status: { $in: ['EXPIRED', 'CANCELLED', 'FAILED'] }, lockTxId: { $ne: null }, 'refund.status': { $ne: 'DONE' } }).limit(8).lean(),
            OthersActivation.find({ ambiguous: true }).sort({ createdAt: -1 }).limit(8).lean(),
            OthersActivation.countDocuments({ status: 'PURCHASING', createdAt: { $lt: old } })
        ]);
        return [`⚠️ <b>Unresolved</b> (auto-reconciliation retries every minute)`,
            `\n💳 Payments pending >10min: ${p.length}`, ...p.map(x => `  <code>${h(x.reference)}</code> u:${x.userId} ${h(x.status)} ₦${x.amountNaira} ${dt(x.createdAt)}${x.metadata?.processError ? ' err:' + h(x.metadata.processError) : ''}`),
            `\n🪙 Crypto deposits pending: ${d.length}`, ...d.map(x => `  <code>${h(x.txId)}</code> u:${x.userId} ${usd(x.amount)} ${h(x.status)}`),
            `\n📱 OTHERS capture incomplete: ${cap.length}`, ...cap.map(x => `  <code>${x.activationId.slice(0, 8)}</code> ${h(x.capture?.error || '')}`),
            `\n📱 OTHERS refund incomplete: ${ref.length}`, ...ref.map(x => `  <code>${x.activationId.slice(0, 8)}</code> ${h(x.refund?.error || x.refund?.status || 'pending')}`),
            `\n📱 Ambiguous provider timeouts (check 5sim dashboard): ${amb.length}`, ...amb.map(x => `  <code>${x.activationId.slice(0, 8)}</code> u:${x.userId} ${h(x.failureReason || '')} ${dt(x.createdAt)}`),
            `\n📱 Stuck purchasing: ${stuck}`];
    }

    async failedReport() {
        const [s, o] = await Promise.all([
            this.m.Session.find({ status: { $in: ['FAILED', 'TIMEOUT'] } }).sort({ startTime: -1 }).limit(N).lean(),
            this.m.OthersActivation.find({ status: { $in: ['FAILED', 'EXPIRED'] } }).sort({ createdAt: -1 }).limit(N).lean()
        ]);
        return [`❌ <b>Failed / expired</b>`, ...s.map(x => `📨 <code>${x.sessionId}</code> u:${x.userId} ${h(x.service)}/${h(x.country)} ${h(x.status)} ${h(x.provider)} ${dt(x.startTime)}`),
            ...o.map(x => `📱 <code>${x.activationId.slice(0, 8)}</code> u:${x.userId} ${h(x.country)} ${h(x.status)} ${h(x.failureReason || '')} ${dt(x.createdAt)}`)];
    }

    async othersReport() {
        const rows = await this.m.OthersActivation.find({}).sort({ createdAt: -1 }).limit(N).lean();
        return [`📱 <b>OTHERS purchases</b>`, ...rows.map(x => `<code>${x.activationId.slice(0, 8)}</code> u:${x.userId} ${h(x.country)} ${usd(x.priceUsd)} (cost ${usd(x.providerCost)}) ${h(x.status)} ${x.rebuyOf ? '🔄' : ''} ${dt(x.createdAt)}`)];
    }

    async rebuysReport() {
        const [o, s] = await Promise.all([
            this.m.OthersActivation.find({ rebuyOf: { $ne: null } }).sort({ createdAt: -1 }).limit(N).lean(),
            this.m.Session.find({ rebuyOf: { $ne: null } }).sort({ startTime: -1 }).limit(N).lean()
        ]);
        return [`🔄 <b>Buy Again purchases</b>`, ...o.map(x => `📱 <code>${x.activationId.slice(0, 8)}</code> ← <code>${String(x.rebuyOf).slice(0, 8)}</code> u:${x.userId} ${h(x.status)} ${usd(x.priceUsd)}`),
            ...s.map(x => `📨 <code>${x.sessionId}</code> ← <code>${h(x.rebuyOf)}</code> u:${x.userId} ${h(x.service)} ${h(x.status)} ${usd(x.cost)}`)];
    }

    async providersReport() {
        const since = new Date(Date.now() - 24 * 3600e3); const { Session, OthersActivation } = this.m;
        const [sp, op] = await Promise.all([
            Session.aggregate([{ $match: { startTime: { $gte: since } } }, { $group: { _id: { p: '$provider', s: '$status' }, n: { $sum: 1 } } }]),
            OthersActivation.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { s: '$status', r: '$failureReason' }, n: { $sum: 1 } } }])
        ]);
        const by = {}; sp.forEach(x => { const p = x._id.p || '?'; by[p] = by[p] || {}; by[p][x._id.s] = x.n; });
        const out = [`📊 <b>Provider performance (24h)</b>`];
        for (const [p, st] of Object.entries(by)) { const tot = Object.values(st).reduce((a, c) => a + c, 0), ok = st.RECEIVED || 0; out.push(`${h(p)}: ${ok}/${tot} OTP (${tot ? Math.round(100 * ok / tot) : 0}%) · ` + Object.entries(st).map(([k, v]) => `${k}:${v}`).join(' ')); }
        const ot = op.reduce((a, x) => a + x.n, 0), okO = op.filter(x => x._id.s === 'RECEIVED').reduce((a, x) => a + x.n, 0);
        out.push(`5SIM OTHERS: ${okO}/${ot} OTP · ` + op.map(x => `${x._id.s}${x._id.r ? '(' + h(x._id.r) + ')' : ''}:${x.n}`).join(' '));
        return out;
    }
              }
