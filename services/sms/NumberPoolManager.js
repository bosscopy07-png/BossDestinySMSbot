import { NumberModel } from '../../models/index.js';
import logger from '../../utils/logger.js';

class NumberPoolManager {
    constructor(twilioProvider) {
        this.name = 'NUMBER_POOL';
        this.twilioProvider = twilioProvider;
        this.availableNumbers = new Map(); // country -> [{ phoneNumber, twilioSid, _id }]
        this.activeAssignments = new Map(); // sessionId -> number doc
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;

        // Load available numbers from DB
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

        logger.info('NumberPoolManager initialized', {
            totalNumbers: numbers.length,
            byCountry: Object.fromEntries(
                Array.from(this.availableNumbers.entries()).map(([k, v]) => [k, v.length])
            )
        });
    }

    async acquireNumber(country = 'US', service = 'Any') {
        await this.initialize();

        const pool = this.availableNumbers.get(country) || [];
        const number = pool.shift();

        if (!number) {
            logger.error('Number pool empty', { country, service });
            throw new Error(`POOL_EMPTY: No Twilio numbers available in ${country}`);
        }

        // Mark as in-use in DB
        await NumberModel.updateOne(
            { _id: number._id },
            { 
                $set: { 
                    status: 'IN_USE',
                    assignedAt: new Date(),
                    assignedService: service
                }
            }
        );

        this.activeAssignments.set(number._id.toString(), {
            ...number,
            assignedAt: new Date()
        });

        logger.info('Pool number assigned', {
            phone: this.maskPhone(number.phoneNumber),
            country,
            service,
            remainingInPool: pool.length
        });

        return {
            phoneNumber: number.phoneNumber,
            provider: 'TWILIO',
            providerNumberId: number.twilioSid,
            country,
            service,
            cost: 0, // Already paid monthly
            isPoolNumber: true,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000) // 30 min max hold
        };
    }

    async releaseNumber(sessionIdOrNumberId) {
        const assignment = this.activeAssignments.get(sessionIdOrNumberId);
        if (!assignment) {
            // Try to find by session mapping if stored differently
            return { success: false, message: 'Assignment not found' };
        }

        const country = assignment.country || 'US';
        const pool = this.availableNumbers.get(country) || [];

        // Return to pool
        pool.push(assignment);

        // Mark available in DB
        await NumberModel.updateOne(
            { _id: assignment._id },
            { 
                $set: { 
                    status: 'AVAILABLE',
                    assignedAt: null,
                    assignedService: null
                }
            }
        );

        this.activeAssignments.delete(sessionIdOrNumberId);

        logger.info('Pool number released', {
            phone: this.maskPhone(assignment.phoneNumber),
            country,
            poolSize: pool.length
        });

        return { success: true };
    }

    async buyNewNumber(country = 'US') {
        // Admin-only: Purchase new number from Twilio
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

            logger.info('New Twilio number purchased', {
                phone: this.maskPhone(twilioNumber.phoneNumber),
                country,
                cost: twilioNumber.monthlyCost
            });

            return doc;

        } catch (error) {
            logger.error('Failed to buy Twilio number', { country, error: error.message });
            throw error;
        }
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

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

export default NumberPoolManager;
