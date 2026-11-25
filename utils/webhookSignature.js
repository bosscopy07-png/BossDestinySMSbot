// utils/webhookSignature.js — HMAC-SHA512 webhook verification over the RAW body (timing-safe, fails closed).
import crypto from 'crypto';

export function verifyHmacSha512(rawBody, signature, secret) {
    if (!secret || !signature || !rawBody) return false;
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
    const expected = Buffer.from(crypto.createHmac('sha512', secret).update(body).digest('hex'));
    const given = Buffer.from(String(signature));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
export default verifyHmacSha512;
