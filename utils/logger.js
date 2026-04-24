import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logDir = join(__dirname, '../../logs');

const fileTransport = new DailyRotateFile({
    filename: join(logDir, 'application-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    )
});

const errorTransport = new DailyRotateFile({
    filename: join(logDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d',
    level: 'error',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    )
});

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    defaultMeta: { service: 'otp-sms-bot' },
    transports: [
        fileTransport,
        errorTransport,
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ],
    exceptionHandlers: [
        new DailyRotateFile({
            filename: join(logDir, 'exceptions-%DATE%.log'),
            datePattern: 'YYYY-MM-DD'
        })
    ],
    rejectionHandlers: [
        new DailyRotateFile({
            filename: join(logDir, 'rejections-%DATE%.log'),
            datePattern: 'YYYY-MM-DD'
        })
    ]
});

export const logRequest = (req, res, next) => {
    logger.info('HTTP Request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.get('user-agent')
    });
    next();
};

export default logger;
