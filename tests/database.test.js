import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-test-')), 'test.db');

const { dbAll, dbGet, dbRun, initDatabase, logActivity } = await import('../src/db/database.js');
await initDatabase();

test('products can be inserted and read back', async () => {
  const info = await dbRun(
    'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)',
    ['SKU-1', 'Peluche renard', 'Une douce peluche', 8.5, Date.now()],
  );
  const product = await dbGet('SELECT * FROM products WHERE id = ?', [info.lastInsertRowid]);
  assert.equal(product.sku, 'SKU-1');
  assert.equal(product.cost_price, 8.5);
});

test('channel_listings enforces one row per product/channel pair', async () => {
  const info = await dbRun(
    'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)',
    ['SKU-2', 'Doudou lapin', '', 5, Date.now()],
  );
  const productId = info.lastInsertRowid;

  await dbRun(
    'INSERT INTO channel_listings (product_id, channel, price, stock, updated_at) VALUES (?, ?, ?, ?, ?)',
    [productId, 'ebay', 12.9, 10, Date.now()],
  );

  await assert.rejects(() =>
    dbRun(
      'INSERT INTO channel_listings (product_id, channel, price, stock, updated_at) VALUES (?, ?, ?, ?, ?)',
      [productId, 'ebay', 13.9, 5, Date.now()],
    ),
  );
});

test('logActivity writes a retrievable row', async () => {
  await logActivity('TEST', 'ceci est un test');
  const rows = await dbAll('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1');
  assert.equal(rows[0].kind, 'TEST');
});
