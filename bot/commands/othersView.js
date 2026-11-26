// bot/commands/othersView.js — pure view builders (text + inline keyboard) for OTHERS / Buy Again / My Orders.
// No I/O so every screen can be unit-tested. Callback data is validated to fit Telegram's 64-byte limit.
import { escapeHtml as h } from '../../services/others/constants.js';

export const cb = (data) => (Buffer.byteLength(data) <= 64 ? data : null);
const btn = (text, data) => { const d = cb(data); return d ? { text, callback_data: d } : null; };
const rows = (...rs) => rs.map(r => r.filter(Boolean)).filter(r => r.length);
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const flag = (iso) => (iso && /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map(c => 0x1F1A5 + c.charCodeAt(0))) : '🌍');
const NAV = [btn('📦 My Orders', 'my_orders'), btn('🏠 Menu', 'menu')];

export function minutesLeft(expiresAt, now = new Date()) {
    if (!expiresAt) return null;
    return Math.max(0, Math.ceil((new Date(expiresAt) - now) / 60000));
}

export function countriesView(list, page = 0, pageSize = 8) {
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    page = Math.min(Math.max(0, page), pages - 1);
    const slice = list.slice(page * pageSize, page * pageSize + pageSize);
    const text = `📱 <b>OTHERS — Number for any website or app</b>\n\n` +
        `Need a number for a site that isn't in our service list? Pick a country, get a number, enter it on your site and your code appears here.\n\n` +
        `<i>Prices and stock are live. Page ${page + 1}/${pages}</i>`;
    const kb = [];
    for (let i = 0; i < slice.length; i += 2) kb.push(slice.slice(i, i + 2).map(c => btn(`${flag(c.iso)} ${c.name} · ${usd(c.price)}`, `oc:${c.slug}`)));
    const nav = [];
    if (page > 0) nav.push(btn('◀️ Prev', `ocp:${page - 1}`));
    if (page < pages - 1) nav.push(btn('Next ▶️', `ocp:${page + 1}`));
    return { text, reply_markup: { inline_keyboard: rows(...kb, nav, NAV) }, page };
}

export function offersView(countryName, slug, offers, iso = null) {
    if (!offers.length) return { text: `${flag(iso)} <b>${h(countryName)}</b>\n\n😕 No numbers in stock right now. Please try again shortly.`, reply_markup: { inline_keyboard: rows([btn('◀️ Countries', 'ocp:0')], NAV) } };
    const shown = offers.slice(0, 8);
    const text = `${flag(iso)} <b>${h(countryName)}</b> — available options\n\n` +
        shown.map((o, i) => `${i + 1}. <b>${usd(o.price)}</b> · ${o.stock} in stock`).join('\n') +
        `\n\nChoose an option. You are only charged if a number is allocated.`;
    const kb = shown.map((o, i) => [btn(`Option ${i + 1} — ${usd(o.price)}`, `oo:${slug}:${o.operator}:${Math.round(o.price * 100)}`)]);
    return { text, reply_markup: { inline_keyboard: rows(...kb, [btn('◀️ Countries', 'ocp:0')], NAV) } };
}

export function confirmView({ countryName, price, balance, slug, operator, iso = null }) {
    const enough = balance == null || balance + 1e-9 >= price;
    const text = `🧾 <b>Confirm purchase</b>\n\n${flag(iso)} Country: <b>${h(countryName)}</b>\n💵 Total: <b>${usd(price)}</b>\n` +
        (balance != null ? `💰 Your balance: ${usd(balance)}\n` : '') +
        (enough ? `\nThe amount is reserved now and only charged when your code arrives. If no SMS arrives, it is released automatically.` :
            `\n⚠️ You need <b>${usd(price - balance)}</b> more to buy this number.`);
    const kb = enough
        ? [[btn(`✅ Confirm — ${usd(price)}`, `ob:${slug}:${operator}:${Math.round(price * 100)}`)], [btn('◀️ Back', `oc:${slug}`)]]
        : [[btn('💳 Deposit', 'deposit')], [btn('◀️ Back', `oc:${slug}`)]];
    return { text, reply_markup: { inline_keyboard: rows(...kb) } };
}

