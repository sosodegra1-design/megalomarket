/*
 * Sauvegardes : exporter ses données, et pouvoir le prouver.
 *
 * Le point n'est pas de « faire une sauvegarde » — Turso assure déjà la
 * durabilité. Le point est de pouvoir SORTIR ses données : un fichier lisible,
 * sans dépendre d'un fournisseur, relisible dans six mois.
 *
 * Ce qui est verrouillé ici :
 *  - l'export est protégé par la clé (il contient des données clients) ;
 *  - il contient bien les tables essentielles, et on peut le vérifier ;
 *  - le mode inventaire ne transporte aucune donnée personnelle ;
 *  - un export incomplet est DÉTECTÉ, pas supposé complet.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-backup-')), 'backup.db');
const ADMIN_KEY = 'cle-de-test-backup';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase, dbRun } = await import('../src/db/database.js');
const { checkDumpCompleteness } = await import('../src/services/backup.js');

let server;
let base;

before(async () => {
  await initDatabase();
  await dbRun(
    "INSERT INTO products (sku, name, description, cost_price, created_at) VALUES ('BB-TEST', 'Produit de test', 'desc', 1.5, ?)",
    [Date.now()],
  );
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(path, { method = 'GET', headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: { 'X-Admin-Key': ADMIN_KEY, ...headers } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

/* ===================== PROTECTION ===================== */

test('l’export de sauvegarde est protégé par la clé', async () => {
  const response = await fetch(base + '/api/backup');
  assert.equal(response.status, 401, 'il contient des données clients : jamais sans clé');
});

/* ===================== CONTENU ===================== */

test('l’export contient les tables essentielles et leurs données', async () => {
  const { status, body } = await call('/api/backup');
  assert.equal(status, 200);
  assert.equal(body.format, 'megalomarket-backup');
  assert.ok(body.tableCount > 0);
  assert.ok(body.rowCount > 0);

  for (const table of ['imports', 'products', 'suppliers', 'import_listings']) {
    assert.ok(Array.isArray(body.data[table]), `la table ${table} doit être présente`);
  }
  const produit = body.data.products.find((p) => p.sku === 'BB-TEST');
  assert.ok(produit, 'les données elles-mêmes sont exportées, pas seulement le schéma');
});

test('l’export est proposé en téléchargement, avec un nom daté', async () => {
  const { headers } = await call('/api/backup');
  const disposition = headers.get('content-disposition') || '';
  assert.match(disposition, /attachment/);
  assert.match(disposition, /megalomarket-sauvegarde-\d{4}-\d{2}-\d{2}\.json/);
});

test('le mode inventaire ne transporte AUCUNE donnée personnelle', async () => {
  const { status, body } = await call('/api/backup?meta=1');
  assert.equal(status, 200);
  assert.ok(body.counts, 'les comptes par table sont là');
  assert.ok(body.data === undefined, 'aucune donnée brute : on peut vérifier sans exporter');
  assert.ok(body.controle.complete, 'et le contrôle dit si la sauvegarde est complète');
});

/* ===================== DÉTECTION D'UN EXPORT INCOMPLET ===================== */

test('un export auquel il manque une table est signalé incomplet', () => {
  // Le piège classique : une sauvegarde qui « marche » mais n'a pas tout pris.
  // On ne s'en aperçoit qu'au moment de restaurer, c'est-à-dire trop tard.
  const partiel = { counts: { products: 3, imports: 1 }, rowCount: 4 };
  const controle = checkDumpCompleteness(partiel, { required: ['products', 'imports', 'suppliers'] });
  assert.equal(controle.complete, false);
  assert.deepEqual(controle.missing, ['suppliers']);
});

test('un export complet est reconnu comme tel', () => {
  const complet = { counts: { products: 1, imports: 1, suppliers: 1, import_listings: 1 }, rowCount: 4 };
  assert.equal(checkDumpCompleteness(complet).complete, true);
});
