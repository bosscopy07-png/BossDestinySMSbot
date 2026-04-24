import cron from 'node-cron';
import { User, Session } from '../models/index.js';
import PaymentService from '../services/payment/index.js';
import logger from '../utils/logger.js';

class CronJobs {
    constructor() {
        this.paymentService = new PaymentService();
        this.jobs = [];
    }

    start() {
        // Scan blockchain for deposits every 2 minutes
        this.jobs.push(
            cron.schedule('*/2 * * * *', async () => {
                try {
                    logger.debug('Running deposit scan cron');
                    await this.paymentService.scanDeposits();
                } catch (error) {
                    logger.error('Deposit scan cron failed', { error: error.message });
                }
            })
        );

        // Reset daily counters at midnight UTC
        this.jobs.push(
            cron.schedule('0 0 * * *', async () => {
                try {
                    logger.info('Running daily reset cron');
                    
                    await User.updateMany(
                        {},
                        {
                            $set: {
                                freeUsedToday: 0,
                                freeResetDate: new Date(),
                                vipDailyUsed: 0,
                                vipDailyReset: new Date()
                            }
                        }
                    );

                    logger.info('Daily counters reset');
                } catch (error) {
                    logger.error('Daily reset cron failed', { error: error.message });
                }
            })
        );

        // Cleanup expired sessions every 5 minutes
        this.jobs.push(
            cron.schedule('*/5 * * * *', async () => {
                try {
                    const expired = await Session.updateMany(
                        {
                            status: { $in: ['WAITING', 'CHECKING'] },
                            timeoutAt: { $lt: new Date() }
                        },
                        {
                            $set: { status: 'TIMEOUT', endTime: new Date() }
                        }
                    );

                    if (expired.modifiedCount > 0) {
                        logger.info('Expired sessions cleaned up', {
                            count: expired.modifiedCount
                        });
                    }
                } catch (error) {
                    logger.error('Session cleanup cron failed', { error: error.message });
                }
            })
        );

        // Check VIP expirations daily
        this.jobs.push(
            cron.schedule('0 1 * * *', async () => {
                try {
                    const expiredVips = await User.find({
                        vipExpiry: { $lt: new Date(), $ne: null },
                        mode: 'VIP'
                    });

                    for (const user of expiredVips) {
                        await User.updateOne(
                            { userId: user.userId },
                            { $set: { mode: 'FREE' } }
                        );

                        // Notify user
                        logger.info('VIP expired, downgraded user', {
                            userId: user.userId
                        });
                    }
                } catch (error) {
                    logger.error('VIP expiration check failed', { error: error.message });
                }
            })
        );

        logger.info('Cron jobs started');
    }

    stop() {
        for (const job of this.jobs) {
            job.stop();
        }
        logger.info('Cron jobs stopped');
    }
}

export default CronJobs;

 
