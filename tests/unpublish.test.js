/*
 * DELETE /api/imports/:id/listings/:marketplace/publish — retire une fiche
 * déjà publiée (src/importer/publisher.js unpublishListing).
 *
 * own_site.deleteListing existait déjà côté connecteur mais n'était appelé
 * nulle part : ces tests verrouillent le nouveau chemin qui le déclenche, et
 * le fait qu'un canal sans deleteListing (ex. eBay aujourd'hui) échoue
 * proprement plutôt que de planter.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-unpublish-')), 'unpublish.db');
const ADMIN_KEY = 'cle-de-test-unpublish';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OWN_SITE_API_URL = 'https://bbhappy.example.com/';
process.env.OWN_SITE_API_KEY = 'site-admin-key';

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbGet } = await import('../src/db/database.js');

let server;
let base;

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

/*
 * N'intercepte QUE l'appel sortant vers le site propre (bbhappy.example.com) :
 * `call()` ci-dessus utilise lui aussi `fetch` pour joindre le serveur local
 * de test, et un stub inconditionnel avalerait les deux appels au lieu du
 * seul appel réseau qu'on veut simuler — même piège que pour l'IA.
 */
function stubSiteFetch({ status = 204 } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    if (!String(url).includes('bbhappy.example.com')) return original(url, options);
    calls.push({ url: String(url), method: options.method || 'GET' });
    return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => '' };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

async function createImportWithListing({ marketplace = 'own_site', status = 'publie', externalId = 'p13' } = {}) {
  const imp = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 'pret', ?)`,
    ['https://supplier.example/item/1.html', 'aliexpress', 'Peluche renard', 'Douce peluche', 4.9, 'USD', Date.now()],
  );
  const listing = await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, published_external_id, created_at, updated_at)
     VALUES (?, ?, 'Peluche renard', 'Description', 9.9, ?, ?, ?, ?)`,
    [imp.lastInsertRowid, marketplace, status, status === 'publie' ? externalId : null, Date.now(), Date.now()],
  );
  return { importId: imp.lastInsertRowid, listingId: listing.lastInsertRowid };
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

test('unpublishing a listing calls the connector and resets it to "valide"', async () => {
  const { importId } = await createImportWithListing();
  const stub = stubSiteFetch();
  let result;
  try {
    result = await call(`/api/imports/${importId}/listings/own_site/publish`, { method: 'DELETE' });
  } finally {
    stub.restore();
  }

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, 'https://bbhappy.example.com/api/admin/products/p13');
  assert.equal(stub.calls[0].method, 'DELETE');

  const row = await dbGet(
    'SELECT il.* FROM import_listings il JOIN imports i ON i.id = il.import_id WHERE i.id = ? AND il.marketplace = ?',
    [importId, 'own_site'],
  );
  assert.equal(row.status, 'valide');
  assert.equal(row.published_external_id, null);
});

test('unpublishing a listing that is not published is refused', async () => {
  const { importId } = await createImportWithListing({ status: 'valide' });
  const { status, body } = await call(`/api/imports/${importId}/listings/own_site/publish`, { method: 'DELETE' });
  assert.equal(status, 400);
  assert.match(body.error, /n'est pas publiée/);
});

test('unpublishing on a channel without deleteListing (eBay today) fails clearly, not silently', async () => {
  const { importId } = await createImportWithListing({ marketplace: 'ebay', externalId: 'offer-1' });
  const { status, body } = await call(`/api/imports/${importId}/listings/ebay/publish`, { method: 'DELETE' });
  assert.equal(status, 400);
  assert.match(body.error, /non supporté/);
});

test('unpublishing an unknown listing is refused', async () => {
  const { status, body } = await call('/api/imports/999999/listings/own_site/publish', { method: 'DELETE' });
  assert.equal(status, 400);
  assert.match(body.error, /introuvable/);
});
