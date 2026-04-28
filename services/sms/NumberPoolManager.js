import { NumberModel } from '../../models/index.js';
import logger from '../../utils/logger.js';

class NumberPoolManager {
    constructor(twilioProvider) {
        this.name = 'NUMBER_POOL';
        this.twilioProvider = twilioProvider;
        this.availableNumbers = new Map();
        this.activeAssignments = new Map();
        this.isInitialized = false;
        this.maxHoldMinutes = 30;
        this.cleanupInterval = null;
    }

    async initialize() {
        if (this.isInitialized) return;

        const numbers = await NumberModel.find({ 
            status: 'AVAILABLE',
            provider: 'TWILIO'
        }).lean();

        for (const num of numbers) {
            const country = num.country || 'US';
            if (!this.availableNumbers.has(country)) {
                this.availableNumbers.set(country, []);
            }
            this.availableNumbers.get(country).push(num);
        }

        this.isInitialized = true;
        this.startCleanupJob();

        logger.info('NumberPoolManager initialized', {
            totalNumbers: numbers.length,
            byCountry: Object.fromEntries(
                Array.from(this.availableNumbers.entries()).map(([k, v]) => [k, v.length])
            )
        });
    }

    startCleanupJob() {
        if (this.cleanupInterval) return;
        this.cleanupInterval = setInterval(() => this.cleanupStaleAssignments(), 60000);
    }

    stopCleanupJob() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    async cleanupStaleAssignments() {
        const now = new Date();
        const staleIds = [];

        for (const [id, assignment] of this.activeAssignments) {
            const assignedAt = new Date(assignment.assignedAt);
            const minutesHeld = (now - assignedAt) / (1000 * 60);

            if (minutesHeld > this.maxHoldMinutes) {
                staleIds.push(id);
                logger.warn('Releasing stale assignment', {
                    phone: this.maskPhone(assignment.phoneNumber),
                    heldMinutes: Math.round(minutesHeld),
                    country: assignment.country
                });
            }
        }

        for (const id of staleIds) {
            try {
                await this.releaseNumber(id, 'STALE_RELEASE');
            } catch (e) {
                logger.error('Failed to release stale assignment', { id, error: e.message });
            }
        }
    }

    async acquireNumber(country = 'US', service = 'Any', userId = null) {
        await this.initialize();

        const pool = this.availableNumbers.get(country) || [];
        const number = pool.shift();

        if (!number) {
            logger.error('Number pool empty', { country, service });
            throw new Error(`POOL_EMPTY: No Twilio numbers available in ${country}`);
        }

        const now = new Date();
        const updateResult = await NumberModel.updateOne(
            { _id: number._id, status: 'AVAILABLE' },
            { 
                $set: { 
                    status: 'IN_USE',
                    assignedAt: now,
                    assignedService: service,
                    assignedTo: userId,
                    lastUsed: now
                },
                $inc: { totalAssignments: 1 }
            }
        );

        if (updateResult.modifiedCount === 0) {
            pool.unshift(number);
            throw new Error('CONCURRENT_ACQUIRE: Number was taken by another request');
        }

        const assignment = {
            ...number,
            assignedAt: now,
            assignedService: service,
            assignedTo: userId
        };

        this.activeAssignments.set(number._id.toString(), assignment);

        logger.info('Pool number assigned', {
            phone: this.maskPhone(number.phoneNumber),
            country,
            service,
            userId,
            remainingInPool: pool.length
        });

        return {
            phoneNumber: number.phoneNumber,
            provider: 'TWILIO',
            providerNumberId: number.twilioSid,
            country,
            service,
            cost: 0,
            isPoolNumber: true,
            expiresAt: new Date(now.getTime() + this.maxHoldMinutes * 60 * 1000),
            assignedAt: now
        };
    }

