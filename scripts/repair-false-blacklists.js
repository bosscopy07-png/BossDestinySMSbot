/**
 * One-off, NON-DESTRUCTIVE repair for accounts that were wrongly blacklisted by the old broadcast bug
 * (a Telegram 403 "user blocked the bot" set isBlacklisted=true with no reason and no admin).
 *
 * Usage:   node scripts/repair-false-blacklists.js            # DRY RUN (default) - lists candidates only
 *          node scripts/repair-false-blacklists.js --apply    # lifts the restriction and records it in restrictionHistory
 *
 * Only users matching ALL of: isBlacklisted=true, blockedBot=true, no blacklistReason, no blacklistedBy.
 * Admin-imposed blacklists (which always have a reason/admin) are never touched. No records are deleted.
 */
import mongoose from 'mongoose';
import config from '../config/env.js';
import { User } from '../models/index.js';

const apply = process.argv.includes('--apply');
await mongoose.connect(config.database.url);
const filter = { isBlacklisted: true, blockedBot: true, $or: [{ blacklistReason: null }, { blacklistReason: { $exists: false } }], blacklistedBy: { $in: [null, undefined] } };
const users = await User.find(filter).select('userId username balance').lean();
console.log(`${users.length} candidate account(s) ${apply ? 'will be restored' : '(dry run — nothing changed)'}`);
for (const u of users) console.log(` - ${u.userId} @${u.username || '-'} balance=${u.balance}`);
if (apply && users.length) {
    const r = await User.updateMany(filter, {
        $set: { isBlacklisted: false, blacklistReason: null, blacklistDate: null, blacklistSource: null },
        $push: { restrictionHistory: { action: 'REPAIR_FALSE_POSITIVE', reason: 'Auto-blacklist from broadcast 403 (bot-blocked) was a false positive', by: 'SYSTEM', source: 'AUTO', at: new Date() } }
    });
    console.log(`Restored ${r.modifiedCount} account(s).`);
}
await mongoose.disconnect();
