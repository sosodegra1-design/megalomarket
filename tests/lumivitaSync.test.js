import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-lumivita-')), 'lumivita.db');
const ADMIN_KEY = 'cle-de-test-lumivita-0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase, dbAll, dbGet, dbRun } = await import('../src/db/database.js');

let server;
let base;
const call = async (path, method = 'GET') => {
  const response = await fetch(base + path, { method, headers: { 'X-Admin-Key': ADMIN_KEY } });
  return { status: response.status, body: await response.json() };
};

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

test('the LumiVita catalogue is readable through the API', async () => {
  const { status, body } = await call('/api/lumivita/products');
  assert.equal(status, 200);
  assert.equal(body.length, 6);
});

test('sync inscribes the six products with a zero cost price and a paused lumivita listing', async () => {
  const { status, body } = await call('/api/lumivita/sync', 'POST');
  assert.equal(status, 200);
  assert.deepEqual(body, { created: 6, existing: 0, total: 6 });

  const products = await dbAll("SELECT sku, cost_price FROM products WHERE sku LIKE 'LV-%' ORDER BY sku");
  assert.equal(products.length, 6);
  assert.ok(products.every((p) => p.cost_price === 0), 'aucun prix d’achat inventé');
  const listings = await dbAll("SELECT status, price FROM channel_listings WHERE channel = 'lumivita'");
  assert.equal(listings.length, 6);
  assert.ok(listings.every((l) => l.status === 'paused' && l.price === 0));
});

test('sync is idempotent and never overwrites a cost price already entered', async () => {
  await dbRun("UPDATE products SET cost_price = 42 WHERE sku = 'LV-001'");
  const { body } = await call('/api/lumivita/sync', 'POST');
  assert.deepEqual(body, { created: 0, existing: 6, total: 6 });
  assert.equal((await dbGet("SELECT cost_price FROM products WHERE sku = 'LV-001'")).cost_price, 42);
  assert.equal((await dbAll("SELECT id FROM channel_listings WHERE channel = 'lumivita'")).length, 6);
});
