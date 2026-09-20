import { test } from 'node:test';
import assert from 'node:assert/strict';

const ebay = await import('../src/connectors/ebay.js');
const ownSite = await import('../src/connectors/ownSite.js');
const amazon = await import('../src/connectors/amazon.js');
const tiktokShop = await import('../src/connectors/tiktokShop.js');

test('ebay connector reports not configured without credentials', () => {
  assert.equal(ebay.isConfigured(), false);
});

test('ebay connector throws a clear error when used unconfigured', async () => {
  await assert.rejects(() => ebay.listOrders(), /non configuré/);
});

test('own site connector throws a clear error when used unconfigured', async () => {
  await assert.rejects(() => ownSite.listProducts(), /non configuré/);
});

test('amazon connector clearly reports pending status', async () => {
  await assert.rejects(() => amazon.listOrders(), /pas encore actif/);
});

test('tiktok shop connector clearly reports pending status', async () => {
  await assert.rejects(() => tiktokShop.listOrders(), /pas encore actif/);
});