export function activationView(a, { canRebuy = false, refund = null, now = new Date() } = {}) {
    const num = a.phone ? `<code>${h(a.phone)}</code>` : '—';
    const head = `📱 <b>OTHERS</b> · ${h(a.countryName || a.country)}\n📞 Number: ${num}\n💵 Price: ${usd(a.priceUsd)}\n`;
    const copyNum = a.phone ? { text: '📋 Copy Number', copy_text: { text: a.phone } } : null;

    if (a.status === 'ACTIVE' || a.status === 'PURCHASING') {
        const left = minutesLeft(a.expiresAt, now);
        const text = head + `📡 Status: <b>⏳ Waiting for SMS</b>\n` + (left != null ? `⏱ Expires in about <b>${left} min</b>\n` : '') +
            `\nEnter this number on your website/app and request the code. It will appear here automatically.`;
        return { text, reply_markup: { inline_keyboard: rows([copyNum], [btn('🔄 Check Now', `or:${a.activationId}`), btn('❌ Cancel', `ox:${a.activationId}`)], [NAV[0]]) } };
    }
    if (a.status === 'RECEIVED') {
        const last = a.messages?.[a.messages.length - 1];
        const text = head + `📡 Status: <b>✅ Code received</b>\n\n` +
            (a.otpCode ? `🔑 Code: <code>${h(a.otpCode)}</code>\n` : `🔑 Couldn't detect a code automatically — see the message below.\n`) +
            (last?.text ? `\n💬 Message${last.sender ? ` from ${h(last.sender)}` : ''}:\n<pre>${h(last.text)}</pre>` : '');
        const copyCode = a.otpCode ? { text: '📋 Copy Code', copy_text: { text: a.otpCode } } : null;
        return { text, reply_markup: { inline_keyboard: rows([copyCode, copyNum], [NAV[0], NAV[1]]) } };
    }
    const label = { EXPIRED: '⌛ Expired (no SMS)', CANCELLED: '🚫 Cancelled', FAILED: '❌ Failed' }[a.status] || a.status;
    const refunded = a.refund?.status === 'DONE' || refund?.refunded;
    const text = head + `📡 Status: <b>${label}</b>\n` +
        (refunded ? `💸 Refund: <b>${usd(a.priceUsd)} released back to your balance</b>\n` : a.lockTxId ? `💸 Refund: processing…\n` : `💸 You were not charged.\n`) +
        (canRebuy ? `\nTap <b>Buy Again</b> to get a fresh number — you won't need to choose the country again.` : '');
    return { text, reply_markup: { inline_keyboard: rows([canRebuy ? btn('🔄 Buy Again', `oba:${a.activationId}`) : null], [NAV[0], NAV[1]]) } };
}

export function buyAgainConfirmView({ activationId, price, previous, operatorChanged, countryName, balance }) {
    const enough = balance == null || balance + 1e-9 >= price;
    const text = `🔄 <b>Buy Again — price update</b>\n\n🌍 ${h(countryName)}\nPrevious price: ${usd(previous)}\nNew price: <b>${usd(price)}</b>\n` +
        (operatorChanged ? `ℹ️ Your previous option is out of stock; this is the cheapest available.\n` : '') +
        (enough ? `\nDo you want to continue at the new price?` : `\n⚠️ You need <b>${usd(price - balance)}</b> more.`);
    return { text, reply_markup: { inline_keyboard: rows(enough ? [btn(`✅ Buy at ${usd(price)}`, `obac:${activationId}:${Math.round(price * 100)}`)] : [btn('💳 Deposit', 'deposit')], NAV) } };
}

export function failureView(r) {
    const back = { inline_keyboard: rows([btn('◀️ Countries', 'ocp:0')], NAV) };
    const m = {
        NO_STOCK: '😕 No numbers are available for that option right now. You were not charged.',
        PROVIDER_ERROR: '⚠️ The number provider had a temporary problem. You were not charged — please try again in a moment.',
        PROVIDER_NOT_CONFIGURED: '⚠️ This service is temporarily unavailable.',
        INSUFFICIENT_FUNDS: `💰 Insufficient balance. You need <b>${usd(r.required)}</b>${r.shortfall ? ` (<b>${usd(r.shortfall)}</b> more)` : ''}.`,
        TOO_MANY_ACTIVE: `⏳ You already have ${r.max || 'several'} active OTHERS numbers. Wait for one to finish or cancel it.`,
        WALLET_ERROR: '⚠️ Could not reserve your balance. You were not charged.',
        NOT_ELIGIBLE: 'ℹ️ This order can no longer be bought again.',
        NOT_FOUND: '❌ Order not found.',
        DUPLICATE: 'ℹ️ That request was already processed.',
        RESTRICTED: '⛔ Your account is currently restricted. Contact support.',
        ACTIVE_SESSION_EXISTS: 'ℹ️ You already have an active number. Finish or cancel it first.',
        INVALID_INPUT: '❌ Invalid selection.'
    }[r.status] || '⚠️ Something went wrong. You were not charged.';
    const dep = r.status === 'INSUFFICIENT_FUNDS' ? [btn('💳 Deposit', 'deposit')] : null;
    return { text: m, reply_markup: { inline_keyboard: rows(dep ? [dep[0]] : [], ...back.inline_keyboard) } };
}

// ───────────── My Orders ─────────────
const ICON = { WAITING: '⏳', CHECKING: '⏳', ACTIVE: '⏳', PURCHASING: '⏳', RECEIVED: '✅', TIMEOUT: '⌛', EXPIRED: '⌛', CANCELLED: '🚫', FAILED: '❌' };
const FILTER_LABEL = { all: 'All', active: 'Active', completed: 'Done', expired: 'Expired', cancelled: 'Cancelled' };

