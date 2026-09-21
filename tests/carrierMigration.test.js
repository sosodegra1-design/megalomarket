/*
 * Migration : le type `transporteur` sur une base créée avant lui.
 *
 * `suppliers` est la première table PARENT que ce projet reconstruit : `imports`
 * s'y rattache par `supplier_id … ON DELETE SET NULL`. Or `DROP TABLE` exécute
 * une suppression implicite, qui DÉCLENCHE cette action et détacherait les
 * imports — alors même que les ids sont recopiés à l'identique. Ce test rejoue
 * le cas réel (ancien CHECK à deux valeurs, un fournisseur, un distributeur, et
 * un import rattaché à chacun) et vérifie que la reconstruction :
 *
 *   - accepte le troisième type ;
 *   - conserve chaque ligne avec son id et TOUS ses champs ;
 *   - laisse `imports.supplier_id` pointer sur le même partenaire ;
 *   - ne s'exécute qu'une fois, et garde la contrainte stricte pour le reste.
 *
 * Aucun réseau : la base est un fichier temporaire, comme les autres tests de
 * migration.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-carrier-migration-')), 'legacy.db');

const { client, initDatabase, dbAll, dbGet, dbRun } = await import('../src/db/database.js');

/* Ancienne définition : la contrainte ne connaissait que deux types. La table
   imports, elle, est déjà à la forme actuelle (colonne supplier_id présente) —
   c'est l'état exact d'une base de production juste avant ce changement. */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('fournisseur', 'distributeur')),
  name TEXT NOT NULL,
  site_url TEXT,
  margin_coefficient REAL,
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'inactif')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
`;

let fournisseurId;
let distributeurId;
let importFournisseurId;
let importDistributeurId;

before(async () => {
  await client.executeMultiple(LEGACY_SCHEMA);

  const now = new Date().toISOString();
  const fournisseur = await dbRun(
    `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
     VALUES ('fournisseur', 'Fournisseur historique', 'https://gros.example.com', 3.2, 'actif', 'marge négociée', ?, ?)`,
    [now, now],
  );
  fournisseurId = fournisseur.lastInsertRowid;

  const distributeur = await dbRun(
    `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
     VALUES ('distributeur', 'Distributeur historique', NULL, NULL, 'inactif', NULL, ?, ?)`,
    [now, now],
  );
  distributeurId = distributeur.lastInsertRowid;

  const importFournisseur = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id, created_at)
     VALUES (?, 'alibaba', 'Import du fournisseur', 'desc', 4.5, 'USD', '[]', 'brouillon', ?, ?)`,
    ['https://www.alibaba.com/item/1.html', fournisseurId, Date.now()],
  );
  importFournisseurId = importFournisseur.lastInsertRowid;

  const importDistributeur = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id, created_at)
     VALUES (?, 'bigbuy', 'Import du distributeur', 'desc', 9.9, 'EUR', '[]', 'pret', ?, ?)`,
    ['https://www.bigbuy.eu/item/2.html', distributeurId, Date.now()],
  );
  importDistributeurId = importDistributeur.lastInsertRowid;

  // Avant migration : le troisième type doit être refusé.
  await assert.rejects(
    () => dbRun(
      `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
       VALUES ('transporteur', 'DHL Express', 'https://www.dhl.com', 1.5, 'actif', NULL, ?, ?)`,
      [now, now],
    ),
    /CHECK constraint failed/,
  );

  await initDatabase();
});

after(async () => {
  await client.close();
});

test('après migration, transporteur est accepté', async () => {
  const info = await dbRun(
    `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
     VALUES ('transporteur', 'DHL Express', 'https://www.dhl.com', 1.5, 'actif', 'Express international', ?, ?)`,
    [new Date().toISOString(), new Date().toISOString()],
  );
  assert.ok(info.changes > 0, 'le type transporteur doit désormais passer le CHECK');
});

test('chaque partenaire existant survit avec son id et tous ses champs', async () => {
  const fournisseur = await dbGet('SELECT * FROM suppliers WHERE id = ?', [fournisseurId]);
  assert.ok(fournisseur, 'le fournisseur historique doit exister');
  assert.equal(fournisseur.kind, 'fournisseur');
  assert.equal(fournisseur.name, 'Fournisseur historique');
  assert.equal(fournisseur.site_url, 'https://gros.example.com');
  assert.equal(fournisseur.margin_coefficient, 3.2, 'la marge négociée est recopiée telle quelle');
  assert.equal(fournisseur.status, 'actif');
  assert.equal(fournisseur.notes, 'marge négociée');
  assert.ok(fournisseur.created_at, 'created_at conservé');

  const distributeur = await dbGet('SELECT * FROM suppliers WHERE id = ?', [distributeurId]);
  assert.ok(distributeur, 'le distributeur historique doit exister');
  assert.equal(distributeur.kind, 'distributeur');
  assert.equal(distributeur.name, 'Distributeur historique');
  assert.equal(distributeur.site_url, null, 'un site NULL le reste');
  assert.equal(distributeur.margin_coefficient, null, 'une marge NULL le reste');
  assert.equal(distributeur.status, 'inactif', 'un statut inactif le reste');
});

test("imports.supplier_id pointe toujours sur le même partenaire : le DROP ne l'a pas détaché", async () => {
  const importFournisseur = await dbGet('SELECT * FROM imports WHERE id = ?', [importFournisseurId]);
  assert.ok(importFournisseur, "l'import est conservé");
  assert.equal(importFournisseur.supplier_id, fournisseurId, 'le lien vers le fournisseur est intact, pas NULL');
  assert.equal(importFournisseur.title, 'Import du fournisseur');

  const importDistributeur = await dbGet('SELECT * FROM imports WHERE id = ?', [importDistributeurId]);
  assert.equal(importDistributeur.supplier_id, distributeurId, 'le lien vers le distributeur est intact, pas NULL');

  // Aucun import détaché : c'est exactement ce que la suppression implicite de
  // DROP TABLE aurait provoqué sans les précautions de migrateSuppliersKinds.
  const detached = await dbAll('SELECT id FROM imports WHERE supplier_id IS NULL');
  assert.deepEqual(detached, [], 'aucun import ne doit avoir perdu son partenaire');
});

test('rejouer initDatabase ne reconstruit pas une seconde fois', async () => {
  const before = await dbAll('SELECT id, name, kind FROM suppliers ORDER BY id');
  await initDatabase();
  await initDatabase();

  const after = await dbAll('SELECT id, name, kind FROM suppliers ORDER BY id');
  assert.deepEqual(after, before, 'aucune ligne perdue ni dupliquée');

  const table = await dbGet("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'suppliers'");
  assert.ok(table.sql.includes('transporteur'), 'la nouvelle contrainte est en place');
  assert.equal(table.sql.includes('_migrated'), false, 'aucune table temporaire ne subsiste');

  const leftovers = await dbAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_migrated'");
  assert.deepEqual(leftovers, [], 'pas de table temporaire laissée derrière');
});

test('les liens imports → partenaires survivent à des initDatabase répétés', async () => {
  const importFournisseur = await dbGet('SELECT supplier_id FROM imports WHERE id = ?', [importFournisseurId]);
  assert.equal(importFournisseur.supplier_id, fournisseurId);
});

test('la contrainte reste stricte pour un type inconnu', async () => {
  await assert.rejects(
    () => dbRun(
      `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
       VALUES ('grossiste', 'Type inconnu', NULL, 2.0, 'actif', NULL, ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    ),
    /CHECK constraint failed/,
    'élargir la liste ne doit pas supprimer le contrôle',
  );
});

test('la clé étrangère imports.supplier_id reste appliquée après la reconstruction', async () => {
  await assert.rejects(
    () => dbRun(
      `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id, created_at)
       VALUES ('https://exemple.com/x', 'aliexpress', 'Partenaire fantôme', '', 1, 'USD', '[]', 'brouillon', 999999, ?)`,
      [Date.now()],
    ),
    /FOREIGN KEY constraint failed/,
    'PRAGMA foreign_keys=ON doit être rétabli après la reconstruction',
  );
});
