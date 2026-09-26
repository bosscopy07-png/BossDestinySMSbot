// ═══════════════════════════════════════════════════════════════════════════════
//  utils/providerNormalize.js — Single source of truth for provider inventory
//  normalization.
//
//  Different SMS providers (and even different endpoints of the same provider)
//  return stock/price under different field names and different casing:
//    { count: 5, cost: 0.20 }
//    { qty: 5, price: 0.20 }
//    { Qty: 5, Price: 0.20 }     ← 5sim's raw guest/products format
//    { stock: 5, Price: 0.20 }
//
//  Every place in the codebase that reads a raw provider operator record MUST
//  go through normalizeOperatorData() below instead of re-implementing its own
//  `?? ` chain. That is what CORE REQUIREMENT #3 asks for: normalize once, in
//  one place, so "Qty"/"qty"/"count"/"stock" and "Price"/"price"/"cost" are
//  never missed because only the lowercase variant was checked.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize a single raw operator record from a provider's product catalog
 * into { stock, price, available }.
 *
 * Accepts any of: count, qty, Qty, stock, Stock, Count for quantity, and
 * cost, price, Price, Cost for price. Falls back to 0 / Infinity when a
 * field is missing so callers can reliably compare stock > 0.
 *
 * IMPORTANT: price existing is NOT proof of availability (Core Req #2).
 * `available` is only ever true when stock > 0 AND price is a real, positive
 * number.
 *
 * @param {*} operatorData raw value from provider catalog, e.g. products[country][service][operator]
 * @returns {{ stock: number, price: number, available: boolean }}
 */
export function normalizeOperatorData(operatorData) {
    if (operatorData === null || operatorData === undefined) {
        return { stock: 0, price: Infinity, available: false };
    }

    // Some providers (rare) just return a bare number as the stock count.
    if (typeof operatorData === 'number') {
        return { stock: operatorData > 0 ? operatorData : 0, price: Infinity, available: false };
    }

    if (typeof operatorData !== 'object') {
        return { stock: 0, price: Infinity, available: false };
    }

    const rawStock =
        operatorData.count ??
        operatorData.Count ??
        operatorData.qty ??
        operatorData.Qty ??
        operatorData.stock ??
        operatorData.Stock ??
        0;

    const rawPrice =
        operatorData.cost ??
        operatorData.Cost ??
        operatorData.price ??
        operatorData.Price ??
        Infinity;

    const stock = parseInt(rawStock, 10);
    const price = parseFloat(rawPrice);

    const safeStock = Number.isFinite(stock) && stock > 0 ? stock : 0;
    const safePrice = Number.isFinite(price) && price > 0 ? price : Infinity;

    return {
        stock: safeStock,
        price: safePrice,
        // CORE REQUIREMENT #2: a price alone never implies availability.
        available: safeStock > 0 && safePrice !== Infinity
    };
}

/**
 * Normalize an entire `serviceData` block (all operators for one
 * country+service returned by a provider) into a plain array of
 * { operator, stock, price, available }, filtering to `virtualN` entries
 * only. Non-virtual entries (if any) are ignored here — callers that care
 * about them should read serviceData directly.
 *
 * @param {Object} serviceData e.g. { virtual1: {...}, virtual2: {...} }
 * @returns {Array<{ operator: string, stock: number, price: number, available: boolean }>}
 */
export function normalizeServiceOperators(serviceData) {
    if (!serviceData || typeof serviceData !== 'object') return [];

    const results = [];
    for (const [operatorName, operatorData] of Object.entries(serviceData)) {
        if (!operatorName.startsWith('virtual')) continue;
        const normalized = normalizeOperatorData(operatorData);
        results.push({ operator: operatorName, ...normalized });
    }
    return results;
}

/**
 * Extract the numeric virtualN index from an operator name, or null.
 */
export function parseVirtualIndex(operatorName) {
    if (!operatorName) return null;
    const match = operatorName.match(/^virtual(\d+)$/);
    if (!match) return null;
    return parseInt(match[1], 10);
}
