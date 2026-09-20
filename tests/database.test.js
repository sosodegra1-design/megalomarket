import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-test-')), 'test.db');

const { db, logActivity } = await import('../src/db/database.js');

test('products can be inserted and read back', () => {
  const info = db
    .prepare('INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('SKU-1', 'Peluche renard', 'Une douce peluche', 8.5, Date.now());
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  assert.equal(product.sku, 'SKU-1');
  assert.equal(product.cost_price, 8.5);
});

test('channel_listings enforces one row per product/channel pair', () => {
  const productId = db
    .prepare('INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('SKU-2', 'Doudou lapin', '', 5, Date.now()).lastInsertRowid;

  db.prepare(
    'INSERT INTO channel_listings (product_id, channel, price, stock, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(productId, 'ebay', 12.9, 10, Date.now());

  assert.throws(() => {
    db.prepare(
      'INSERT INTO channel_listings (product_id, channel, price, stock, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(productId, 'ebay', 13.9, 5, Date.now());
  });
});

test('logActivity writes a retrievable row', () => {
  logActivity('TEST', 'ceci est un test');
  const row = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.kind, 'TEST');
});
