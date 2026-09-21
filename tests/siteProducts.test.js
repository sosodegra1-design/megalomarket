/*
 * GET/DELETE /api/site/products — catalogue du site propre indépendamment de
 * Megalomarket. Un produit déjà en ligne avant l'import (ou ajouté
 * directement sur le site) n'a pas de fiche import_listings : ces routes
 * doivent pouvoir le retrouver et le retirer quand même, en s'appuyant
 * directement sur ownSite.listProducts()/deleteListing() (déjà réels).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-site-products-')), 'site.db');
const ADMIN_KEY = 'cle-de-test-site-products';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OWN_SITE_API_URL = 'https://bbhappy.example.com/';
process.env.OWN_SITE_API_KEY = 'site-admin-key';

const { app } = await import('../src/server.js');
const { initDatabase } = await import('../src/db/database.js');

let server;
let base;

async function call(path, { method = 'GET' } = {}) {
  const response = await fetch(base + path, { method, headers: { 'X-Admin-Key': ADMIN_KEY } });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

/* N'intercepte QUE l'appel sortant vers le site propre — `call()` utilise
   aussi `fetch` pour joindre le serveur local de test. */
function stubSiteFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    if (!String(url).includes('bbhappy.example.com')) return original(url, options);
    const call = { url: String(url), method: options.method || 'GET' };
    calls.push(call);
    const result = handler(call) || {};
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.json ?? {},
      text: async () => result.text ?? JSON.stringify(result.json ?? {}),
    };
  };
  return { calls, restore: () => { global.fetch = original; } };
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

test('lists the real site catalogue, including products never touched by Megalomarket', async () => {
  const stub = stubSiteFetch(() => ({ json: [{ id: 'p1', name: 'Camion' }, { id: 'bj4', name: 'Collier' }] }));
  let result;
  try {
    result = await call('/api/site/products');
  } finally {
    stub.restore();
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 2);
  assert.equal(stub.calls[0].url, 'https://bbhappy.example.com/api/products');
});

test('deleting a product calls the site DELETE route with that exact id', async () => {
  const stub = stubSiteFetch(() => ({ status: 204 }));
  let result;
  try {
    result = await call('/api/site/products/p13', { method: 'DELETE' });
  } finally {
    stub.restore();
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, 'https://bbhappy.example.com/api/admin/products/p13');
  assert.equal(stub.calls[0].method, 'DELETE');
});

test('a site error (e.g. unknown id) surfaces to the caller instead of a false success', async () => {
  const stub = stubSiteFetch(() => ({ status: 404, text: '{"error":"Product not found"}' }));
  let result;
  try {
    result = await call('/api/site/products/does-not-exist', { method: 'DELETE' });
  } finally {
    stub.restore();
  }
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Product not found/);
});

test('these routes require the admin key, same as the rest of the service', async () => {
  const response = await fetch(base + '/api/site/products');
  assert.equal(response.status, 401);
});
