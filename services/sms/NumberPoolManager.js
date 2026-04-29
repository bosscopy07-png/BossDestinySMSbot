import { Number as NumberModel } from '../../models/index.js';
import logger from '../../utils/logger.js';

/**
 * NumberPoolManager — Multi-provider phone number pool with ACID-like acquire
 * 
 * Providers must implement:
 *   - buyNumber(country) -> { phoneNumber, sid, monthlyCost }
 *   - releaseNumber(sid) -> { success }
 *   - hasAvailableNumbers(country) -> Promise<boolean>  [optional but recommended]
 */
class NumberPoolManager {
    constructor(twilioProvider, telnyxProvider = null) {
        this.name = 'NUMBER_POOL';

        // Provider registry
        this.providers = new Map();
        if (twilioProvider?.isActive && typeof twilioProvider.buyNumber === 'function') {
            this.providers.set('TWILIO', twilioProvider);
        }
        if (telnyxProvider?.isActive && typeof telnyxProvider.buyNumber === 'function') {
            this.providers.set('TELNYX', telnyxProvider);
        }

        if (this.providers.size === 0) {
            throw new Error('NO_PROVIDERS: At least one active provider with buyNumber() required');
        }

        this.availableNumbers = new Map();   // country -> [{ _id, phoneNumber, ... }]
        this.activeAssignments = new Map();  // assignmentId -> { ... }
        this.isInitialized = false;
        this.maxHoldMinutes = 30;
        this.cleanupInterval = null;
        this.acquireLock = new Map();        // _id -> boolean (prevents double-acquire race)
        this.cleanupRunning = false;         // Prevents overlapping cleanup runs
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    async initialize() {
        if (this.isInitialized) return;

        const numbers = await NumberModel.find({
            status: 'AVAILABLE',
            provider: { $in: Array.from(this.providers.keys()) }
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
            providers: Array.from(this.providers.keys()),
            totalNumbers: numbers.length,
            byCountry: Object.fromEntries(
                Array.from(this.availableNumbers.entries()).map(([k, v]) => [k, v.length])
            )
        });
    }

    startCleanupJob() {
        if (this.cleanupInterval) return;
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleAssignments().catch(err => {
                logger.error('Cleanup job failed', { error: err.message });
            });
        }, 60000);
    }

    stopCleanupJob() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    async uninitialize() {
        this.stopCleanupJob();
        this.isInitialized = false;
        this.availableNumbers.clear();
        this.activeAssignments.clear();
        this.acquireLock.clear();
        this.cleanupRunning = false;
        logger.info('NumberPoolManager uninitialized');
    }

    // ─── Core: Acquire ─────────────────────────────────────────────────────

    async acquireNumber(country = 'US', service = 'Any', userId = null, preferredProvider = null) {
        await this.initialize();

        const pool = this.availableNumbers.get(country) || [];
        if (pool.length === 0) {
            logger.error('Number pool empty', { country, service });
            throw new Error(`POOL_EMPTY: No numbers available in ${country}`);
        }

        // Try preferred provider first, then any
        const providerOrder = preferredProvider && this.providers.has(preferredProvider)
            ? [preferredProvider, ...Array.from(this.providers.keys()).filter(p => p !== preferredProvider)]
            : Array.from(this.providers.keys());

        let number = null;
        let numberIndex = -1;

        for (const providerName of providerOrder) {
            numberIndex = pool.findIndex(n => n.provider === providerName);
            if (numberIndex !== -1) {
                number = pool[numberIndex];
                break;
            }
        }

        if (!number) {
            logger.error('Number pool empty for preferred providers', { country, service, tried: providerOrder });
            throw new Error(`POOL_EMPTY: No numbers available in ${country} for providers: ${providerOrder.join(', ')}`);
        }

        // ─── Race-condition guard: DB-level atomic update ─────────────────
        const now = new Date();
        const numberIdStr = number._id.toString();

        // Prevent concurrent acquire of same number in this process
        if (this.acquireLock.has(numberIdStr)) {
            // Remove contested number temporarily and recurse to try next
            pool.splice(numberIndex, 1);
            try {
                return await this.acquireNumber(country, service, userId, preferredProvider);
            } finally {
                // Always restore the contested number to pool
                pool.splice(numberIndex, 0, number);
            }
        }

        this.acquireLock.set(numberIdStr, true);

        try {
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
                // Number was taken by another process/request — remove and recurse
                pool.splice(numberIndex, 1);
                try {
                    return await this.acquireNumber(country, service, userId, preferredProvider);
                } finally {
                    // Always restore the number to pool for next attempt
                    pool.splice(numberIndex, 0, number);
                }
            }

            // Success: remove from pool permanently
            pool.splice(numberIndex, 1);

            const assignment = {
                ...number,
                assignedAt: now,
                assignedService: service,
                assignedTo: userId
            };

            this.activeAssignments.set(numberIdStr, assignment);

            logger.info('Pool number assigned', {
                phone: this.maskPhone(number.phoneNumber),
                country,
                service,
                userId,
                provider: number.provider,
                remainingInPool: pool.length
            });

            return {
                phoneNumber: number.phoneNumber,
                provider: number.provider,
                providerNumberId: number.twilioSid || number.telnyxSid,
                numberId: numberIdStr,
                country,
                service,
                cost: number.monthlyCost || 0,
                isPoolNumber: true,
                expiresAt: new Date(now.getTime() + this.maxHoldMinutes * 60 * 1000),
                assignedAt: now
            };

        } finally {
            this.acquireLock.delete(numberIdStr);
        }
    }

    // ─── Core: Release ─────────────────────────────────────────────────────

    async releaseNumber(sessionIdOrNumberId, reason = 'SESSION_END') {
        const assignment = this.activeAssignments.get(sessionIdOrNumberId);

        if (!assignment) {
            return this._releaseFromDb(sessionIdOrNumberId, reason);
        }

        const country = assignment.country || 'US';
        const pool = this.availableNumbers.get(country) || [];

        // Remove from active assignments FIRST (idempotency)
        this.activeAssignments.delete(sessionIdOrNumberId);

        // Update DB
        try {
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
        } catch (dbError) {
            logger.error('DB release failed after memory removal', {
                numberId: sessionIdOrNumberId,
                error: dbError.message
            });
            throw dbError;
        }

        // Add back to pool with consistent shape (lean doc)
        pool.push({
            _id: assignment._id,
            phoneNumber: assignment.phoneNumber,
            twilioSid: assignment.twilioSid || null,
            telnyxSid: assignment.telnyxSid || null,
            provider: assignment.provider,
            country: assignment.country,
            monthlyCost: assignment.monthlyCost || 0,
            status: 'AVAILABLE',
            totalAssignments: assignment.totalAssignments || 0
        });

        logger.info('Pool number released', {
            phone: this.maskPhone(assignment.phoneNumber),
            country,
            reason,
            provider: assignment.provider,
            poolSize: pool.length
        });

        return { success: true };
    }

    async _releaseFromDb(numberId, reason) {
        const dbDoc = await NumberModel.findOne({
            $or: [
                { _id: numberId },
                { twilioSid: numberId },
                { telnyxSid: numberId }
            ],
            status: 'IN_USE'
        }).lean();

        if (!dbDoc) {
            return { success: false, message: 'Assignment not found' };
        }

        const country = dbDoc.country || 'US';
        const pool = this.availableNumbers.get(country) || [];

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

        // Add back with consistent lean shape
        pool.push({
            _id: dbDoc._id,
            phoneNumber: dbDoc.phoneNumber,
            twilioSid: dbDoc.twilioSid || null,
            telnyxSid: dbDoc.telnyxSid || null,
            provider: dbDoc.provider,
            country: dbDoc.country,
            monthlyCost: dbDoc.monthlyCost || 0,
            status: 'AVAILABLE',
            totalAssignments: dbDoc.totalAssignments || 0
        });

        logger.info('Pool number released (DB recovery)', {
            phone: this.maskPhone(dbDoc.phoneNumber),
            country,
            reason,
            provider: dbDoc.provider,
            poolSize: pool.length
        });

        return { success: true, recovered: true };
    }

    // ─── Core: Buy ─────────────────────────────────────────────────────────

    async buyNewNumber(country = 'US', quantity = 1, preferredProvider = null) {
        const results = [];
        const errors = [];

        // Determine provider order
        const providerNames = preferredProvider && this.providers.has(preferredProvider)
            ? [preferredProvider, ...Array.from(this.providers.keys()).filter(p => p !== preferredProvider)]
            : Array.from(this.providers.keys());

        for (let i = 0; i < quantity; i++) {
            let bought = false;

            for (const providerName of providerNames) {
                const provider = this.providers.get(providerName);

                // Pre-check: skip provider if it reports no inventory
                if (provider.hasAvailableNumbers && !(await provider.hasAvailableNumbers(country))) {
                    errors.push({ index: i, provider: providerName, error: `No numbers available in ${country}` });
                    logger.warn('Provider reports no inventory, skipping', { provider: providerName, country });
                    continue;
                }

                try {
                    const providerNumber = await provider.buyNumber(country);

                    const doc = await NumberModel.create({
                        phoneNumber: providerNumber.phoneNumber,
                        twilioSid: providerName === 'TWILIO' ? providerNumber.sid : null,
                        telnyxSid: providerName === 'TELNYX' ? providerNumber.sid : null,
                        provider: providerName,
                        country,
                        status: 'AVAILABLE',
                        monthlyCost: providerNumber.monthlyCost || 1.00,
                        purchasedAt: new Date()
                    });

                    const pool = this.availableNumbers.get(country) || [];
                    pool.push(doc.toObject());

                    results.push(doc);

                    logger.info('New number purchased', {
                        phone: this.maskPhone(providerNumber.phoneNumber),
                        country,
                        provider: providerName,
                        cost: providerNumber.monthlyCost
                    });

                    bought = true;
                    break; // Success, move to next quantity

                } catch (error) {
                    const errMsg = error.message || error.toString();
                    errors.push({ index: i, provider: providerName, error: errMsg });
                    logger.error('Failed to buy number', {
                        country,
                        index: i,
                        provider: providerName,
                        error: errMsg
                    });
                }
            }

            if (!bought) {
                errors.push({ index: i, provider: 'ALL', error: 'All providers exhausted' });
            }
        }

        if (results.length === 0 && errors.length > 0) {
            throw new Error(`All ${quantity} purchase attempts failed: ${errors[0].error}`);
        }

        return {
            purchased: results,
            errors,
            totalCost: results.reduce((s, r) => s + (r.monthlyCost || 1.00), 0)
        };
    }

    // ─── Core: Retire ──────────────────────────────────────────────────────

    async retireNumber(numberId, reason = 'RETIRED') {
        const assignment = this.activeAssignments.get(numberId);
        if (assignment) {
            logger.warn('Cannot retire active assignment', {
                numberId,
                assignedTo: assignment.assignedTo,
                assignedAt: assignment.assignedAt
            });
            throw new Error('NUMBER_ACTIVE: Cannot retire a number currently in use. Release it first.');
        }

        const doc = await NumberModel.findOneAndUpdate(
            {
                $or: [
                    { _id: numberId },
                    { twilioSid: numberId },
                    { telnyxSid: numberId }
                ]
            },
            { $set: { status: 'RETIRED' } },
            { new: true }
        );

        if (!doc) {
            return { success: false, message: 'Number not found' };
        }

        const country = doc.country || 'US';
        const pool = this.availableNumbers.get(country) || [];
        const idx = pool.findIndex(n =>
            n._id?.toString() === numberId ||
            n.twilioSid === numberId ||
            n.telnyxSid === numberId
        );
        if (idx !== -1) pool.splice(idx, 1);

        // Release from provider
        const provider = this.providers.get(doc.provider);
        let providerReleaseSuccess = true;
        if (provider) {
            try {
                await provider.releaseNumber(doc.twilioSid || doc.telnyxSid);
            } catch (e) {
                providerReleaseSuccess = false;
                logger.warn('Provider release failed for retired number', {
                    numberId,
                    provider: doc.provider,
                    error: e.message
                });
            }
        }

        logger.info('Number retired', {
            phone: this.maskPhone(doc.phoneNumber),
            country,
            provider: doc.provider,
            reason,
            providerReleaseSuccess
        });

        return { success: true, doc, providerReleaseSuccess };
    }

    // ─── Cleanup ─────────────────────────────────────────────────────────

    async cleanupStaleAssignments() {
        // Prevent overlapping cleanup runs
        if (this.cleanupRunning) return;
        if (this.activeAssignments.size === 0) return;

        this.cleanupRunning = true;

        try {
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
                        country: assignment.country,
                        provider: assignment.provider
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
        } finally {
            this.cleanupRunning = false;
        }
    }

    // ─── Stats ───────────────────────────────────────────────────────────

    getPoolStats() {
        const stats = {};
        const allCountries = new Set([
            ...this.availableNumbers.keys(),
            ...Array.from(this.activeAssignments.values()).map(a => a.country)
        ]);

        for (const country of allCountries) {
            const available = this.availableNumbers.get(country)?.length || 0;
            const active = Array.from(this.activeAssignments.values())
                .filter(a => a.country === country).length;

            stats[country] = {
                available,
                active,
                total: available + active
            };
        }
        return stats;
    }

    getDetailedStats() {
        const activeList = Array.from(this.activeAssignments.values()).map(a => ({
            phone: this.maskPhone(a.phoneNumber),
            country: a.country,
            service: a.assignedService,
            provider: a.provider,
            assignedAt: a.assignedAt,
            heldMinutes: Math.round((Date.now() - new Date(a.assignedAt)) / 60000)
        }));

        return {
            pools: this.getPoolStats(),
            activeAssignments: activeList,
            totalActive: this.activeAssignments.size,
            isInitialized: this.isInitialized,
            maxHoldMinutes: this.maxHoldMinutes,
            providers: Array.from(this.providers.keys())
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    maskPhone(phone) {
        if (!phone) return '****';
        const str = phone.toString();
        if (str.length < 4) return '****';
        return str.slice(0, -4).replace(/./g, '*') + str.slice(-4);
    }
}

export default NumberPoolManager;
            
