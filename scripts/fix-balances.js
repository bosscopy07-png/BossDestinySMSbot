import { User } from '../models/index.js';
import logger from '../utils/logger.js';

/**
 * Fix negative or invalid lockedBalance values
 * Called from admin command or standalone
 */
export async function fixNegativeLockedBalances() {
    logger.info('Starting locked balance fix...');

    const results = {
        fixedNegative: [],
        fixedMissing: [],
        fixedExcessive: [],
        totalFixed: 0
    };

    // Fix 1: Negative lockedBalance
    const negativeUsers = await User.find({ lockedBalance: { $lt: 0 } });
    for (const user of negativeUsers) {
        const oldValue = user.lockedBalance;
        
        await User.updateOne(
            { userId: user.userId },
            { $set: { lockedBalance: 0 } }
        );

        results.fixedNegative.push({
            userId: user.userId,
            was: oldValue,
            now: 0
        });
        results.totalFixed++;
    }

    // Fix 2: Missing lockedBalance field
    const missingUsers = await User.find({ lockedBalance: { $exists: false } });
    for (const user of missingUsers) {
        await User.updateOne(
            { userId: user.userId },
            { $set: { lockedBalance: 0 } }
        );

        results.fixedMissing.push({
            userId: user.userId,
            was: 'missing',
            now: 0
        });
        results.totalFixed++;
    }

    // Fix 3: lockedBalance > balance (cap it)
    const excessiveUsers = await User.find({
        $expr: { $gt: ['$lockedBalance', '$balance'] }
    });

    for (const user of excessiveUsers) {
        const oldValue = user.lockedBalance;
        
        await User.updateOne(
            { userId: user.userId },
            { $set: { lockedBalance: user.balance } }
        );

        results.fixedExcessive.push({
            userId: user.userId,
            was: oldValue,
            now: user.balance,
            balance: user.balance
        });
        results.totalFixed++;
    }

    logger.info('Locked balance fix complete', {
        totalFixed: results.totalFixed,
        negative: results.fixedNegative.length,
        missing: results.fixedMissing.length,
        excessive: results.fixedExcessive.length
    });

    return results;
}
