// api/index.js — MUST export createServer as default or named
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import webhookRoutes from '../routes/webhook.js';
import logger from '../utils/logger.js';

export default function createServer() {
    const app = express();
    
    app.use(helmet({
        contentSecurityPolicy: false,  // Allow iframe loading for ad networks
        crossOriginEmbedderPolicy: false  // Allow cross-origin ad content
    }));
    app.use(cors());
    
    // Raw body buffer for ALL requests (needed for webhook signature verification)
    app.use(express.json({ 
        limit: '10mb',
        verify: (req, res, buf) => { req.rawBody = buf; } 
    }));
    app.use(express.urlencoded({ 
        extended: true,
        limit: '10mb', 
        verify: (req, res, buf) => { req.rawBody = buf; } 
    }));
    
    app.use('/webhooks', webhookRoutes);
    
    app.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            mode: 'server',
            botAvailable: !!global.telegramBot,
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    });
    
    app.use((req, res) => {
        res.status(404).json({ 
            error: 'Not found',
            path: req.path,
            hint: 'Available: /webhooks/*, /health' 
        });
    });
    
    app.use((err, req, res, next) => {
        logger.error('Express error', { 
            path: req.path, 
            error: err.message 
        });
        res.status(500).json({ error: 'Internal server error' });
    });
    
    return app;
}
