// ═══════════════════════════════════════════════════════════════════════════════
// routes/webhooks.js — Production Webhook Handlers
// SMS (Twilio/Telnyx) + Ad Network Postbacks + Ad User Redirect
// ═══════════════════════════════════════════════════════════════════════════════

import express from 'express';
import crypto from 'crypto';
import twilio from 'twilio';
import { Session, User } from '../models/index.js';
import logger from '../utils/logger.js';
import config from '../config/env.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
//  TWILIO SMS WEBHOOK
// ═══════════════════════════════════════════════════════════════════════

function validateTwilioRequest(req) {
    const authToken = config.twilio?.authToken;
    const webhookUrl = `${config.baseUrl}/webhooks/twilio`;
    
    if (!authToken) {
        logger.warn('Twilio auth token not configured — skipping signature validation');
        return process.env.NODE_ENV !== 'production';
    }

    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
        logger.warn('Missing Twilio signature header');
        return false;
    }

    return twilio.validateRequest(
        authToken,
        signature,
        webhookUrl,
        req.body
    );
}

router.post('/twilio', 
    express.urlencoded({ extended: false, verify: (req, res, buf) => { req.rawBody = buf; } }),
    async (req, res) => {
        res.type('text/xml').send('<Response/>');

        try {
            if (process.env.NODE_ENV === 'production' && !validateTwilioRequest(req)) {
                logger.error('Invalid Twilio signature — possible spoofing attempt', {
                    ip: req.ip,
                    headers: req.headers
                });
                return;
            }

            const { From, To, Body, MessageSid, NumMedia } = req.body;

            if (!To || !Body) {
                logger.warn('Twilio webhook missing required fields', { body: req.body });
                return;
            }

            logger.info('Twilio SMS received', {
                from: maskPhone(From),
                to: maskPhone(To),
                messageSid: MessageSid,
                bodyLength: Body.length,
                hasMedia: NumMedia > 0
            });

            const session = await Session.findOneAndUpdate(
                {
                    phoneNumber: normalizePhone(To),
                    status: { $in: ['WAITING', 'ACTIVE'] },
                    provider: { $in: ['TWILIO', 'NUMBER_POOL'] }
                },
                { $set: { lastActivityAt: new Date() } },
                { sort: { createdAt: -1 }, new: true }
            );

            if (!session) {
                logger.warn('No active session for Twilio number', { 
                    to: maskPhone(To),
                    from: maskPhone(From) 
                });
                
                await storeOrphanSMS({
                    provider: 'TWILIO',
                    from: From,
                    to: To,
                    body: Body,
                    messageSid: MessageSid,
                    receivedAt: new Date()
                });
                return;
            }

            const otp = extractOTP(Body);
            
            const updateResult = await Session.updateOne(
                { _id: session._id, status: { $in: ['WAITING', 'ACTIVE'] } },
                {
                    $set: {
                        otp: otp || null,
                        smsText: Body,
                        smsFrom: From,
                        messageSid: MessageSid,
                        otpReceivedAt: new Date(),
                        status: otp ? 'RECEIVED' : 'SMS_RECEIVED_NO_OTP',
                        lastActivityAt: new Date()
                    }
                }
            );

            if (updateResult.matchedCount === 0) {
                logger.warn('Session was already completed when SMS arrived', {
                    sessionId: session.sessionId,
                    messageSid
                });
                return;
            }

            logger.info('Session updated with SMS', {
                sessionId: session.sessionId,
                userId: session.userId,
                hasOtp: !!otp,
                otpPreview: otp ? otp.slice(0, 2) + '****' : null
            });

            if (session.userId) {
                await notifyUser(session.userId, {
                    type: otp ? 'OTP_RECEIVED' : 'SMS_RECEIVED_NO_OTP',
                    otp: otp || null,
                    sessionId: session.sessionId,
                    service: session.service,
                    expiresIn: session.timeoutAt ? Math.floor((session.timeoutAt - Date.now()) / 1000) : null
                });
            }

            if (session.provider === 'NUMBER_POOL' && session.poolNumberId) {
                await releasePoolNumber(session.poolNumberId, session.sessionId);
            }

        } catch (error) {
            logger.error('Twilio webhook processing error', {
                error: error.message,
                stack: error.stack,
                body: req.body
            });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════════
//  TELNYX SMS WEBHOOK
// ═══════════════════════════════════════════════════════════════════════

function validateTelnyxRequest(req) {
    const publicKey = config.telnyx?.webhookPublicKey;
    
    if (!publicKey) {
        logger.warn('Telnyx webhook public key not configured');
        return process.env.NODE_ENV !== 'production';
    }

    try {
        const signature = req.headers['telnyx-signature-ed25519'];
        const timestamp = req.headers['telnyx-timestamp'];
        
        if (!signature || !timestamp) {
            logger.warn('Missing Telnyx signature headers');
            return false;
        }

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
            logger.warn('Telnyx webhook timestamp too old');
            return false;
        }

        const payload = `${timestamp}|${req.rawBody}`;
        
        return crypto.verify(
            null,
            Buffer.from(payload),
            {
                key: Buffer.from(publicKey, 'base64'),
                format: 'der',
                type: 'spki'
            },
            Buffer.from(signature, 'base64')
        );
    } catch (error) {
        logger.error('Telnyx signature validation error', { error: error.message });
        return false;
    }
}

router.post('/telnyx',
    express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }),
    async (req, res) => {
        res.status(200).send('OK');

        try {
            if (process.env.NODE_ENV === 'production' && !validateTelnyxRequest(req)) {
                logger.error('Invalid Telnyx signature', { ip: req.ip });
                return;
            }

            const event = req.body?.data;
            const eventType = event?.event_type;
            
            if (eventType !== 'message.received') {
                logger.debug('Ignoring non-SMS Telnyx event', { eventType });
                return;
            }

            const payload = event.payload;
            const from = payload.from?.phone_number || payload.from;
            const to = payload.to?.[0]?.phone_number || payload.to?.phone_number || payload.to;
            const text = payload.text;

            if (!to || !text) {
                logger.warn('Telnyx webhook missing fields', { payload });
                return;
            }

            logger.info('Telnyx SMS received', {
                from: maskPhone(from),
                to: maskPhone(to),
                textLength: text.length
            });

            const session = await Session.findOneAndUpdate(
                {
                    phoneNumber: normalizePhone(to),
                    status: { $in: ['WAITING', 'ACTIVE'] },
                    provider: { $in: ['TELNYX', 'NUMBER_POOL'] }
                },
                { $set: { lastActivityAt: new Date() } },
                { sort: { createdAt: -1 }, new: true }
            );

            if (!session) {
                await storeOrphanSMS({
                    provider: 'TELNYX',
                    from,
                    to,
                    body: text,
                    receivedAt: new Date()
                });
                return;
            }

            const otp = extractOTP(text);

            await Session.updateOne(
                { _id: session._id, status: { $in: ['WAITING', 'ACTIVE'] } },
                {
                    $set: {
                        otp: otp || null,
                        smsText: text,
                        smsFrom: from,
                        otpReceivedAt: new Date(),
                        status: otp ? 'RECEIVED' : 'SMS_RECEIVED_NO_OTP',
                        lastActivityAt: new Date()
                    }
                }
            );

            if (session.userId) {
                await notifyUser(session.userId, {
                    type: otp ? 'OTP_RECEIVED' : 'SMS_RECEIVED_NO_OTP',
                    otp: otp || null,
                    sessionId: session.sessionId,
                    service: session.service
                });
            }

            if (session.provider === 'NUMBER_POOL' && session.poolNumberId) {
                await releasePoolNumber(session.poolNumberId, session.sessionId);
            }

        } catch (error) {
            logger.error('Telnyx webhook error', {
                error: error.message,
                body: req.body
            });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════════
//  AD USER REDIRECT — Records when user actually opens ad
//  This is called when user taps "Open Ad" button in Telegram
// ═══════════════════════════════════════════════════════════════════════

router.get('/ad/redirect', async (req, res) => {
    const { vid, uid } = req.query;
    
    if (!vid || !uid) {
        return res.status(400).send('Invalid ad link');
    }

    try {
        // Direct import — no SMSProviderManager needed
        const { default: AdCreditSystem } = await import('../services/AdCreditSystem.js');
        const adSystem = new AdCreditSystem();
        
        const result = await adSystem.recordAdStart(vid, String(uid));
        
        if (!result.success) {
            logger.warn('recordAdStart failed', { error: result.error, vid, uid });
        }

        // Get target URL from verification
        const verification = await adSystem.getVerification(vid);
        const isFallback = verification?.urlType === 'profitablecpm';
        const targetUrl = isFallback ? adSystem.FALLBACK_URL : adSystem.PRIMARY_URL;

        if (!targetUrl) {
            return res.status(503).send('Ad URL not configured');
        }

        res.redirect(targetUrl);

    } catch (error) {
        logger.error('Ad redirect error', { error: error.message, vid, uid });
        res.status(500).send('Error processing ad link');
    }
});
                


// ═══════════════════════════════════════════════════════════════════════
//  AD NETWORK POSTBACKS — Server-to-server notifications from ad networks
// ═══════════════════════════════════════════════════════════════════════

const postbackLimits = new Map();
const POSTBACK_WINDOW_MS = 60000;
const MAX_POSTBACKS_PER_WINDOW = 100;

function checkPostbackRateLimit(key) {
    const now = Date.now();
    const entry = postbackLimits.get(key);
    
    if (!entry || now - entry.windowStart > POSTBACK_WINDOW_MS) {
        postbackLimits.set(key, { windowStart: now, count: 1 });
        return true;
    }
    
    if (entry.count >= MAX_POSTBACKS_PER_WINDOW) {
        return false;
    }
    
    entry.count++;
    return true;
}

router.get('/ad/:network', async (req, res) => {
    res.status(200).send('OK');

    const { network } = req.params;
    const clientIp = req.ip || req.connection.remoteAddress;

    if (!checkPostbackRateLimit(`${network}:${clientIp}`)) {
        logger.warn('Ad postback rate limited', { network, ip: clientIp });
        return;
    }

    try {
        const { subId, status, payout, verify } = req.query;
        
        if (!subId && !verify) {
            logger.warn('Ad postback missing identifier', { network, query: req.query });
            return;
        }

        const identifier = subId || verify;

        logger.info('Ad postback received', {
            network,
            identifier: identifier.slice(0, 20),
            status,
            payout,
            ip: clientIp
        });

        const { SMSProviderManager } = await import('../services/sms/index.js');
        const providerManager = SMSProviderManager.getInstance?.() || global.smsProviderManager;
        
        if (!providerManager) {
            logger.error('SMSProviderManager not available');
            return;
        }

        const freeProvider = providerManager.getProvider('FREE_PUBLIC');
        const adSystem = freeProvider?.adSystem;
        
        if (!adSystem || typeof adSystem.handlePostback !== 'function') {
            logger.warn('AdCreditSystem not available on FreeProvider', {
                hasFreeProvider: !!freeProvider,
                hasAdSystem: !!adSystem,
                hasHandlePostback: typeof adSystem?.handlePostback === 'function'
            });
            return;
        }

        const result = await adSystem.handlePostback(network, req.query);

        if (!result.success) {
            logger.warn('Ad postback processing failed', {
                network,
                identifier,
                error: result.error
            });
        } else {
            logger.info('Ad postback processed', {
                network,
                identifier,
                creditsAdded: result.creditsAdded,
                userId: result.userId
            });
        }

    } catch (error) {
        logger.error('Ad postback error', {
            network: req.params.network,
            error: error.message,
            stack: error.stack
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function extractOTP(text) {
    if (!text || typeof text !== 'string') return null;

    const keywordPatterns = [
        /(?:code|otp|pin|verification|verify|code:|otp:)\s*[:=\-]?\s*(\d{4,8})/i,
        /(?:your|the)\s+(?:code|otp|pin|verification\s+code)\s+(?:is|:\s*=)\s*(\d{4,8})/i,
        /(?:код|пин|верификация)\s*[:=\-]?\s*(\d{4,8})/i,
        /(?:验证码|验证码为|代码)\s*[:：]?\s*(\d{4,8})/i
    ];

    for (const pattern of keywordPatterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            const code = match[1].replace(/\D/g, '');
            if (/^\d{4,8}$/.test(code)) return code;
        }
    }

    const standaloneMatches = text.replace(/[\s\-_\.]/g, '').match(/\b\d{4,8}\b/g);
    if (standaloneMatches?.length > 0) {
        const sorted = standaloneMatches.sort((a, b) => b.length - a.length);
        return sorted[0];
    }

    const contextMatches = text.match(/(?:code|login|verify|sign\s*in)[^\d]*(\d{4,8})/i);
    if (contextMatches?.[1]) {
        const code = contextMatches[1].replace(/\D/g, '');
        if (/^\d{4,8}$/.test(code)) return code;
    }

    return null;
}

function normalizePhone(phone) {
    if (!phone) return '';
    return phone.toString().replace(/[^\d+]/g, '').replace(/^\+?1?/, '');
}

function maskPhone(phone) {
    if (!phone) return '****';
    const str = phone.toString().replace(/\D/g, '');
    if (str.length < 4) return '****';
    return '+' + str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
}

async function storeOrphanSMS(data) {
    try {
        const { OrphanSMS } = await import('../models/index.js');
        const extractedOtp = extractOTP(data.body);

        await OrphanSMS.create({
            provider: data.provider || 'UNKNOWN',
            from: data.from || null,
            to: data.to,
            body: data.body || null,
            messageSid: data.messageSid || null,
            extractedOtp: extractedOtp,
            receivedAt: data.receivedAt || new Date(),
            rawPayload: data.rawPayload || null,
            sourceIp: data.sourceIp || null,
            reviewed: false
        });

        logger.info('Orphan SMS stored for review', { 
            to: maskPhone(data.to),
            provider: data.provider,
            hasOtp: !!extractedOtp
        });

    } catch (error) {
        logger.error('Failed to store orphan SMS', { 
            error: error.message,
            to: maskPhone(data.to) 
        });
    }
}

async function notifyUser(userId, data) {
    try {
        const bot = global.telegramBot || global.bot;
        if (!bot) {
            logger.warn('Bot instance not available for notification');
            return;
        }

        const hasOtp = !!data.otp && data.otp !== 'null' && data.otp !== 'undefined';

        const message = hasOtp
            ? `🔐 <b>OTP Received!</b>\n\n` +
              `Service: <code>${data.service || 'Unknown'}</code>\n` +
              `Code: <code>${data.otp}</code>\n\n` +
              `⏰ Expires in ${data.expiresIn ? Math.floor(data.expiresIn / 60) + 'm' : 'soon'}`
            : `📩 <b>SMS Received</b>\n\n` +
              `Service: <code>${data.service || 'Unknown'}</code>\n` +
              `Status: No OTP detected in message\n` +
              `Check manually if needed.`;

        const replyMarkup = hasOtp ? {
            inline_keyboard: [[
                { text: '📋 Copy OTP', callback_data: `copy_otp_${data.otp}` }
            ]]
        } : undefined;

        await bot.telegram.sendMessage(userId, message, {
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });

    } catch (error) {
        logger.error('Failed to notify user', { userId, error: error.message });
    }
}

async function releasePoolNumber(poolNumberId, sessionId) {
    try {
        const { SMSProviderManager } = await import('../services/sms/index.js');
        const manager = SMSProviderManager.getInstance?.() || global.smsProviderManager;
        
        if (manager?.numberPool) {
            await manager.numberPool.releaseNumber(poolNumberId, sessionId);
            logger.info('Pool number released', { poolNumberId, sessionId });
        }
    } catch (error) {
        logger.error('Failed to release pool number', { poolNumberId, error: error.message });
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════

router.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

export default router;