export function ordersView(res) {
    const { items, page, pages, total, filter } = res;
    const text = `📦 <b>My Orders</b> — ${FILTER_LABEL[filter] || 'All'} (${total})\n\n` + (items.length
        ? items.map((o, i) => `${i + 1}. ${ICON[o.status] || '•'} <b>${h(o.service)}</b> · ${h(o.country || '')}\n   <code>${h(o.number || '—')}</code> · ${usd(o.price)}${o.otp ? ` · 🔑 <code>${h(o.otp)}</code>` : ''}`).join('\n')
        : `<i>No orders here yet.</i>`) + `\n\nPage ${page + 1}/${pages}`;
    const filters = Object.keys(FILTER_LABEL).map(f => btn(f === filter ? `• ${FILTER_LABEL[f]}` : FILTER_LABEL[f], `mof:${f}`));
    const list = items.map((o, i) => btn(`${i + 1}. ${o.service}`, `mod:${o.kind}:${o.id}`));
    const listRows = []; for (let i = 0; i < list.length; i += 3) listRows.push(list.slice(i, i + 3));
    const nav = [];
    if (page > 0) nav.push(btn('◀️ Prev', `mop:${filter}:${page - 1}`));
    if (page < pages - 1) nav.push(btn('Next ▶️', `mop:${filter}:${page + 1}`));
    return { text, reply_markup: { inline_keyboard: rows(filters.slice(0, 3), filters.slice(3), ...listRows, nav, [btn('📱 OTHERS', 'others_menu'), NAV[1]]) } };
}

export function orderDetailView(o) {
    const when = o.createdAt ? new Date(o.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
    const last = o.messages?.[o.messages.length - 1];
    const text = `${ICON[o.status] || '•'} <b>${h(o.service)}</b> · ${h(o.country || '')}\n\n📞 Number: <code>${h(o.number || '—')}</code>\n📡 Status: <b>${h(o.status)}</b>\n💵 Amount: ${usd(o.price)}\n🕒 Date: ${when}\n` +
        (o.otp ? `🔑 Code: <code>${h(o.otp)}</code>\n` : '') + (last?.text ? `\n💬 <pre>${h(last.text)}</pre>` : '') +
        (o.refund ? `\n💸 Refunded` : '');
    const rebuy = o.rebuy ? btn('🔄 Buy Again', o.kind === 'O' ? `oba:${o.id}` : `bas:${o.id}`) : null;
    const check = (o.kind === 'O' && ['ACTIVE', 'PURCHASING'].includes(o.status)) ? btn('🔄 Check Now', `or:${o.id}`) : null;
    const copy = o.number ? { text: '📋 Copy Number', copy_text: { text: o.number } } : null;
    return { text, reply_markup: { inline_keyboard: rows([rebuy], [check, copy], [btn('◀️ My Orders', 'my_orders'), NAV[1]]) } };
}

export function buyAgainSessionView(q) {
    const enough = q.sufficient;
    const text = `🔄 <b>Buy Again</b>\n\n📱 ${h(q.session.service)} · ${h(q.session.country)}\n` +
        (q.changed ? `Previous price: ${usd(q.previous)}\nNew price: <b>${usd(q.price)}</b>\n` : `Price: <b>${usd(q.price)}</b>\n`) +
        `💰 Balance: ${usd(q.balance)}\n` + (enough ? `\nA completely new number will be requested.` : `\n⚠️ You need <b>${usd(q.shortfall)}</b> more.`);
    const kb = enough ? [btn(`✅ Confirm — ${usd(q.price)}`, `basc:${q.session.sessionId}:${Math.round(q.price * 100)}`)] : [btn('💳 Deposit', 'deposit')];
    return { text, reply_markup: { inline_keyboard: rows(kb ? [kb] : [], NAV) } };
}

export function newSessionView(s) {
    const text = `✅ <b>New number ready</b>\n\n📱 ${h(s.service)} · ${h(s.country)}\n📞 <code>${h(s.number)}</code>\n💵 ${usd(s.cost)}\n\nUse it now — your code will be delivered here automatically.`;
    return { text, reply_markup: { inline_keyboard: rows([{ text: '📋 Copy Number', copy_text: { text: s.number } }], [btn('🔄 Check OTP', `check_otp_${s.sessionId}`), btn('❌ Cancel', 'cancel_otp')], [NAV[0]]) } };
}

export function timeoutPromptView({ sessionId, service, canRebuy }) {
    const text = `⌛ <b>No code arrived for ${h(service)}</b>\n\nThe number expired and your balance was not charged.`;
    return { text, reply_markup: { inline_keyboard: rows([canRebuy ? btn('🔄 Buy Again', `bas:${sessionId}`) : null], NAV) } };
}

/** Normal OTP session: code received (same look as OTHERS). */
export function sessionReceivedView(s, otp) {
    const text = `✅ <b>Code received</b>\n\n📱 ${h(s.service)} · ${h(s.country || '')}\n📞 Number: <code>${h(s.number)}</code>\n🔑 Code: <code>${h(otp)}</code>\n💵 Charged: ${usd(s.cost)}\n\n⚠️ Never share this code with anyone.`;
    return { text, reply_markup: { inline_keyboard: rows([{ text: '📋 Copy Code', copy_text: { text: String(otp) } }, { text: '📋 Copy Number', copy_text: { text: String(s.number) } }], [btn('🔄 Buy Again', `bas:${s.sessionId}`), NAV[0]], [NAV[1]]) } };
}
