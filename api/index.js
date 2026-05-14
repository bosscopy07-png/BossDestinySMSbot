// ═══════════════════════════════════════════════════════════════════════════════
// api/index.js — Express Server Factory
// ═══════════════════════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import webhookRoutes from './routes/webhooks.js';
import logger from '../utils/logger.js';
import config from '../config/env.js';

export default function createServer() {
    const app = express();
    
    // Security middleware
    app.use(helmet());
    app.use(cors());
    
    // Body parsing for webhooks
    app.use(express.json({ 
        verify: (req, res, buf) => { req.rawBody = buf; } 
    }));
    app.use(express.urlencoded({ 
        extended: true, 
        verify: (req, res, buf) => { req.rawBody = buf; } 
    }));
    
    // Mount webhook routes — CRITICAL for ad redirects
    app.use('/webhooks', webhookRoutes);
    
    // Health check
    app.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            mode: 'server',
            botAvailable: !!global.telegramBot,
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    });
    
    // 404 handler
    app.use((req, res) => {
        res.status(404).json({ 
            error: 'Not found',
            path: req.path,
            hint: 'Available: /webhooks/*, /health' 
        });
    });
    
    // Error handler
    app.use((err, req, res, next) => {
        logger.error('Express error', { 
            path: req.path, 
            error: err.message,
            stack: err.stack 
        });
        res.status(500).json({ error: 'Internal server error' });
    });
    
    return app;
}
