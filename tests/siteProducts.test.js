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

const TAXONOMY = { categories: ['jouets'], universes: ['educatif'], iconKeys: ['puzzle'] };

function validArticle(overrides = {}) {
  return {
    name: 'Puzzle 3D Tour Eiffel',
    description: 'Un puzzle en bois pour les curieux.',
    category: 'jouets',
    age: '6-8',
    ageLabel: '6-8 ans',
    iconKey: 'puzzle',
    price: 5.22,
    images: ['https://cdn.example/eiffel1.jpg'],
    ...overrides,
  };
}

/* N'intercepte QUE l'appel sortant vers le site propre — `call()` utilise
   aussi `fetch` pour joindre le serveur local de test. */
function stubSiteFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    if (!String(url).includes('bbhappy.example.com')) return original(url, options);
    const call = {
      url: String(url),
      method: options.method || 'GET',
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
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

test('GET /taxonomy proxies the site\'s closed lists for the form\'s dropdowns', async () => {
  const stub = stubSiteFetch((call) => (call.url.endsWith('/api/admin/taxonomy') ? { json: TAXONOMY } : {}));
  let result;
  try {
    result = await call('/api/site/taxonomy');
  } finally {
    stub.restore();
  }
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, TAXONOMY);
});

test('creating an article publishes it and defaults the English fields to the French text', async () => {
  const stub = stubSiteFetch((call) => {
    if (call.url.endsWith('/api/admin/taxonomy')) return { json: TAXONOMY };
    if (call.url.endsWith('/api/admin/products')) return { status: 201, json: { id: 'p20', ...call.body } };
    return {};
  });
  let result;
  try {
    result = await call('/api/site/products', { method: 'POST', body: validArticle() });
  } finally {
    stub.restore();
  }
  assert.equal(result.status, 201);
  const postCall = stub.calls.find((c) => c.url.endsWith('/api/admin/products'));
  assert.equal(postCall.body.name, 'Puzzle 3D Tour Eiffel');
  assert.equal(postCall.body.name_en, 'Puzzle 3D Tour Eiffel', 'no English name given: falls back to the French one');
  assert.equal(postCall.body.ageLabel_en, '6-8 ans');
  assert.deepEqual(postCall.body.images, ['https://cdn.example/eiffel1.jpg']);
});

test('creating an article with an explicit English name keeps it, not the French fallback', async () => {
  const stub = stubSiteFetch((call) => {
    if (call.url.endsWith('/api/admin/taxonomy')) return { json: TAXONOMY };
    if (call.url.endsWith('/api/admin/products')) return { status: 201, json: { id: 'p21' } };
    return {};
  });
  try {
    await call('/api/site/products', { method: 'POST', body: validArticle({ nameEn: 'Eiffel Tower 3D Puzzle' }) });
  } finally {
    const postCall = stub.calls.find((c) => c.url.endsWith('/api/admin/products'));
    assert.equal(postCall.body.name_en, 'Eiffel Tower 3D Puzzle');
    stub.restore();
  }
});

test('a required field left empty is refused before any request', async () => {
  const stub = stubSiteFetch(() => ({}));
  try {
    const { status, body } = await call('/api/site/products', { method: 'POST', body: validArticle({ name: '  ' }) });
    assert.equal(status, 400);
    assert.match(body.error, /Nom/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('an unknown category is refused with the site\'s allowed values, before publishing', async () => {
  const stub = stubSiteFetch((call) => (call.url.endsWith('/api/admin/taxonomy') ? { json: TAXONOMY } : {}));
  try {
    const { status, body } = await call('/api/site/products', { method: 'POST', body: validArticle({ category: 'drones' }) });
    assert.equal(status, 400);
    assert.match(body.error, /Catégorie "drones" inconnue/);
    assert.ok(!stub.calls.some((c) => c.url.endsWith('/api/admin/products')), 'never reaches the publish call');
  } finally {
    stub.restore();
  }
});

test('GET /products/:id fetches the full detail to pre-fill the edit form', async () => {
  const stub = stubSiteFetch((call) => (call.url.endsWith('/api/admin/products/p13') ? { json: { id: 'p13', name: 'Puzzle' } } : {}));
  let result;
  try {
    result = await call('/api/site/products/p13');
  } finally {
    stub.restore();
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.name, 'Puzzle');
});

test('editing an article only sends the fields that were actually changed', async () => {
  const stub = stubSiteFetch((call) => (call.url.endsWith('/api/admin/products/p13') ? { json: { id: 'p13', price: 6.5 } } : {}));
  let result;
  try {
    result = await call('/api/site/products/p13', { method: 'PATCH', body: { price: 6.5 } });
  } finally {
    stub.restore();
  }
  assert.equal(result.status, 200);
  const patchCall = stub.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patchCall.body, { price: 6.5 });
});

test('editing with an unknown icon key is refused before reaching the site', async () => {
  const stub = stubSiteFetch((call) => (call.url.endsWith('/api/admin/taxonomy') ? { json: TAXONOMY } : {}));
  try {
    const { status, body } = await call('/api/site/products/p13', { method: 'PATCH', body: { iconKey: 'inconnu' } });
    assert.equal(status, 400);
    assert.match(body.error, /Clé d'icône "inconnu" inconnue/);
    assert.ok(!stub.calls.some((c) => c.method === 'PATCH'));
  } finally {
    stub.restore();
  }
});

test('an empty PATCH body is refused', async () => {
  const { status, body } = await call('/api/site/products/p13', { method: 'PATCH', body: {} });
  assert.equal(status, 400);
  assert.match(body.error, /Aucune modification/);
});

test('these routes require the admin key, same as the rest of the service', async () => {
  const response = await fetch(base + '/api/site/products');
  assert.equal(response.status, 401);
});
