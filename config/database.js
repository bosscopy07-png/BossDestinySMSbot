import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import config from './env.js';

const connectDatabase = async () => {
    try {
        const conn = await mongoose.connect(config.database.url, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });

        logger.info(`MongoDB connected: ${conn.connection.host}`);

        mongoose.connection.on('error', (err) => {
            logger.error('MongoDB connection error:', err);
        });

        mongoose.connection.on('disconnected', () => {
            logger.warn('MongoDB disconnected. Attempting to reconnect...');
        });

        return conn;
    } catch (error) {
        logger.error('Database connection failed:', error);
        process.exit(1);
    }
};

export default connectDatabase;

