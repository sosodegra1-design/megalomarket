/*
 * Les routes HTTP qui poussent réellement une valeur vers un canal.
 *
 * Le tableau de bord affichait « Marquer appliquée » alors que rien ne partait
 * vers les marketplaces. Ces tests verrouillent la nouvelle vérité : le statut
 * ne passe à « applied » que si le canal a accepté, l'échec est renvoyé à
 * l'utilisateur en français, et la route de push direct répond par canal.
 * Aucun appel réseau : `global.fetch` est remplacé par un stub.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-push-routes-')), 'routes.db');
const ADMIN_KEY = 'cle-de-test-push-routes';
process.env.ADMIN_API_KEY = ADMIN_KEY;

// config/env.js lit ces variables à l'import : elles doivent exister avant.
process.env.EBAY_APP_ID = 'app-id';
process.env.EBAY_CERT_ID = 'cert-id';
process.env.EBAY_DEV_ID = 'dev-id';
process.env.EBAY_REFRESH_TOKEN = 'refresh-token';
process.env.OWN_SITE_API_URL = 'https://bbhappy.example.com';
process.env.OWN_SITE_API_KEY = 'site-admin-key';

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbGet } = await import('../src/db/database.js');

let server;
let base;

/* `global.fetch` est remplacé par le stub ci-dessous : sans en garder une copie
   dès maintenant, les requêtes HTTP du test vers l'application partiraient dans
   le stub et recevraient un 404 de « route inattendue ». */
const realFetch = global.fetch;

