// ═══════════════════════════════════════════════════════════════════════════════
// api/index.js — Express Server Factory
// ═══════════════════════════════════════════════════════════════════════════════

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import config from '../config/env.js';
import logger, { logRequest } from '../utils/logger.js';
import otpRoutes from './routes/otp.js';
import webhookRoutes from './routes/webhook.js';
import adminRoutes from './routes/admin.js';

// ─── Rate Limiter Configurations ─────────────────────────────────────────────

const standardLimiter = rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const webhookLimiter = rateLimit({
    windowMs: 60_000, // 1 minute
    max: 100,         // Higher limit for webhook endpoints
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip
});

// ─── Raw Body Parser for Webhooks ──────────────────────────────────────────────

const rawBodySaver = (req, res, buf) => {
    req.rawBody = buf;
};

// ─── Server Factory ────────────────────────────────────────────────────────────

export default function createServer(options = {}) {
    const { 
        mode = 'full',        // 'full' | 'webhook-only'
        enableRawBody = false // For webhook signature verification
    } = options;

    const app = express();

    // Security middleware
    app.use(helmet({
        contentSecurityPolicy: mode === 'webhook-only' ? false : undefined
    }));
    
    app.use(cors({
        origin: config.server.env === 'production' 
            ? config.server.allowedOrigins 
            : '*',
        credentials: true
    }));

    // Request logging (before rate limit to capture all)
    app.use(logRequest);

    // Rate limiting
    app.use(standardLimiter);

    // Body parsing
    if (enableRawBody) {
        app.use(express.json({ verify: rawBodySaver, limit: '10mb' }));
        app.use(express.urlencoded({ verify: rawBodySaver, extended: true, limit: '10mb' }));
    } else {
        app.use(express.json({ limit: '10mb' }));
        app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    }

    // ─── Routes ────────────────────────────────────────────────────────────────

    // Health check (always available)
    app.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            mode,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            ...(mode === 'full' && { botAvailable: !!global.telegramBot })
        });
    });

    // API routes
    if (mode === 'full') {
        app.use('/api/v1/otp', otpRoutes);
        app.use('/api/v1/admin', adminRoutes);
    }

    // Webhook routes (available in both modes, with relaxed rate limit)
    app.use('/webhook', webhookLimiter, webhookRoutes);
    app.use('/webhooks', webhookLimiter, webhookRoutes); // Alias for compatibility

    // ─── Error Handling ───────────────────────────────────────────────────────

    // 404 handler
    app.use((req, res) => {
        res.status(404).json({
            error: 'Not found',
            path: req.path,
            method: req.method,
            hint: mode === 'full' 
                ? 'Available: /api/v1/*, /webhook/*, /health' 
                : 'Available: /webhook/*, /health'
        });
    });

    // Global error handler
    app.use((err, req, res, next) => {
        const statusCode = err.status || err.statusCode || 500;
        const isClientError = statusCode >= 400 && statusCode < 500;

        logger.error(isClientError ? 'Client error' : 'Server error', {
            error: err.message,
            stack: err.stack,
            path: req.path,
            method: req.method,
            statusCode,
            ...(req.user && { userId: req.user.id }) // Safe user logging
        });

        // Don't leak stack traces in production
        const response = {
            error: err.message || 'Internal server error',
            ...(config.server.env !== 'production' && { stack: err.stack })
        };

        res.status(statusCode).json(response);
    });

    return app;
}

// ─── Server Starter ───────────────────────────────────────────────────────────

export const startServer = async (port = config.server.port, options = {}) => {
    const app = createServer(options);
    
    return new Promise((resolve, reject) => {
        const server = app.listen(port, (err) => {
            if (err) return reject(err);
            
            logger.info(`🚀 API server running`, {
                port,
                mode: options.mode || 'full',
                env: config.server.env,
                pid: process.pid
            });
            
            resolve(server);
        });

        // Graceful shutdown handlers
        const shutdown = (signal) => {
            logger.info(`${signal} received, shutting down gracefully...`);
            server.close(() => {
                logger.info('Server closed');
                process.exit(0);
            });
            
            // Force shutdown after 10s
            setTimeout(() => {
                logger.error('Forced shutdown due to timeout');
                process.exit(1);
            }, 10000);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    });
};
                
