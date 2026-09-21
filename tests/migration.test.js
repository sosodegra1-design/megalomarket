/* Les contraintes CHECK ne peuvent pas être modifiées en place en SQLite :
 * autoriser le canal `own_site` dans import_listings, et `allegro` dans
 * channel_listings, impose de reconstruire ces tables.
 * Ce test rejoue le cas réel — une base créée avec l'ancien schéma, contenant
 * déjà des données — pour vérifier que les migrations s'appliquent sans rien
 * perdre ni affaiblir les contraintes existantes.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-migration-')), 'legacy.db');

const { client, initDatabase, dbAll, dbGet, dbRun } = await import('../src/db/database.js');

const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  source_site TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_description TEXT NOT NULL DEFAULT '',
  purchase_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  image_urls TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'brouillon' CHECK (status IN ('brouillon', 'pret')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS import_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('amazon', 'tiktok_shop', 'allegro', 'ebay')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggested_price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'a_valider' CHECK (status IN ('a_valider', 'valide', 'publie', 'echec')),
  published_external_id TEXT,
  publish_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (import_id, marketplace)
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cost_price REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

/* Ancienne définition : la contrainte ne connaissait pas encore allegro. */
CREATE TABLE IF NOT EXISTS channel_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('ebay', 'own_site', 'amazon', 'tiktok_shop')),
  external_id TEXT,
  price REAL NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  stock INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'out_of_stock')),
  updated_at INTEGER NOT NULL,
  UNIQUE (product_id, channel)
);
`;

before(async () => {
  // Base « legacy » : ancien schéma, avec une fiche déjà enregistrée.
  await client.executeMultiple(LEGACY_SCHEMA);
  await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, 'aliexpress', 'Produit existant', 'desc', 4.5, 'USD', '["https://x/1.jpg"]', 'brouillon', ?)`,
    ['https://www.aliexpress.com/item/1.html', Date.now()],
  );
  await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, created_at, updated_at)
     VALUES (1, 'ebay', 'Ancienne fiche', 'ancienne description', 12.9, 'valide', ?, ?)`,
    [Date.now(), Date.now()],
  );

  // Avant migration : le canal own_site doit être refusé.
  await assert.rejects(
    () => dbRun(
      `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, created_at, updated_at)
       VALUES (1, 'own_site', 'x', 'y', 1, ?, ?)`,
      [Date.now(), Date.now()],
    ),
    /CHECK constraint failed/,
  );

  // Une ligne de channel_listings préexiste : elle doit survivre à la
  // reconstruction de la table.
  await dbRun(
    'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)',
    ['SKU-LEGACY', 'Produit existant', '', 5, Date.now()],
  );
  await dbRun(
    `INSERT INTO channel_listings (product_id, channel, external_id, price, stock, updated_at)
     VALUES (1, 'ebay', 'EXT-1', 19.9, 4, ?)`,
    [Date.now()],
  );

  // Avant migration : allegro doit être refusé dans channel_listings.
  await assert.rejects(
    () => dbRun(
      `INSERT INTO channel_listings (product_id, channel, price, stock, updated_at)
       VALUES (1, 'allegro', 1, 0, ?)`,
      [Date.now()],
    ),
    /CHECK constraint failed/,
  );
});

after(async () => {
  await client.close();
});

test('the migration rebuilds import_listings and preserves existing rows', async () => {
  await initDatabase();

  const rows = await dbAll('SELECT * FROM import_listings ORDER BY id');
  assert.equal(rows.length, 1, 'la fiche existante est conservée');
  assert.equal(rows[0].marketplace, 'ebay');
  assert.equal(rows[0].title, 'Ancienne fiche');
  assert.equal(rows[0].suggested_price, 12.9);
  assert.equal(rows[0].status, 'valide');
  assert.equal(rows[0].site_payload, null, 'la nouvelle colonne arrive à NULL');
});

test('after the migration the own_site channel is accepted', async () => {
  const info = await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, site_payload, created_at, updated_at)
     VALUES (1, 'own_site', 'Fiche site', 'description site', 9.9, '{"category":"jouets"}', ?, ?)`,
    [Date.now(), Date.now()],
  );
  assert.ok(info.changes > 0);
  const row = await dbGet('SELECT site_payload FROM import_listings WHERE marketplace = ?', ['own_site']);
  assert.equal(JSON.parse(row.site_payload).category, 'jouets');
});

test('the UNIQUE(import_id, marketplace) constraint survives the rebuild', async () => {
  await assert.rejects(
    () => dbRun(
      `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, created_at, updated_at)
       VALUES (1, 'ebay', 'doublon', 'x', 1, ?, ?)`,
      [Date.now(), Date.now()],
    ),
    /UNIQUE constraint failed/,
  );
});

test('running initDatabase again is a no-op, not a second rebuild', async () => {
  await initDatabase();
  await initDatabase();
  const rows = await dbAll('SELECT id FROM import_listings ORDER BY id');
  assert.equal(rows.length, 2, 'aucune ligne perdue ni dupliquée');
  const table = await dbGet("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_listings'");
  assert.equal(table.sql.includes('own_site'), true);
  assert.equal(table.sql.includes('site_payload'), true);
});

test('the other tables are created alongside and stay usable', async () => {
  await dbRun(
    'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)',
    ['SKU-MIG', 'Produit', '', 5, Date.now()],
  );
  const product = await dbGet('SELECT id FROM products WHERE sku = ?', ['SKU-MIG']);
  assert.ok(product.id);
  await dbRun(
    'INSERT INTO channel_listings (product_id, channel, price, stock, updated_at) VALUES (?, ?, ?, ?, ?)',
    [product.id, 'own_site', 12.9, 0, Date.now()],
  );
});

test('channel_listings keeps its rows and now accepts allegro', async () => {
  const rows = await dbAll('SELECT * FROM channel_listings WHERE channel = ?', ['ebay']);
  assert.equal(rows.length, 1, 'la ligne existante est conservée');
  assert.equal(rows[0].external_id, 'EXT-1');
  assert.equal(rows[0].price, 19.9);
  assert.equal(rows[0].stock, 4);

  // Le registre des connecteurs expose allegro et import_listings l'acceptait
  // déjà : sans cette migration, chaque synchronisation de stock aurait échoué
  // sur cette contrainte dès qu'Allegro serait configuré.
  const info = await dbRun(
    'INSERT INTO channel_listings (product_id, channel, price, stock, updated_at) VALUES (?, ?, ?, ?, ?)',
    [1, 'allegro', 24.9, 3, Date.now()],
  );
  assert.ok(info.changes > 0, 'allegro est désormais accepté');

  await assert.rejects(
    () => dbRun(
      'INSERT INTO channel_listings (product_id, channel, price, stock, updated_at) VALUES (?, ?, ?, ?, ?)',
      [1, 'allegro', 30, 1, Date.now()],
    ),
    /UNIQUE constraint failed/,
    'UNIQUE(product_id, channel) doit survivre à la reconstruction',
  );
});

test('both rebuilt tables carry the widened constraint, with no leftovers', async () => {
  for (const [table, marker] of [['import_listings', 'own_site'], ['channel_listings', 'allegro']]) {
    const row = await dbGet("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    assert.ok(row.sql.includes(marker), `${table} doit accepter ${marker}`);
    assert.equal(row.sql.includes('_migrated'), false, `${table} ne doit pas rester une table temporaire`);
  }

  const tables = await dbAll("SELECT name FROM sqlite_master WHERE type = 'table'");
  assert.deepEqual(
    tables.map((t) => t.name).filter((name) => name.endsWith('_migrated')),
    [],
  );
});
