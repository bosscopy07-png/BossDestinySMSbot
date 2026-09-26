import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOperatorData, normalizeServiceOperators, parseVirtualIndex } from '../utils/providerNormalize.js';

// ── TEST 7: Provider returns { Qty, Price } (capitalized) ──────────────────
test('normalizeOperatorData handles capitalized Qty/Price (TEST 7)', () => {
    const result = normalizeOperatorData({ Qty: 5, Price: 0.20 });
    assert.equal(result.stock, 5);
    assert.equal(result.price, 0.20);
    assert.equal(result.available, true);
});

// ── TEST 8: zero stock with a price present must not be available ──────────
test('normalizeOperatorData: Qty=0 with a price is NOT available (TEST 8)', () => {
    const result = normalizeOperatorData({ Qty: 0, Price: 0.20 });
    assert.equal(result.stock, 0);
    assert.equal(result.available, false);
});

test('normalizeOperatorData handles lowercase count/cost', () => {
    const result = normalizeOperatorData({ count: 3, cost: 0.15 });
    assert.equal(result.stock, 3);
    assert.equal(result.price, 0.15);
    assert.equal(result.available, true);
});

test('normalizeOperatorData handles qty/price', () => {
    const result = normalizeOperatorData({ qty: 7, price: 0.30 });
    assert.equal(result.stock, 7);
    assert.equal(result.available, true);
});

test('normalizeOperatorData handles stock/Stock field names', () => {
    assert.equal(normalizeOperatorData({ stock: 2, cost: 0.1 }).stock, 2);
    assert.equal(normalizeOperatorData({ Stock: 4, Cost: 0.1 }).stock, 4);
});

// ── CORE REQUIREMENT #2: price existing is never proof of availability ────
test('normalizeOperatorData: a price with no stock field at all is unavailable', () => {
    const result = normalizeOperatorData({ price: 0.20 });
    assert.equal(result.stock, 0);
    assert.equal(result.available, false);
});

test('normalizeOperatorData: stock with no valid price is unavailable', () => {
    const result = normalizeOperatorData({ count: 5 });
    assert.equal(result.available, false);
});

test('normalizeOperatorData: null/undefined/number/garbage input never throws', () => {
    assert.equal(normalizeOperatorData(null).available, false);
    assert.equal(normalizeOperatorData(undefined).available, false);
    assert.equal(normalizeOperatorData(5).stock, 5);
    assert.equal(normalizeOperatorData('garbage').available, false);
});

test('normalizeServiceOperators only returns virtualN entries, normalized', () => {
    const serviceData = {
        virtual1: { count: 0, cost: 0.1 },
        virtual8: { Qty: 5, Price: 0.2 },
        virtual18: { qty: 2, price: 0.22 },
        somethingElse: { count: 99, cost: 0.01 }
    };
    const result = normalizeServiceOperators(serviceData);
    const names = result.map(r => r.operator).sort();
    assert.deepEqual(names, ['virtual1', 'virtual18', 'virtual8']);

    const v8 = result.find(r => r.operator === 'virtual8');
    assert.equal(v8.stock, 5);
    assert.equal(v8.available, true);

    const v1 = result.find(r => r.operator === 'virtual1');
    assert.equal(v1.available, false);
});

test('parseVirtualIndex extracts the numeric suffix', () => {
    assert.equal(parseVirtualIndex('virtual8'), 8);
    assert.equal(parseVirtualIndex('virtual123'), 123);
    assert.equal(parseVirtualIndex('notAnOperator'), null);
});
