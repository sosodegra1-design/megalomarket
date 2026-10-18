import { test } from 'node:test';
import assert from 'node:assert/strict';

const lumivita = await import('../src/connectors/lumivita.js');
const ownSite = await import('../src/connectors/ownSite.js');
const amazon = await import('../src/connectors/amazon.js');
const tiktokShop = await import('../src/connectors/tiktokShop.js');
const allegro = await import('../src/connectors/allegro.js');

test('lumivita connector lists the six catalogue products without inventing a price', async () => {
  assert.equal(lumivita.isConfigured(), true);
  const products = await lumivita.listProducts();
  assert.equal(products.length, 6);
  assert.deepEqual(products.map((p) => p.sku), ['LV-001', 'LV-002', 'LV-003', 'LV-004', 'LV-005', 'LV-006']);
  assert.ok(products.every((p) => !('price' in p)), 'le catalogue n’a aucun prix : rien n’est inventé');
});

test('lumivita connector has no stock and no orders, and refuses every write', async () => {
  assert.deepEqual(await lumivita.listInventoryItems(), []);
  assert.deepEqual(await lumivita.listOrders(), []);
  await assert.rejects(() => lumivita.createListing({}), /lecture seule/);
  await assert.rejects(() => lumivita.updateOfferPrice('LV-001', 10), /lecture seule/);
  await assert.rejects(() => lumivita.deleteListing('LV-001'), /lecture seule/);
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

test('allegro connector clearly reports pending status', async () => {
  await assert.rejects(() => allegro.listOrders(), /pas encore actif/);
});

test('allegro connector rejects publication attempts while unconfigured', async () => {
  await assert.rejects(() => allegro.createListing({}), /pas encore actif/);
});
