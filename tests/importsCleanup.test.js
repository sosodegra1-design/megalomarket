/*
 * GET /api/imports/cleanup/preview + DELETE /api/imports/cleanup.
 *
 * Nettoyage groupé des imports CASSÉS (une fiche en échec de publication) ou
 * EN ATTENTE (jamais sortis du brouillon) — demandé après un import réel
 * pollué par des extractions ratées. Le garde-fou le plus important : un
 * import qui porte, par ailleurs, une fiche déjà PUBLIÉE doit toujours être
 * épargné, même s'il a aussi une fiche en échec sur un autre canal — sinon on
 * perdrait le seul lien permettant de dépublier cet article plus tard.
 *
 * Aucun réseau : le serveur Express est écouté sur un port éphémère.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-imports-cleanup-')), 'imports.db');
const ADMIN_KEY = 'cle-de-test-imports-cleanup';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbGet } = await import('../src/db/database.js');

let server;
let base;

async function call(path, { method = 'GET' } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'X-Admin-Key': ADMIN_KEY },
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

async function createImport({ title, status = 'brouillon' }) {
  const info = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['https://supplier.example/item.html', 'aliexpress', title, 'desc', 9.9, 'USD', '[]', status, Date.now()],
  );
  return info.lastInsertRowid;
}

async function createListing(importId, { marketplace, status }) {
  await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [importId, marketplace, 'titre', 'description', 19.9, status, Date.now(), Date.now()],
  );
}

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('preview and cleanup pick up a pending import (still brouillon) and a broken one (fiche en échec)', async () => {
  const pendingId = await createImport({ title: 'Import jamais terminé' });
  const brokenId = await createImport({ title: 'Import cassé', status: 'pret' });
  await createListing(brokenId, { marketplace: 'ebay', status: 'echec' });
  const healthyId = await createImport({ title: 'Import sain', status: 'pret' });
  await createListing(healthyId, { marketplace: 'ebay', status: 'valide' });

  const preview = await call('/api/imports/cleanup/preview');
  assert.equal(preview.status, 200);
  const previewIds = preview.body.imports.map((i) => i.id).sort();
  assert.deepEqual(previewIds, [pendingId, brokenId].sort(), 'seuls le brouillon et le cassé sont candidats');

  const cleanup = await call('/api/imports/cleanup', { method: 'DELETE' });
  assert.equal(cleanup.status, 200);
  assert.equal(cleanup.body.deleted, 2);
  assert.ok(cleanup.body.titles.includes('Import jamais terminé'));
  assert.ok(cleanup.body.titles.includes('Import cassé'));

  assert.equal(await dbGet('SELECT id FROM imports WHERE id = ?', [pendingId]), undefined);
  assert.equal(await dbGet('SELECT id FROM imports WHERE id = ?', [brokenId]), undefined);
  assert.ok(await dbGet('SELECT id FROM imports WHERE id = ?', [healthyId]), 'un import sain ne doit jamais être touché');
});

test('an import with a published listing is always spared, even if it is also broken or still pending', async () => {
  const publishedButBrokenId = await createImport({ title: 'Publié ailleurs, cassé sur un autre canal', status: 'pret' });
  await createListing(publishedButBrokenId, { marketplace: 'ebay', status: 'publie' });
  await createListing(publishedButBrokenId, { marketplace: 'amazon', status: 'echec' });

  const stillPendingButPublishedId = await createImport({ title: 'Publié malgré le statut brouillon' });
  await createListing(stillPendingButPublishedId, { marketplace: 'own_site', status: 'publie' });

  const preview = await call('/api/imports/cleanup/preview');
  const previewIds = preview.body.imports.map((i) => i.id);
  assert.ok(!previewIds.includes(publishedButBrokenId), 'une fiche publiée protège tout l\'import, même avec un échec ailleurs');
  assert.ok(!previewIds.includes(stillPendingButPublishedId));

  const cleanup = await call('/api/imports/cleanup', { method: 'DELETE' });
  assert.equal(cleanup.body.deleted, 0);
  assert.ok(await dbGet('SELECT id FROM imports WHERE id = ?', [publishedButBrokenId]));
  assert.ok(await dbGet('SELECT id FROM imports WHERE id = ?', [stillPendingButPublishedId]));
});

test('an empty catalogue reports nothing to delete instead of erroring', async () => {
  await dbRun('DELETE FROM import_listings');
  await dbRun('DELETE FROM imports');

  const preview = await call('/api/imports/cleanup/preview');
  assert.deepEqual(preview.body.imports, []);

  const cleanup = await call('/api/imports/cleanup', { method: 'DELETE' });
  assert.equal(cleanup.status, 200);
  assert.equal(cleanup.body.deleted, 0);
  assert.deepEqual(cleanup.body.titles, []);
});
