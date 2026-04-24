import jwt from 'jsonwebtoken';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

export const requireAdmin = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, config.security.jwtSecret);

        // Verify admin ID
        const adminIds = config.bot.adminId.split(',');
        if (!adminIds.includes(decoded.adminId)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        req.adminId = decoded.adminId;
        next();

    } catch (error) {
        logger.error('Admin auth failed', { error: error.message });
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

export const generateAdminToken = (adminId) => {
    return jwt.sign(
        { adminId, type: 'admin' },
        config.security.jwtSecret,
        { expiresIn: '24h' }
    );
};

 
