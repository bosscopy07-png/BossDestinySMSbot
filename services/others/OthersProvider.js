// services/others/OthersProvider.js
// Dedicated adapter for 5sim *generic* number activations (product "other").
// Kept separate from CheapPanelProvider so predefined-service flows and OTHERS never mix.
//
// 5sim API used (https://docs.5sim.net):
//   GET /guest/countries
//   GET /guest/prices?product=<product>[&country=<country>]
//   GET /user/buy/activation/<country>/<operator>/<product>[?maxPrice=..]   (Bearer auth)
//   GET /user/check/<id>      GET /user/cancel/<id>      GET /user/finish/<id>
import axios from 'axios';
import logger from '../../utils/logger.js';
import { OTHERS_DEFAULTS } from './constants.js';
import { parseOffers, parseCountries, normalizeProviderStatus, normalizeMessages } from './OthersParser.js';

export class OthersProviderError extends Error {
    constructor(code, message, { ambiguous = false, status = null } = {}) {
        super(message || code);
        this.name = 'OthersProviderError';
        this.code = code;
        this.ambiguous = ambiguous; // true => provider MAY have processed the request (e.g. timeout on buy)
        this.status = status;
    }
}

export function mapProviderError(httpStatus, body) {
    const text = (typeof body === 'string' ? body : JSON.stringify(body || '')).toLowerCase();
    if (httpStatus === 401 || httpStatus === 403) return 'AUTH_FAILED';
    if (httpStatus === 429) return 'RATE_LIMITED';
    if (text.includes('no free phones')) return 'NO_NUMBERS';
    if (text.includes('not enough user balance')) return 'PROVIDER_NO_BALANCE';
    if (text.includes('not enough rating')) return 'NO_NUMBERS';
    if (text.includes('bad country') || text.includes('no product') || text.includes('bad operator')) return 'NOT_SUPPORTED';
    if (text.includes('order not found')) return 'NOT_FOUND';
    if (text.includes('order has sms')) return 'HAS_SMS';
    if (text.includes('hosting order')) return 'CANNOT_CANCEL';
    if (text.includes('server offline') || httpStatus >= 500) return 'PROVIDER_DOWN';
    return 'PROVIDER_ERROR';
}

export class OthersProvider {
    constructor({ http = axios, apiKey, baseUrl, product, timeoutMs = 15000 } = {}) {
        this.http = http;
        this.apiKey = apiKey ?? process.env.OTHERS_API_KEY ?? process.env.CHEAP_PANEL_API_KEY;
        const envBase = baseUrl ?? process.env.OTHERS_BASE_URL ?? process.env.CHEAP_PANEL_BASE_URL ?? '';
        // Only use a configured base URL if it is actually 5sim; otherwise use the official endpoint.
        this.baseUrl = /5sim\.net/i.test(envBase) ? envBase.replace(/\/$/, '') : 'https://5sim.net/v1';
        this.product = product ?? process.env.OTHERS_PRODUCT ?? OTHERS_DEFAULTS.product;
        this.timeoutMs = timeoutMs;
        this.name = '5SIM_OTHERS';
    }

    get isConfigured() { return !!this.apiKey; }

    async _get(path, { auth = false, ambiguousOnTimeout = false } = {}) {
        if (auth && !this.apiKey) throw new OthersProviderError('NOT_CONFIGURED', 'Provider API key not configured');
        let res;
        try {
            res = await this.http.get(`${this.baseUrl}${path}`, {
                timeout: this.timeoutMs,
                headers: { Accept: 'application/json', ...(auth ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
                validateStatus: () => true
            });
        } catch (e) {
            const timedOut = e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '');
            throw new OthersProviderError(timedOut ? 'TIMEOUT' : 'NETWORK', e.message, { ambiguous: ambiguousOnTimeout });
        }
        if (res.status >= 400) {
            throw new OthersProviderError(mapProviderError(res.status, res.data), `HTTP ${res.status}`, { status: res.status });
        }
        if (typeof res.data === 'string') {
            const code = mapProviderError(res.status, res.data);
            if (code !== 'PROVIDER_ERROR') throw new OthersProviderError(code, res.data, { status: res.status });
        }
        return res.data;
    }

    /** Real inventory for the generic product across all countries. */
    async getOffers(country = null) {
        const q = `?product=${encodeURIComponent(this.product)}` + (country ? `&country=${encodeURIComponent(country)}` : '');
        const data = await this._get(`/guest/prices${q}`);
        const offers = parseOffers(data, { product: this.product, country });
        return offers;
    }

    async getCountryNames() {
        try { return parseCountries(await this._get('/guest/countries')); }
        catch (e) { logger.warn('OTHERS: country names unavailable', { error: e.message }); return {}; }
    }

    /** Buy a fresh generic activation. A timeout is AMBIGUOUS: the provider may have allocated a number. */
    async buy(country, operator = 'any', { maxPrice = null } = {}) {
        const mp = operator === 'any' && maxPrice ? `?maxPrice=${encodeURIComponent(maxPrice)}` : '';
        const d = await this._get(`/user/buy/activation/${encodeURIComponent(country)}/${encodeURIComponent(operator)}/${encodeURIComponent(this.product)}${mp}`,
            { auth: true, ambiguousOnTimeout: true });
        if (!d || !d.id || !d.phone) throw new OthersProviderError('INVALID_RESPONSE', 'Provider returned no activation', { ambiguous: true });
        return {
            providerId: String(d.id),
            phone: String(d.phone).startsWith('+') ? String(d.phone) : `+${d.phone}`,
            cost: Number(d.price),
            operator: d.operator || operator,
            expiresAt: d.expires ? new Date(d.expires) : null,
            status: normalizeProviderStatus(d.status)
        };
    }

    async check(providerId) {
        const d = await this._get(`/user/check/${encodeURIComponent(providerId)}`, { auth: true });
        return {
            status: normalizeProviderStatus(d?.status),
            rawStatus: d?.status,
            messages: normalizeMessages(d?.sms),
            expiresAt: d?.expires ? new Date(d.expires) : null
        };
    }

    /** Returns { cancelled: true } only if the provider confirms. */
    async cancel(providerId) {
        try {
            const d = await this._get(`/user/cancel/${encodeURIComponent(providerId)}`, { auth: true });
            const st = normalizeProviderStatus(d?.status);
            return { cancelled: st === 'CANCELLED' || st === 'EXPIRED' || (typeof d === 'string' && /ok/i.test(d)), raw: d?.status ?? d };
        } catch (e) {
            if (e.code === 'HAS_SMS') return { cancelled: false, hasSms: true, error: e.code };
            if (e.code === 'NOT_FOUND') return { cancelled: true, alreadyGone: true };
            return { cancelled: false, error: e.code, message: e.message };
        }
    }

    async finish(providerId) {
        try { await this._get(`/user/finish/${encodeURIComponent(providerId)}`, { auth: true }); return true; }
        catch (e) { logger.warn('OTHERS: finish failed', { providerId, error: e.message }); return false; }
    }
}
export default OthersProvider;
                  
