import mongoose from 'mongoose';

const numberSchema = new mongoose.Schema({
   numberId: {
       type: String,
       required: true,
       unique: true    // ← Auto-creates unique index
   },
   phoneNumber: {
       type: String,
       required: true,
       unique: true    // ← Auto-creates unique index
   },
   country: {
       type: String,
       required: true,
       index: true
   },
   countryCode: {
       type: String,
       required: true
   },
   
   // Provider
   provider: {
       type: String,
       required: true,
       index: true
   },
   providerNumberId: {
       type: String,
       default: null
   },
   
   // Tier
   tier: {
       type: String,
       enum: ['FREE', 'CHEAP', 'VIP'],
       required: true,
       index: true
   },
   
   // Status
   status: {
       type: String,
       enum: ['ACTIVE', 'BUSY', 'EXPIRED', 'BLOCKED', 'ERROR'],
       default: 'ACTIVE',
       index: true
   },
   
   // Assignment
   assignedTo: {
       type: String,
       default: null,
       index: true
   },
   sessionId: {
       type: String,
       default: null
   },
   
   // Timing
   purchasedAt: {
       type: Date,
       default: Date.now
   },
   expiresAt: {
       type: Date,
       default: null,
       index: true     // ← For expiry cleanup jobs
   },
   lastUsed: {
       type: Date,
       default: null,
       index: true
   },
   
   // Stats
   totalOTPs: {
       type: Number,
       default: 0
   },
   successCount: {
       type: Number,
       default: 0
   },
   failCount: {
       type: Number,
       default: 0
   },
   successRate: {
       type: Number,
       default: 100
   },
   
   // Cost tracking
   monthlyCost: {
       type: Number,
       default: 0
   },
   smsCost: {
       type: Number,
       default: 0
   }
}, {
   timestamps: true
});

// ═══════════════════════════════════════════════════════════
//  COMPOUND INDEXES
// ═══════════════════════════════════════════════════════════

// Number pool query: find available numbers by tier + country + status
numberSchema.index({ tier: 1, country: 1, status: 1, lastUsed: 1 });

// Provider inventory
numberSchema.index({ provider: 1, tier: 1, status: 1 });

// Expiry cleanup job
numberSchema.index({ status: 1, expiresAt: 1 });

// Assigned numbers lookup
numberSchema.index({ assignedTo: 1, status: 1 });

// ═══════════════════════════════════════════════════════════
//  STATICS
// ═══════════════════════════════════════════════════════════

/**
* Find available number for OTP request
*/
numberSchema.statics.findAvailable = async function(tier, country, excludeIds = []) {
   return this.findOne({
       tier,
       country,
       status: 'ACTIVE',
       assignedTo: null,
       numberId: { $nin: excludeIds }
   }).sort({ lastUsed: 1, successRate: -1 }).lean();
};

/**
* Mark number as assigned
*/
numberSchema.statics.assign = async function(numberId, userId, sessionId) {
   return this.findOneAndUpdate(
       { numberId, status: 'ACTIVE', assignedTo: null },
       { $set: { assignedTo: userId, sessionId, status: 'BUSY', lastUsed: new Date() } },
       { new: true }
   );
};

/**
* Release number after session ends
*/
numberSchema.statics.release = async function(numberId, status = 'ACTIVE') {
   return this.findOneAndUpdate(
       { numberId },
       { $set: { assignedTo: null, sessionId: null, status }, $inc: { totalOTPs: 1 } },
       { new: true }
   );
};

/**
* Update success rate after OTP result
*/
numberSchema.statics.recordResult = async function(numberId, success) {
   const number = await this.findOne({ numberId });
   if (!number) return null;

   const successCount = number.successCount + (success ? 1 : 0);
   const failCount = number.failCount + (success ? 0 : 1);
   const total = successCount + failCount;
   const successRate = total > 0 ? (successCount / total) * 100 : 100;

   return this.findOneAndUpdate(
       { numberId },
       { $set: { successCount, failCount, successRate } },
       { new: true }
   );
};

