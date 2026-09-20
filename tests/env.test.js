import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.EBAY_APP_ID = 'x';
process.env.EBAY_CERT_ID = 'x';
// EBAY_DEV_ID and EBAY_REFRESH_TOKEN intentionally left unset

const { config } = await import('../src/config/env.js');

test('ebay.ready is false when required keys are missing', () => {
  assert.equal(config.ebay.ready, false);
});

test('amazon.ready is false with no keys configured', () => {
  assert.equal(config.amazon.ready, false);
});

test('config exposes a default port', () => {
  assert.equal(typeof config.port, 'number');
});
