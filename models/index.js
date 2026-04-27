// ═══════════════════════════════════════════════════════════
//  models/index.js — Centralized Model Registry
// ═══════════════════════════════════════════════════════════

import mongoose from 'mongoose';

// ─── Import all models ───
import User from './User.js';
import Session from './Session.js';
import Transaction from './Transaction.js';
import NumberModel from './Number.js';
import Referral from './Referral.js';
import ApiKey from './ApiKey.js';
import AdminLog from './AdminLog.js';
import Settings from './Settings.js';

// ─── Registry for model validation & iteration ───
const modelRegistry = {
    User,
    Session,
    Transaction,
    Number: NumberModel,
    Referral,
    ApiKey,
    AdminLog,
    Settings
};

// ─── Validate all models are proper Mongoose models ───
function validateModels() {
    for (const [name, model] of Object.entries(modelRegistry)) {
        if (!model || typeof model !== 'function') {
            throw new Error(`Model "${name}" is not properly exported. Check ${name}.js`);
        }
        if (!model.modelName) {
            throw new Error(`Model "${name}" is not a valid Mongoose model. Ensure it uses mongoose.model()`);
        }
    }
}

// ─── Initialize: validate + ensure indexes ───
export async function initModels() {
    validateModels();

    const results = [];
    for (const [name, model] of Object.entries(modelRegistry)) {
        try {
            await model.init(); // Ensures indexes are built
            results.push({ name, status: 'ok', collection: model.collection.name });
        } catch (error) {
            logger?.error?.(`Failed to initialize model: ${name}`, { error: error.message });
            results.push({ name, status: 'error', error: error.message });
            throw error; // Fail fast — don't start with broken models
        }
    }

    return results;
}

// ─── Check connection health ───
export function isConnected() {
    return mongoose.connection.readyState === 1;
}

// ─── Get model by name (dynamic access) ───
export function getModel(name) {
    const model = modelRegistry[name];
    if (!model) {
        throw new Error(`Model "${name}" not found in registry. Available: ${Object.keys(modelRegistry).join(', ')}`);
    }
    return model;
}

// ─── List all registered models ───
export function listModels() {
    return Object.keys(modelRegistry);
}

// ─── Named exports ───
export {
    User,
    Session,
    Transaction,
    NumberModel as Number,
    Referral,
    ApiKey,
    AdminLog,
    Settings
};

// ─── Default export: full registry ───
export default modelRegistry;
    
