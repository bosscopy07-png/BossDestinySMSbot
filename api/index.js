import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { logRequest } from '../utils/logger.js';
import otpRoutes from './routes/otp.js';
import webhookRoutes from './routes/webhook.js';
import adminRoutes from './routes/admin.js';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
    origin: config.server.env === 'production' ? false : '*'
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMaxRequests,
    message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(logRequest);

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// API routes
app.use('/api/v1/otp', otpRoutes);
app.use('/webhook', webhookRoutes);
app.use('/api/v1/admin', adminRoutes);

// Error handling
app.use((err, req, res, next) => {
    logger.error('API error', {
        error: err.message,
        path: req.path,
        method: req.method
    });
    
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

export const startServer = (port = config.server.port) => {
    return new Promise((resolve) => {
        const server = app.listen(port, () => {
            logger.info(`API server running on port ${port}`);
            resolve(server);
        });
    });
};

export default app;
 
