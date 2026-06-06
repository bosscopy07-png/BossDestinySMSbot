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
            function setStatus(text) {
                document.getElementById('statusText').textContent = text;
            }
            
            // Update countdown
            const countEl = document.getElementById('countdown');
            const progressEl = document.getElementById('progressFill');
            
            function updateProgress() {
                const elapsed = Date.now() - startTime;
                const pct = Math.min(100, (elapsed / MIN_WATCH_MS) * 100);
                progressEl.style.width = pct + '%';
                
                const remaining = Math.max(0, COUNTDOWN_START - Math.floor(elapsed / 1000));
                if (countEl) countEl.textContent = remaining;
                
                if (elapsed >= MIN_WATCH_MS && !claimReady) {
                    claimReady = true;
                    setStatus('✓ Watch time satisfied! You can claim credits.');
                    progressEl.style.background = 'linear-gradient(90deg, #00d4aa, #7c3aed)';
                }
            }
            
            const progressInterval = setInterval(updateProgress, 100);
            
            // Countdown timer
            const timerInterval = setInterval(() => {
                countdown--;
                if (countdown <= 0) clearInterval(timerInterval);
            }, 1000);
            
            // Notify backend that user opened the ad page
            function pingBackend() {
                const url = CONFIG.baseUrl + '/webhooks/ad/ping?vid=' + CONFIG.vid + '&uid=' + CONFIG.uid;
                fetch(url, { method: 'POST', keepalive: true, cache: 'no-store' })
                    .then(() => setStatus('Session registered — loading ad content...'))
                    .catch(() => setStatus('Connection issue — retrying...'));
            }
            
            // Notify backend when watch time is satisfied
            function notifyReady() {
                const url = CONFIG.baseUrl + '/webhooks/ad/ready?vid=' + CONFIG.vid + '&uid=' + CONFIG.uid;
                fetch(url, { method: 'POST', keepalive: true, cache: 'no-store' })
                    .then(() => logger.info('Backend notified: watch ready'))
                    .catch(() => {});
            }
            
            // Load ad content
            function loadAd() {
                setStatus('Loading ad network content...');
                
                const adFrame = document.getElementById('adFrame');
                const loadingScreen = document.getElementById('loadingScreen');
                
                if (CONFIG.isProfitableCPM) {
                    // ProfitableCPM works best with popup/popunder
                    // Try to open in new window first
                    setStatus('Opening ad in new window...');
                    
                    const popup = window.open(CONFIG.targetUrl, '_blank', 'noopener,noreferrer,width=1024,height=768');
                    
                    if (popup) {
                        setStatus('Ad opened in new window — keep it open to earn credits!');
                        // Keep loading screen visible with success message
                        loadingScreen.innerHTML = '<div style="text-align:center;padding:40px;">' +
                            '<div style="font-size:48px;margin-bottom:20px;">✅</div>' +
                            '<h2 style="margin-bottom:12px;">Ad Opened Successfully!</h2>' +
                            '<p style="color:#888;margin-bottom:20px;">The ad is now open in a new window/tab.</p>' +
                            '<p style="color:#00d4aa;font-size:14px;">Keep it open for ' + COUNTDOWN_START + ' seconds to earn your credits.</p>' +
                            '<p style="color:#666;font-size:12px;margin-top:20px;">You can close this tab and return to Telegram.</p>' +
                            '</div>';
                    } else {
                        // Popup blocked — fallback to iframe
                        setStatus('Popup blocked — loading in iframe...');
                        loadIframe();
                    }
                } else {
                    // OMG10 and others — use iframe
                    loadIframe();
                }
            }
            
            function loadIframe() {
                const adFrame = document.getElementById('adFrame');
                const loadingScreen = document.getElementById('loadingScreen');
                const closeBtn = document.getElementById('closeAd');
                
                const iframe = document.createElement('iframe');
                iframe.src = CONFIG.targetUrl;
                iframe.sandbox = 'allow-scripts allow-same-origin allow-popups allow-forms allow-top-navigation';
                iframe.allow = 'fullscreen; autoplay; clipboard-write';
                iframe.referrerPolicy = 'no-referrer-when-downgrade';
                
                iframe.onload = () => {
                    adLoaded = true;
                    setStatus('Ad content loaded — watching...');
                    loadingScreen.style.display = 'none';
                    adFrame.style.display = 'block';
                    closeBtn.style.display = 'block';
                };
                
                iframe.onerror = () => {
                    setStatus('Failed to load ad — redirecting directly...');
                    setTimeout(() => {
                        window.location.href = CONFIG.targetUrl;
                    }, 2000);
                };
                
                adFrame.appendChild(iframe);
            }
            
            window.closeAd = function() {
                const adFrame = document.getElementById('adFrame');
                const loadingScreen = document.getElementById('loadingScreen');
                adFrame.style.display = 'none';
                loadingScreen.style.display = 'flex';
                setStatus('Ad closed — credits will be awarded if watch time met.');
            };
            
            // Start sequence
            setTimeout(() => {
                pingBackend();
                setTimeout(loadAd, 800);
            }, 500);
            
            // Notify ready when time is up
            setTimeout(() => {
                notifyReady();
            }, MIN_WATCH_MS);
            
            // Prevent accidental navigation away
            window.addEventListener('beforeunload', (e) => {
                if (!claimReady) {
                    e.preventDefault();
                    e.returnValue = 'You are earning ad credits. Leaving now may forfeit your reward.';
                }
            });
            
            // Track visibility
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    logger.info('Tab hidden — watch time may pause');
                } else {
                    logger.info('Tab visible — watch time continues');
                }
            });
            
            // Console logging for debugging
            const logger = {
                info: (msg) => console.log('[AdSession]', msg),
                error: (msg) => console.error('[AdSession]', msg)
            };
            
        })();
    </script>
</body>
</html>`);

    } catch (error) {
        logger.error('Ad redirect error', { error: error.message, vid, uid });
        res.status(500).send('Error processing ad link');
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  AD PING — Called when user opens the interstitial page
// ═══════════════════════════════════════════════════════════════════════

router.post('/ad/ping', async (req, res) => {
    res.status(200).json({ status: 'ok' });
    
    const { vid, uid } = req.query;
    if (!vid || !uid) return;
    
    logger.debug('Ad ping received — user opened interstitial', { 
        vid, 
        uid, 
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 50)
    });
});

// ═══════════════════════════════════════════════════════════════════════
//  AD READY — Called when minimum watch time is satisfied
// ═══════════════════════════════════════════════════════════════════════

router.post('/ad/ready', async (req, res) => {
    res.status(200).json({ status: 'ok' });
    
    const { vid, uid } = req.query;
    if (!vid || !uid) return;
    
    try {
        const { default: AdCreditSystem } = await import('../services/sms/AdCreditSystem.js');
        const adSystem = new AdCreditSystem();
        
        await adSystem.updateVerification(vid, {
            watchSufficientAt: new Date(),
            status: 'WATCHED'
        });
        
        logger.info('Ad watch time satisfied — user can claim credits', { 
            vid, 
            uid,
            ip: req.ip 
        });
    } catch (error) {
        logger.error('Ad ready error', { error: error.message, vid, uid });
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