    async releaseNumber(sessionIdOrNumberId, reason = 'SESSION_END') {
        const assignment = this.activeAssignments.get(sessionIdOrNumberId);

        if (!assignment) {
            const dbDoc = await NumberModel.findOne({
                $or: [
                    { _id: sessionIdOrNumberId },
                    { twilioSid: sessionIdOrNumberId }
                ],
                status: 'IN_USE'
            }).lean();

            if (!dbDoc) {
                return { success: false, message: 'Assignment not found' };
            }

            const country = dbDoc.country || 'US';
            const pool = this.availableNumbers.get(country) || [];
            pool.push(dbDoc);

            await NumberModel.updateOne(
                { _id: dbDoc._id },
                { 
                    $set: { 
                        status: 'AVAILABLE',
                        assignedAt: null,
                        assignedService: null,
                        assignedTo: null
                    }
                }
            );

            logger.info('Pool number released (DB recovery)', {
                phone: this.maskPhone(dbDoc.phoneNumber),
                country,
                reason,
                poolSize: pool.length
            });

            return { success: true, recovered: true };
        }

        const country = assignment.country || 'US';
        const pool = this.availableNumbers.get(country) || [];

        pool.push({
            ...assignment,
            status: 'AVAILABLE',
            assignedAt: null,
            assignedService: null,
            assignedTo: null
        });

        await NumberModel.updateOne(
            { _id: assignment._id },
            { 
                $set: { 
                    status: 'AVAILABLE',
                    assignedAt: null,
                    assignedService: null,
                    assignedTo: null
                }
            }
        );

        this.activeAssignments.delete(sessionIdOrNumberId);

        logger.info('Pool number released', {
            phone: this.maskPhone(assignment.phoneNumber),
            country,
            reason,
            poolSize: pool.length
        });

        return { success: true };
    }

    async buyNewNumber(country = 'US', quantity = 1) {
        const results = [];
        const errors = [];

        for (let i = 0; i < quantity; i++) {
            try {
                const twilioNumber = await this.twilioProvider.buyNumber(country);
                
                const doc = await NumberModel.create({
                    phoneNumber: twilioNumber.phoneNumber,
                    twilioSid: twilioNumber.sid,
                    provider: 'TWILIO',
                    country,
                    status: 'AVAILABLE',
                    monthlyCost: twilioNumber.monthlyCost || 1.00,
                    purchasedAt: new Date()
                });

                const pool = this.availableNumbers.get(country) || [];
                pool.push(doc.toObject());

                results.push(doc);

                logger.info('New Twilio number purchased', {
                    phone: this.maskPhone(twilioNumber.phoneNumber),
                    country,
                    cost: twilioNumber.monthlyCost
                });

            } catch (error) {
                errors.push({ index: i, error: error.message });
                logger.error('Failed to buy Twilio number', { country, index: i, error: error.message });
            }
        }

        if (results.length === 0 && errors.length > 0) {
            throw new Error(`All ${quantity} purchase attempts failed: ${errors[0].error}`);
        }

        return { purchased: results, errors, totalCost: results.reduce((s, r) => s + (r.monthlyCost || 1.00), 0) };
    }

    async retireNumber(numberId, reason = 'RETIRED') {
        const assignment = this.activeAssignments.get(numberId);
        if (assignment) {
            this.activeAssignments.delete(numberId);
        }

        const doc = await NumberModel.findOneAndUpdate(
            { $or: [{ _id: numberId }, { twilioSid: numberId }] },
            { $set: { status: 'RETIRED' } },
            { new: true }
        );

        if (!doc) {
            return { success: false, message: 'Number not found' };
        }

        const country = doc.country || 'US';
        const pool = this.availableNumbers.get(country) || [];
        const idx = pool.findIndex(n => n._id?.toString() === numberId || n.twilioSid === numberId);
        if (idx !== -1) pool.splice(idx, 1);

        try {
            await this.twilioProvider.releaseNumber(doc.twilioSid);
        } catch (e) {
            logger.warn('Twilio release failed for retired number', { numberId, error: e.message });
        }

        logger.info('Number retired', {
            phone: this.maskPhone(doc.phoneNumber),
            country,
            reason
        });

        return { success: true, doc };
    }

    getPoolStats() {
        const stats = {};
        for (const [country, numbers] of this.availableNumbers) {
            const active = Array.from(this.activeAssignments.values())
                .filter(a => a.country === country).length;
            
            stats[country] = {
                available: numbers.length,
                active,
                total: numbers.length + active
            };
        }
        return stats;
    }

    getDetailedStats() {
        const activeList = Array.from(this.activeAssignments.values()).map(a => ({
            phone: this.maskPhone(a.phoneNumber),
            country: a.country,
            service: a.assignedService,
            assignedAt: a.assignedAt,
            heldMinutes: Math.round((Date.now() - new Date(a.assignedAt)) / 60000)
        }));

        return {
            pools: this.getPoolStats(),
            activeAssignments: activeList,
            totalActive: this.activeAssignments.size,
            isInitialized: this.isInitialized,
            maxHoldMinutes: this.maxHoldMinutes
        };
    }

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

export default NumberPoolManager;
                
