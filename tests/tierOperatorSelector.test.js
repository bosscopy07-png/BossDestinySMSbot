import { test } from 'node:test';
import assert from 'node:assert/strict';
import TierOperatorSelector from '../services/TierOperatorSelector.js';

/**
 * Builds a mock CHEAP_PANEL-shaped provider whose catalog for US/whatsapp
 * contains exactly the virtual operators/stock passed in `operators`.
 *
 * e.g. mockProvider({ virtual1: 0, virtual8: 5, virtual18: 2 })
 * (values are stock counts; price defaults to 0.20 for every operator with
 * stock, matching the ticket's worked example)
 */
function mockProvider(operators, { providerKey = 'CHEAP_PANEL', priceFor = () => 0.20 } = {}) {
    const serviceData = {};
    for (const [op, stock] of Object.entries(operators)) {
        serviceData[op] = stock > 0 ? { Qty: stock, Price: priceFor(op) } : { Qty: 0, Price: priceFor(op) };
    }

    const catalog = { usa: { whatsapp: serviceData } };

    return {
        name: providerKey,
        providerKey,
        isActive: true,
        mapCountry: () => 'usa',
        mapService: () => 'whatsapp',
        getDisplayPrice: (p) => Number((p + 0.10).toFixed(2)),
        getProducts: async () => catalog
    };
}

// ── TEST 1: virtual8=5, virtual18=0 → tier available, purchase virtual8 ────
test('TEST 1: one operator has stock, another does not — tier is available and picks the one with stock', async () => {
    const provider = mockProvider({ virtual8: 5, virtual18: 0 });
    const selector = new TierOperatorSelector([provider]);

    // budget tier range is 1-25, both virtual8 and virtual18 fall inside it
    const result = await selector.selectOperator('budget', 'US', 'WhatsApp', { skipCache: true });
    assert.equal(result.operator, 'virtual8');
    assert.equal(result.stock, 5);
});

// ── TEST 2: virtual8=0, virtual18=5 → tier available, purchase virtual18 ───
test('TEST 2: the other operator has stock instead — tier is still available', async () => {
    const provider = mockProvider({ virtual8: 0, virtual18: 5 });
    const selector = new TierOperatorSelector([provider]);

    const result = await selector.selectOperator('budget', 'US', 'WhatsApp', { skipCache: true });
    assert.equal(result.operator, 'virtual18');
    assert.equal(result.stock, 5);
});

// ── TEST 3: an operator in a DIFFERENT tier must never leak in ─────────────
test('TEST 3: stock in another tier does not make this tier available, and never mixes operators between tiers', async () => {
    // virtual21 is budget range (1-25); virtual30 is standard range (26-51)
    const provider = mockProvider({ virtual21: 0, virtual30: 5 });
    const selector = new TierOperatorSelector([provider]);

    const budgetResult = await selector.hasTierStock('budget', 'US', 'WhatsApp');
    assert.equal(budgetResult.available, false);

    const standardResult = await selector.hasTierStock('standard', 'US', 'WhatsApp');
    assert.equal(standardResult.available, true);
    assert.equal(standardResult.operator, 'virtual30');
});

// ── TEST 4: both operators have stock — both recognized, one selected ──────
test('TEST 4: both operators available — selector recognizes both and returns one deterministically', async () => {
    const provider = mockProvider({ virtual8: 5, virtual18: 5 });
    const selector = new TierOperatorSelector([provider]);

    const all = await selector.getAllTierOperators('budget', 'US', 'WhatsApp');
    const names = all.map(o => o.operator).sort();
    assert.deepEqual(names, ['virtual18', 'virtual8']);

    const result = await selector.selectOperator('budget', 'US', 'WhatsApp', { skipCache: true });
    assert.ok(['virtual8', 'virtual18'].includes(result.operator));
});

// ── TEST 6: all operators out of stock → no free number, tier unavailable ──
test('TEST 6: all operators empty — tier reports unavailable, not a crash', async () => {
    const provider = mockProvider({ virtual1: 0, virtual2: 0, virtual8: 0, virtual18: 0 });
    const selector = new TierOperatorSelector([provider]);

    const result = await selector.hasTierStock('budget', 'US', 'WhatsApp');
    assert.equal(result.available, false);

    await assert.rejects(
        () => selector.selectOperator('budget', 'US', 'WhatsApp', { skipCache: true }),
        /NO_NUMBERS/
    );
});

// ── TEST 10: worked example from the ticket — Budget tier with a mix ──────
test('TEST 10 (ticket example): Budget = AVAILABLE because virtual8 and virtual18 have stock', async () => {
    const provider = mockProvider({
        virtual1: 0, virtual2: 0, virtual3: 0,
        virtual8: 5, virtual12: 0, virtual18: 2, virtual25: 0
    });
    const selector = new TierOperatorSelector([provider]);

    const result = await selector.hasTierStock('budget', 'US', 'WhatsApp');
    assert.equal(result.available, true);
    assert.equal(result.totalOperators, 2); // only virtual8 and virtual18 have stock
    assert.deepEqual(
        result.allOperators.map(o => o.operator).sort(),
        ['virtual18', 'virtual8']
    );
});

// ── getFallbackOperators must exclude the failed one and offer the rest ───
test('getFallbackOperators returns the OTHER same-tier, same-provider operator (not just cross-provider)', async () => {
    const provider = mockProvider({ virtual8: 5, virtual18: 2 });
    const selector = new TierOperatorSelector([provider]);

    const fallbacks = await selector.getFallbackOperators('budget', 'US', 'WhatsApp', 'virtual8');
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].operator, 'virtual18');
    assert.equal(fallbacks[0].providerKey, 'CHEAP_PANEL');
});

// ── forceRefresh bypasses the selector's own catalog cache ─────────────────
test('forceRefresh re-fetches the provider catalog instead of using the cached copy', async () => {
    let calls = 0;
    const provider = {
        name: 'CHEAP_PANEL',
        providerKey: 'CHEAP_PANEL',
        isActive: true,
        mapCountry: () => 'usa',
        mapService: () => 'whatsapp',
        getDisplayPrice: (p) => p + 0.10,
        getProducts: async () => {
            calls++;
            // First call: nothing in stock. Second (forced) call: virtual8 now has stock.
            const stock = calls === 1 ? 0 : 5;
            return { usa: { whatsapp: { virtual8: { Qty: stock, Price: 0.2 } } } };
        }
    };

    const selector = new TierOperatorSelector([provider]);

    const first = await selector.hasTierStock('budget', 'US', 'WhatsApp');
    assert.equal(first.available, false);
    assert.equal(calls, 1);

    // Without forceRefresh this would still hit the (60s) cache and calls would stay at 1.
    const fallbacks = await selector.getFallbackOperators('budget', 'US', 'WhatsApp', null, { forceRefresh: true });
    assert.equal(calls, 2);
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].operator, 'virtual8');
});