/**
* Get expired numbers for cleanup
*/
numberSchema.statics.getExpired = async function() {
   return this.find({
       expiresAt: { $lte: new Date() },
       status: { $ne: 'EXPIRED' }
   }).lean();
};

/**
* Get provider stats
*/
numberSchema.statics.getProviderStats = async function(provider) {
   return this.aggregate([
       { $match: { provider } },
       {
           $group: {
               _id: '$tier',
               total: { $sum: 1 },
               active: { $sum: { $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0] } },
               busy: { $sum: { $cond: [{ $eq: ['$status', 'BUSY'] }, 1, 0] } },
               avgSuccessRate: { $avg: '$successRate' }
           }
       }
   ]);
};

/**
* Create new number entry with validation
*/
numberSchema.statics.createNumber = async function(data) {
   const {
       phoneNumber,
       country,
       countryCode,
       provider,
       providerNumberId = null,
       tier,
       monthlyCost = 0,
       expiresAt = null
   } = data;

   if (!phoneNumber || !country || !countryCode || !provider || !tier) {
       throw new Error('Missing required fields: phoneNumber, country, countryCode, provider, tier');
   }

   const numberId = `${provider}_${country}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

   return this.create({
       numberId,
       phoneNumber,
       country: country.toUpperCase(),
       countryCode,
       provider: provider.toUpperCase(),
       providerNumberId,
       tier: tier.toUpperCase(),
       status: 'ACTIVE',
       assignedTo: null,
       sessionId: null,
       purchasedAt: new Date(),
       expiresAt,
       lastUsed: null,
       totalOTPs: 0,
       successCount: 0,
       failCount: 0,
       successRate: 100,
       monthlyCost,
       smsCost: 0
   });
};

/**
* Bulk insert numbers from provider sync
*/
numberSchema.statics.bulkUpsert = async function(numbers) {
   const operations = numbers.map(num => ({
       updateOne: {
           filter: { phoneNumber: num.phoneNumber },
           update: {
               $setOnInsert: {
                   numberId: num.numberId || `${num.provider}_${num.country}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                   phoneNumber: num.phoneNumber,
                   country: num.country,
                   countryCode: num.countryCode,
                   provider: num.provider,
                   tier: num.tier,
                   purchasedAt: new Date()
               },
               $set: {
                   providerNumberId: num.providerNumberId || null,
                   status: num.status || 'ACTIVE',
                   expiresAt: num.expiresAt || null,
                   monthlyCost: num.monthlyCost || 0
               }
           },
           upsert: true
       }
   }));

   return this.bulkWrite(operations);
};

/**
* Block a number permanently
*/
numberSchema.statics.block = async function(numberId, reason = null) {
   return this.findOneAndUpdate(
       { numberId },
       { $set: { status: 'BLOCKED', assignedTo: null, sessionId: null } },
       { new: true }
   );
};

/**
* Get numbers needing renewal (expiring within days)
*/
numberSchema.statics.getExpiringSoon = async function(days = 7) {
   const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
   return this.find({
       expiresAt: { $lte: cutoff, $gt: new Date() },
       status: { $in: ['ACTIVE', 'BUSY'] }
   }).lean();
};

/**
* Get tier availability counts
*/
numberSchema.statics.getAvailability = async function(country = null) {
   const match = country ? { country: country.toUpperCase() } : {};
   return this.aggregate([
       { $match: { ...match, status: 'ACTIVE', assignedTo: null } },
       {
           $group: {
               _id: { tier: '$tier', country: '$country' },
               count: { $sum: 1 }
           }
       },
       { $sort: { '_id.tier': 1 } }
   ]);
};

/**
* Calculate total monthly cost
*/
numberSchema.statics.getMonthlyCost = async function(provider = null) {
   const match = provider ? { provider, status: { $ne: 'EXPIRED' } } : { status: { $ne: 'EXPIRED' } };
   const result = await this.aggregate([
       { $match: match },
       { $group: { _id: null, total: { $sum: '$monthlyCost' } } }
   ]);
   return result[0]?.total || 0;
};

const NumberModel = mongoose.model('Number', numberSchema);

export default NumberModel;
       
