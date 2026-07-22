// ═══════════════════════════════════════════════════════════════════════════════
//  models/index.js — Centralized Model Registry (FIXED + Payment Added)
// ═══════════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';
import logger from '../utils/logger.js';

import User from './User.js';
import AdView from './AdView.js';
import Session from './Session.js';
import Transaction from './Transaction.js';
import NumberModel from './Number.js';
import Referral from './Referral.js';
import ApiKey from './ApiKey.js';
import AdminLog from './AdminLog.js';
import Settings from './Settings.js';
import { OrphanSMS } from './OrphanSMS.js';
import Notification from './Notification.js';
import AdVerification from './AdVerification.js';
import CreditTransaction from './CreditTransaction.js';
import Payment from './Payment.js';  // ← ADDED

const modelRegistry = {
    User,
    Session,
    AdView,
    Transaction,
    Number: NumberModel,
    Referral,
    ApiKey,
    AdVerification,
    AdminLog,
    Settings,
    OrphanSMS,
    Notification,
    CreditTransaction,
    Payment  // ← ADDED
};

function validateModels() {
    for (const [name, model] of Object.entries(modelRegistry)) {
        if (!model || typeof model !== 'function') {
            throw new Error(`Model "${name}" is not properly exported.`);
        }
        if (!model.modelName) {
            throw new Error(`Model "${name}" is not a valid Mongoose model.`);
        }
    }
}

// ─── Drop ALL indexes on a collection and let schema recreate them ───
async function resetIndexes(model) {
    try {
        const collection = model.collection;
        const indexes = await collection.indexes();
        
        for (const idx of indexes) {
            if (idx.name === '_id_') continue;
            logger.warn(`Dropping index ${idx.name} on ${model.modelName}`);
            await collection.dropIndex(idx.name);
        }
        
        await model.syncIndexes();
        return { name: model.modelName, status: 'reset' };
    } catch (error) {
        logger.error(`Failed to reset indexes for ${model.modelName}`, { error: error.message });
        throw error;
    }
}

// ─── Initialize with conflict handling ───
export async function initModels() {
    validateModels();

    const results = [];
    for (const [name, model] of Object.entries(modelRegistry)) {
        try {
            await model.syncIndexes();
            results.push({ name, status: 'ok' });
            logger.info(`Model ${name} initialized`);
        } catch (error) {
            if (error.code === 85 || error.code === 86 || error.codeName?.includes('Conflict')) {
                logger.warn(`Index conflict on ${name}, resetting indexes...`);
                const resetResult = await resetIndexes(model);
                results.push(resetResult);
            } else {
                logger.error(`Failed to initialize model: ${name}`, { error: error.message });
                results.push({ name, status: 'error', error: error.message });
                if (name === 'User' || name === 'Settings') throw error;
            }
        }
    }

    return results;
}

export function isConnected() {
    return mongoose.connection.readyState === 1;
}

export function getModel(name) {
    const model = modelRegistry[name];
    if (!model) {
        throw new Error(`Model "${name}" not found. Available: ${Object.keys(modelRegistry).join(', ')}`);
    }
    return model;
}

export function listModels() {
    return Object.keys(modelRegistry);
}

export {
    User,
    AdView,
    Session,
    Transaction,
    NumberModel as Number,
    Referral,
    ApiKey,
    AdminLog,
    Settings,
    OrphanSMS,
    AdVerification,
    Notification,
    CreditTransaction,
    Payment  // ← ADDED
};

export default modelRegistry;
