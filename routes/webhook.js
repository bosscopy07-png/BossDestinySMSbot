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
import webhookController from '../controllers/webhookController.js';

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

// Paystack payment webhook (raw body is captured globally in api/index.js)
router.post('/payment', (req, res) => webhookController.handlePaymentWebhook(req, res));
router.post('/paystack', (req, res) => webhookController.handlePaymentWebhook(req, res));
router.get('/payment/callback', (req, res) => res.type('html').send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h3>Payment received</h3><p>Return to Telegram. Your balance updates automatically within a minute.</p></body></html>'));

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
//  AD USER REDIRECT — FIXED: Interstitial page instead of 302 redirect
//  Serves HTML that loads ad network content properly so views are tracked
// ═══════════════════════════════════════════════════════════════════════

    
router.get('/ad/redirect', async (req, res) => {
    const { vid, uid } = req.query;
    
    if (!vid || !uid) {
        return res.status(400).send('Invalid ad link');
    }

    try {
        const { default: AdCreditSystem } = await import('../services/sms/AdCreditSystem.js');
        const adSystem = new AdCreditSystem();
        
        const result = await adSystem.recordAdStart(vid, String(uid));
        
        if (!result.success) {
            logger.warn('recordAdStart failed', { error: result.error, vid, uid });
            return res.status(400).send(`Error: ${result.error}`);
        }

        const verification = await adSystem.getVerification(vid);
        const isFallback = verification?.urlType === 'profitablecpm';
        const targetUrl = isFallback ? adSystem.FALLBACK_URL : adSystem.PRIMARY_URL;

        if (!targetUrl) {
            return res.status(503).send('Ad URL not configured');
        }

        // ─── SERVE INTERSTITIAL HTML INSTEAD OF 302 REDIRECT ───
        // This ensures ad network JavaScript executes and tracks the view
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Loading Advertisement...</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%);
            color: #e0e0e0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            position: relative;
        }
        .particles {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            pointer-events: none;
            overflow: hidden;
        }
        .particle {
            position: absolute;
            width: 4px; height: 4px;
            background: rgba(0, 212, 170, 0.3);
            border-radius: 50%;
            animation: float 15s infinite;
        }
        @keyframes float {
            0%, 100% { transform: translateY(100vh) rotate(0deg); opacity: 0; }
            10% { opacity: 1; }
            90% { opacity: 1; }
            100% { transform: translateY(-100vh) rotate(720deg); opacity: 0; }
        }
        .container {
            text-align: center;
            z-index: 10;
            padding: 20px;
            max-width: 400px;
        }
        .logo {
            width: 64px; height: 64px;
            margin: 0 auto 24px;
            background: linear-gradient(135deg, #00d4aa, #00a8e8);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            box-shadow: 0 8px 32px rgba(0, 212, 170, 0.3);
            animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
        h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; color: #fff; }
        .subtitle { font-size: 14px; color: #888; margin-bottom: 32px; }
        .loader-wrap {
            position: relative;
            width: 120px; height: 120px;
            margin: 0 auto 24px;
        }
        .loader-ring {
            position: absolute;
            inset: 0;
            border: 3px solid transparent;
            border-top-color: #00d4aa;
            border-radius: 50%;
            animation: spin 1.2s linear infinite;
        }
        .loader-ring:nth-child(2) {
            inset: 8px;
            border-top-color: #00a8e8;
            animation-duration: 1.8s;
            animation-direction: reverse;
        }
        .loader-ring:nth-child(3) {
            inset: 16px;
            border-top-color: #7c3aed;
            animation-duration: 2.4s;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .timer {
            font-size: 13px;
            color: #666;
            margin-bottom: 20px;
        }
        .timer span {
            color: #00d4aa;
            font-weight: 600;
            font-size: 18px;
        }
        .progress-bar {
            width: 100%;
            height: 4px;
            background: rgba(255,255,255,0.05);
            border-radius: 2px;
            overflow: hidden;
            margin-bottom: 24px;
        }
        .progress-fill {
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, #00d4aa, #00a8e8);
            border-radius: 2px;
            transition: width 0.3s ease;
        }
        .warning {
            background: rgba(255, 193, 7, 0.08);
            border: 1px solid rgba(255, 193, 7, 0.2);
            color: #ffc107;
            padding: 12px 16px;
            border-radius: 12px;
            font-size: 12px;
            line-height: 1.5;
            margin-bottom: 16px;
        }
        .warning strong { color: #ffd54f; }
        .status {
            font-size: 11px;
            color: #555;
            font-family: 'Courier New', monospace;
        }
        .status-dot {
            display: inline-block;
            width: 6px; height: 6px;
            background: #00d4aa;
            border-radius: 50%;
            margin-right: 6px;
            animation: blink 1s infinite;
        }
        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        .iframe-container {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 100;
            display: none;
            background: #000;
        }
        .iframe-container iframe {
            width: 100%; height: 100%;
            border: none;
        }
        .close-ad {
            position: fixed;
            top: 12px; right: 12px;
            z-index: 101;
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.1);
            color: #fff;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 12px;
            cursor: pointer;
            display: none;
        }
    </style>
</head>
<body>
    <div class="particles" id="particles"></div>
    
    <div class="container" id="loadingScreen">
        <div class="logo">📺</div>
        <h1>Loading Advertisement</h1>
        <div class="subtitle">Please wait while we prepare your ad</div>
        
        <div class="loader-wrap">
            <div class="loader-ring"></div>
            <div class="loader-ring"></div>
            <div class="loader-ring"></div>
        </div>
        
        <div class="timer">
            Minimum watch time: <span id="countdown">30</span>s
        </div>
        
        <div class="progress-bar">
            <div class="progress-fill" id="progressFill"></div>
        </div>
        
        <div class="warning">
            <strong>⚠️ Important:</strong> If the ad doesn't load properly, please 
            <strong>open this link in Chrome or Safari</strong> instead of Telegram's 
            built-in browser. Ad networks require a full browser to count views.
        </div>
        
        <div class="status">
            <span class="status-dot"></span>
            <span id="statusText">Initializing ad session...</span>
        </div>
    </div>

    <div class="iframe-container" id="adFrame">
        <button class="close-ad" id="closeAd" onclick="closeAd()">✕ Close Ad</button>
    </div>

    <script>
        (function() {
            const CONFIG = {
                targetUrl: ${JSON.stringify(targetUrl)},
                minWatchMs: ${adSystem.MIN_WATCH_TIME},
                vid: ${JSON.stringify(vid)},
                uid: ${JSON.stringify(uid)},
                baseUrl: ${JSON.stringify(config.baseUrl || '')},
                isProfitableCPM: ${JSON.stringify(isFallback)}
            };
            
            const MIN_WATCH_MS = CONFIG.minWatchMs;
            const COUNTDOWN_START = Math.ceil(MIN_WATCH_MS / 1000);
            let startTime = Date.now();
            let watchTime = 0;
            let adLoaded = false;
            let claimReady = false;
            let countdown = COUNTDOWN_START;
            
            // Create floating particles
            const particlesContainer = document.getElementById('particles');
            for (let i = 0; i < 20; i++) {
                const p = document.createElement('div');
                p.className = 'particle';
                p.style.left = Math.random() * 100 + '%';
                p.style.animationDelay = Math.random() * 15 + 's';
                p.style.animationDuration = (10 + Math.random() * 10) + 's';
                particlesContainer.appendChild(p);
            }
            
            // Update status
  
