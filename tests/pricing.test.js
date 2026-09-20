import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSuggestedPrice } from '../src/importer/pricing.js';

test('applies the margin coefficient and fixed fee', () => {
  const price = computeSuggestedPrice(10, { marginCoefficient: 2, fixedFee: 1 });
  assert.equal(price, 21); // 10*2 + 1
});

test('never goes below purchase price + fixed fee, even with a coefficient near 1', () => {
  const price = computeSuggestedPrice(10, { marginCoefficient: 1.01, fixedFee: 5 });
  assert.equal(price, 15.1);
});

test('rejects a negative purchase price', () => {
  assert.throws(() => computeSuggestedPrice(-5, { marginCoefficient: 1.8 }));
});

test('rejects a margin coefficient of 1 or less', () => {
  assert.throws(() => computeSuggestedPrice(10, { marginCoefficient: 1 }));
});
