// services/others/OthersParser.js — pure parsing helpers (no I/O, fully unit-tested)

/**
 * Walk a 5sim price tree and collect offer leaves ({cost,count[,rate]}).
 * Handles /guest/prices?product=X          -> { X: { country: { operator: {cost,count} } } }
 *         /guest/prices?country=C&product=X -> { C: { X: { operator: {cost,count} } } }
 */
export function parseOffers(data, { product, country = null } = {}) {
    const offers = [];
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if ('cost' in node && 'count' in node && typeof node.cost !== 'object') {
            const idx = product ? path.indexOf(product) : -1;
            let c = country;
            if (!c) {
                if (idx === 0) c = path[1];
                else if (idx === 1) c = path[0];
            }
            const operator = path[path.length - 1];
            const cost = Number(node.cost);
            const count = Number(node.count);
            if (c && operator && Number.isFinite(cost) && cost > 0) {
                offers.push({ country: String(c), operator: String(operator), cost, count: Number.isFinite(count) ? count : 0, rate: node.rate ?? null });
            }
            return;
        }
        for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    };
    walk(data, []);
    return offers;
}

/** Group offers by country: min cost + total stock (only in-stock offers). */
export function groupByCountry(offers) {
    const map = new Map();
    for (const o of offers) {
        if (o.count <= 0) continue;
        const g = map.get(o.country) || { country: o.country, minCost: Infinity, stock: 0, options: 0 };
        g.minCost = Math.min(g.minCost, o.cost);
        g.stock += o.count;
        g.options += 1;
        map.set(o.country, g);
    }
    return [...map.values()];
}

/** 5sim /guest/countries -> { slug: { name, iso } } */
export function parseCountries(data) {
    const out = {};
    if (!data || typeof data !== 'object') return out;
    for (const [slug, v] of Object.entries(data)) {
        const iso = v && v.iso && typeof v.iso === 'object' ? Object.keys(v.iso)[0] : null;
        out[slug] = { name: v?.text_en || titleCase(slug), iso: iso ? iso.toUpperCase() : null };
    }
    return out;
}

export function titleCase(slug) {
    return String(slug).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Extract an OTP from arbitrary SMS text. Does NOT assume 6 digits.
 * Returns { code, kind } or { code: null }.
 */
export function extractOtp(text, providerCode = null) {
    if (providerCode !== null && providerCode !== undefined && String(providerCode).trim()) {
        return { code: String(providerCode).trim(), kind: 'provider' };
    }
    if (!text || typeof text !== 'string') return { code: null, kind: null };
    const t = text.replace(/\s+/g, ' ').trim();

    let m = t.match(/\bG-(\d{6})\b/);                                   // Google style
    if (m) return { code: m[1], kind: 'google' };

    m = t.match(/(?:code|otp|pin|passcode|password|token|verification|verify|security)[^0-9A-Za-z]{0,30}?(\d{3}[- ]\d{3,4})\b/i);
    if (m) return { code: m[1].replace(/[- ]/g, ''), kind: 'split' };   // 123-456

    m = t.match(/(?:code|otp|pin|passcode|password|token|verification|verify|security)[^0-9A-Za-z]{0,30}?(\d{4,10})\b/i);
    if (m) return { code: m[1], kind: 'keyword' };

    m = t.match(/\b(\d{4,10})\b[^.]{0,30}?(?:is your|is the)\b/i);       // "123456 is your code"
    if (m) return { code: m[1], kind: 'prefix' };

    m = t.match(/(?:code|otp|pin|passcode|token)\W{0,20}?(?:is\s+)?([A-Za-z0-9]{5,10})\b/i);
    if (m && /\d/.test(m[1]) && /[A-Z]/.test(m[1]) && m[1] === m[1].toUpperCase()) return { code: m[1], kind: 'alphanumeric' };

    m = t.match(/(?<![\d+])(\d{3})[- ](\d{3})(?!\d)/);
    if (m) return { code: m[1] + m[2], kind: 'split' };

    const nums = [...t.matchAll(/(?<![\d+.,])(\d{4,8})(?![\d.,]\d)/g)].map(x => x[1])
        .filter(n => !/^(19|20)\d{2}$/.test(n));                        // skip years
    if (nums.length) return { code: nums[0], kind: 'fallback' };

    return { code: null, kind: null };
}

/** Normalise a 5sim order status to our vocabulary. */
export function normalizeProviderStatus(s) {
    switch (String(s || '').toUpperCase()) {
        case 'RECEIVED': case 'FINISHED': return 'RECEIVED';
        case 'CANCELED': case 'CANCELLED': return 'CANCELLED';
        case 'TIMEOUT': case 'EXPIRED': return 'EXPIRED';
        case 'BANNED': return 'BANNED';
        case 'PENDING': case 'WAITING': return 'PENDING';
        default: return 'UNKNOWN';
    }
}

/** Normalise the SMS list of a 5sim order into [{text,sender,receivedAt,code}] */
export function normalizeMessages(sms) {
    if (!sms) return [];
    const arr = Array.isArray(sms) ? sms : (typeof sms === 'object' ? [sms] : [{ text: String(sms) }]);
    return arr.map(x => ({
        text: String(x?.text ?? x?.sms ?? ''),
        sender: x?.sender ?? null,
        code: x?.code ?? null,
        receivedAt: x?.date || x?.created_at ? new Date(x.date || x.created_at) : new Date()
    })).filter(m => m.text || m.code);
          }
