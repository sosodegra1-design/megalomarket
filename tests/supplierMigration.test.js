/*
 * Migration : `imports.supplier_id` sur une base créée avant les partenaires.
 *
 * `CREATE TABLE IF NOT EXISTS` ne touche pas une table déjà existante : une base
 * qui tournait avant l'arrivée du registre n'aurait jamais reçu la colonne, et
 * chaque import échouerait ensuite sur un « no such column: supplier_id ». On
 * rejoue donc le cas réel — une table imports à l'ancienne, avec une ligne
 * dedans — et on vérifie que l'ALTER est appliqué une fois, sans rien perdre et
 * sans échouer au second démarrage (c'est tout l'intérêt du garde-fou).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-supplier-migration-')), 'legacy.db');

const { client, initDatabase, dbAll, dbGet, dbRun } = await import('../src/db/database.js');

/* Ancienne table imports : aucun supplier_id. */
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
`;

before(async () => {
  await client.executeMultiple(LEGACY_SCHEMA);
  await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, 'aliexpress', 'Import historique', 'desc', 4.5, 'USD', '[]', 'brouillon', ?)`,
    ['https://www.aliexpress.com/item/1.html', Date.now()],
  );
});

after(async () => {
  await client.close();
});

test('la colonne supplier_id est ajoutée à une table imports existante', async () => {
  await initDatabase();

  const columns = (await dbAll('PRAGMA table_info(imports)')).map((column) => column.name);
  assert.ok(columns.includes('supplier_id'), 'la base existante doit recevoir supplier_id');

  const row = await dbGet('SELECT * FROM imports WHERE id = 1');
  assert.equal(row.title, 'Import historique', 'la ligne existante est conservée');
  assert.equal(row.supplier_id, null, 'une colonne ajoutée arrive à NULL');
});

test('un partenaire peut ensuite être rattaché à un import existant', async () => {
  const now = new Date().toISOString();
  const info = await dbRun(
    `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
     VALUES ('fournisseur', 'Partenaire migré', NULL, 2.2, 'actif', NULL, ?, ?)`,
    [now, now],
  );
  await dbRun('UPDATE imports SET supplier_id = ? WHERE id = 1', [info.lastInsertRowid]);

  const row = await dbGet('SELECT supplier_id FROM imports WHERE id = 1');
  assert.equal(row.supplier_id, info.lastInsertRowid);
});

test('rejouer initDatabase ne tente pas un second ALTER', async () => {
  await initDatabase();
  await initDatabase();
  const columns = (await dbAll('PRAGMA table_info(imports)')).map((column) => column.name);
  assert.equal(columns.filter((name) => name === 'supplier_id').length, 1, 'une seule colonne supplier_id');
});