/** Même stub que pushSync.test.js : les connecteurs réels, aucune socket ouverte. */
function stubFetch({ offers = [], fail = () => false } = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const call = { url: String(url), path: parsed.pathname, method: options.method || 'GET', body: options.body };
    calls.push(call);

    let status = 200;
    let json = {};
    if (parsed.pathname.includes('/identity/v1/oauth2/token')) {
      json = { access_token: 'access-token', expires_in: 3600 };
    } else if (parsed.pathname === '/sell/inventory/v1/offer') {
      const sku = parsed.searchParams.get('sku');
      json = { offers: offers.filter((offer) => offer.sku === sku) };
    } else if (parsed.pathname.startsWith('/sell/inventory/v1/offer/')) {
      json = {};
    } else if (parsed.pathname.startsWith('/api/admin/products/')) {
      json = { id: parsed.pathname.split('/').pop() };
    } else {
      status = 404;
      json = { error: `route inattendue : ${parsed.pathname}` };
    }

    if (fail(call)) {
      status = 500;
      json = { error: 'panne simulée du canal' };
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

async function call(path, { method = 'GET', body } = {}) {
  const response = await realFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

async function createProduct(sku, costPrice, name = `Produit ${sku}`) {
  const info = await dbRun(
    'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)',
    [sku, name, '', costPrice, Date.now()],
  );
  return info.lastInsertRowid;
}

async function createListing(productId, channel, externalId, price) {
  await dbRun(
    'INSERT INTO channel_listings (product_id, channel, external_id, price, stock, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [productId, channel, externalId, price, 0, Date.now()],
  );
}

async function createPriceRecommendation(productId, channel, suggestedPrice) {
  const info = await dbRun(
    'INSERT INTO recommendations (type, channel, product_id, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['price', channel, productId, JSON.stringify({ channel, suggestedPrice, rationale: 'test' }), 'pending', Date.now()],
  );
  return info.lastInsertRowid;
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

/* ============ POST /api/recommendations/:id/apply ============ */

test('a price recommendation is only marked applied once the channel accepted it', async () => {
  const productId = await createProduct('SKU-APPLY', 5);
  await createListing(productId, 'ebay', 'SKU-APPLY', 12);
  const recommendationId = await createPriceRecommendation(productId, 'ebay', 24.9);

  const mock = stubFetch({ offers: [{ sku: 'SKU-APPLY', offerId: 'offer-apply', marketplaceId: 'EBAY_FR', status: 'PUBLISHED' }] });
  try {
    const { status, body } = await call(`/api/recommendations/${recommendationId}/apply`, { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.price, 24.9);
    assert.equal(body.channel, 'ebay');

    const recommendation = await dbGet('SELECT * FROM recommendations WHERE id = ?', [recommendationId]);
    assert.equal(recommendation.status, 'applied');

    const listing = await dbGet('SELECT * FROM channel_listings WHERE product_id = ? AND channel = ?', [productId, 'ebay']);
    assert.equal(listing.price, 24.9, 'le prix est réellement parti et la vue locale suit');

    const put = mock.calls.find((call) => call.method === 'PUT');
    assert.equal(put.path, '/sell/inventory/v1/offer/offer-apply');
  } finally {
    mock.restore();
  }
});

test('a failed push leaves the recommendation pending and reports the error', async () => {
  // Le connecteur eBay ne retrouve aucune offre pour ce SKU : le push échoue.
  const productId = await createProduct('SKU-FAIL', 5);
  await createListing(productId, 'ebay', 'SKU-FAIL', 12);
  const recommendationId = await createPriceRecommendation(productId, 'ebay', 24.9);

  const mock = stubFetch({ offers: [] });
  try {
    const { status, body } = await call(`/api/recommendations/${recommendationId}/apply`, { method: 'POST' });
    assert.equal(status, 400);
    assert.match(body.error, /Échec de l'application de la recommandation/);
    assert.match(body.error, /Aucune offre eBay/);

    const recommendation = await dbGet('SELECT * FROM recommendations WHERE id = ?', [recommendationId]);
    assert.equal(recommendation.status, 'pending', 'l’utilisateur doit pouvoir réessayer');
  } finally {
    mock.restore();
  }
});

test('a price below cost_price is refused and the recommendation stays pending', async () => {
  const productId = await createProduct('SKU-APPLY-PERTE', 30);
  await createListing(productId, 'ebay', 'SKU-APPLY-PERTE', 39);
  const recommendationId = await createPriceRecommendation(productId, 'ebay', 10);

  const mock = stubFetch({ offers: [{ sku: 'SKU-APPLY-PERTE', offerId: 'offer-x', marketplaceId: 'EBAY_FR', status: 'PUBLISHED' }] });
  try {
    const { status, body } = await call(`/api/recommendations/${recommendationId}/apply`, { method: 'POST' });
    assert.equal(status, 400);
    assert.match(body.error, /prix de revient/);
    assert.equal(mock.calls.length, 0, 'rien n’est parti vers le canal');
    assert.equal((await dbGet('SELECT status FROM recommendations WHERE id = ?', [recommendationId])).status, 'pending');
  } finally {
    mock.restore();
  }
});

test('a non-price recommendation keeps its old behaviour: nothing to push, status flips', async () => {
  const productId = await createProduct('SKU-DESC', 5);
  const info = await dbRun(
    'INSERT INTO recommendations (type, channel, product_id, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['description', 'ebay', productId, JSON.stringify({ description: 'Un texte' }), 'pending', Date.now()],
  );

  const mock = stubFetch();
  try {
    const { status, body } = await call(`/api/recommendations/${info.lastInsertRowid}/apply`, { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(mock.calls.length, 0, 'aucun appel réseau pour une description');
    assert.equal((await dbGet('SELECT status FROM recommendations WHERE id = ?', [info.lastInsertRowid])).status, 'applied');
  } finally {
    mock.restore();
  }
});

test('an already applied recommendation is refused', async () => {
  const productId = await createProduct('SKU-DEJA', 5);
  const info = await dbRun(
    'INSERT INTO recommendations (type, channel, product_id, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['description', 'ebay', productId, JSON.stringify({}), 'applied', Date.now()],
  );
  const { status, body } = await call(`/api/recommendations/${info.lastInsertRowid}/apply`, { method: 'POST' });
  assert.equal(status, 400);
  assert.match(body.error, /introuvable ou déjà traitée/);
});

/* ============ POST /api/products/:productId/price ============ */

test('POST /api/products/:id/price pushes to one named channel', async () => {
  const productId = await createProduct('SKU-ROUTE-UN', 5);
  await createListing(productId, 'ebay', 'SKU-ROUTE-UN', 12);

  const mock = stubFetch({ offers: [{ sku: 'SKU-ROUTE-UN', offerId: 'offer-route', marketplaceId: 'EBAY_FR', status: 'PUBLISHED' }] });
  try {
    const { status, body } = await call(`/api/products/${productId}/price`, {
      method: 'POST',
      body: { price: 26.5, channel: 'ebay' },
    });
    assert.equal(status, 200);
    assert.equal(body.channel, 'ebay');
    assert.equal(body.ok, true);
    assert.equal(body.price, 26.5);
    assert.equal((await dbGet('SELECT price FROM channel_listings WHERE product_id = ? AND channel = ?', [productId, 'ebay'])).price, 26.5);
  } finally {
    mock.restore();
  }
});

test('POST /api/products/:id/price without channel returns the per-channel results', async () => {
  const productId = await createProduct('SKU-ROUTE-TOUS', 5);
  await createListing(productId, 'own_site', 'site-42', 12);

  const mock = stubFetch({ offers: [{ sku: 'SKU-ROUTE-TOUS', offerId: 'offer-tous', marketplaceId: 'EBAY_FR', status: 'PUBLISHED' }] });
  try {
    const { status, body } = await call(`/api/products/${productId}/price`, { method: 'POST', body: { price: 21 } });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body), 'un résultat par canal, y compris les canaux ignorés');

    const own = body.find((r) => r.channel === 'own_site');
    const ebay = body.find((r) => r.channel === 'ebay');
    const amazon = body.find((r) => r.channel === 'amazon');
    assert.equal(own.ok, true);
    assert.equal(ebay.ok, true);
    assert.equal(amazon.ok, false);
    assert.equal(amazon.skipped, true, 'canal non pris en charge : signalé, pas fatal');

    assert.equal((await dbGet('SELECT price FROM channel_listings WHERE product_id = ? AND channel = ?', [productId, 'own_site'])).price, 21);
    assert.equal((await dbGet('SELECT price FROM channel_listings WHERE product_id = ? AND channel = ?', [productId, 'ebay'])).price, 21);
  } finally {
    mock.restore();
  }
});

test('POST /api/products/:id/price refuses an invalid price and an unknown product', async () => {
  const productId = await createProduct('SKU-ROUTE-INVALIDE', 5);
  assert.equal((await call(`/api/products/${productId}/price`, { method: 'POST', body: { price: -1 } })).status, 400);
  assert.equal((await call('/api/products/999999/price', { method: 'POST', body: { price: 10, channel: 'ebay' } })).status, 400);

  // Sans canal nommé, l'erreur est rapportée par canal plutôt que d'interrompre
  // la boucle : aucun canal n'a de produit à mettre à jour.
  const all = await call('/api/products/999999/price', { method: 'POST', body: { price: 10 } });
  assert.equal(all.status, 200);
  assert.ok(all.body.every((result) => result.ok === false && /Produit introuvable/.test(result.error)));
});
