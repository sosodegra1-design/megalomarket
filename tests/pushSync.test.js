/*
 * Propagation d'une valeur interne vers les canaux (pushSync).
 *
 * Jusqu'ici le hub ne faisait que LIRE les canaux : ces tests verrouillent
 * l'autre moitié de la promesse — un prix validé part réellement, un canal qui
 * ne sait pas faire l'opération est ignoré sans bruit, un échec est rapporté
 * sans interrompre les autres canaux, et le verrou anti-vente à perte tient.
 * Aucun test ne touche le réseau : `global.fetch` est remplacé par un stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-push-')), 'push.db');
process.env.ADMIN_API_KEY = 'cle-de-test-push';

// config/env.js lit ces variables à l'import : elles doivent exister avant.
process.env.EBAY_APP_ID = 'app-id';
process.env.EBAY_CERT_ID = 'cert-id';
process.env.EBAY_DEV_ID = 'dev-id';
process.env.EBAY_REFRESH_TOKEN = 'refresh-token';
process.env.OWN_SITE_API_URL = 'https://bbhappy.example.com';
process.env.OWN_SITE_API_KEY = 'site-admin-key';

const { dbAll, dbGet, dbRun, initDatabase } = await import('../src/db/database.js');
const { pushPriceToChannel, pushPriceToAllChannels, pushStockToChannel } = await import('../src/services/pushSync.js');

await initDatabase();

/*
 * Stub réseau : il connaît les routes réellement appelées par les connecteurs
 * (OAuth eBay, recherche d'offre par SKU, PUT d'offre, PATCH produit du site).
 * `fail` permet de faire tomber un canal précis — pour vérifier qu'un échec
 * n'emporte pas les autres — sans introduire d'erreur dans les tests voisins.
 */
function stubFetch({ offers = [], fail = () => false } = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const call = {
      url: String(url),
      path: parsed.pathname,
      query: parsed.searchParams,
      method: options.method || 'GET',
      body: options.body,
    };
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

async function createProduct(sku, costPrice, name = `Produit ${sku}`) {
  const info = await dbRun(
    'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)',
    [sku, name, '', costPrice, Date.now()],
  );
  return info.lastInsertRowid;
}

async function listingFor(productId, channel) {
  return dbGet('SELECT * FROM channel_listings WHERE product_id = ? AND channel = ?', [productId, channel]);
}

test('a successful price push updates channel_listings and writes an activity log', async () => {
  const productId = await createProduct('SKU-EBAY-OK', 5);
  await dbRun(
    'INSERT INTO channel_listings (product_id, channel, external_id, price, stock, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [productId, 'ebay', 'SKU-EBAY-OK', 12, 3, Date.now()],
  );

  const mock = stubFetch({ offers: [{ sku: 'SKU-EBAY-OK', offerId: 'offer-1', marketplaceId: 'EBAY_FR', status: 'PUBLISHED' }] });
  try {
    const result = await pushPriceToChannel(productId, 'ebay', 24.9);
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'ebay');
    assert.equal(result.price, 24.9);
    // Le SKU n'est PAS l'offerId : le connecteur doit avoir résolu l'offre.
    assert.equal(result.externalId, 'offer-1');

    const listing = await listingFor(productId, 'ebay');
    assert.equal(listing.price, 24.9, 'la vue locale du hub reste cohérente');
    assert.equal(listing.stock, 3, 'un push de prix ne touche pas au stock');

    const logs = await dbAll('SELECT * FROM activity_log ORDER BY id DESC LIMIT 5');
    assert.ok(logs.some((log) => log.kind === 'PUSH_PRIX' && log.message.includes('ebay')));

    const put = mock.calls.find((call) => call.method === 'PUT');
    assert.equal(put.path, '/sell/inventory/v1/offer/offer-1');
    assert.equal(JSON.parse(put.body).pricingSummary.price.value, '24.90');
  } finally {
    mock.restore();
  }
});

test('a channel that does not implement the operation is skipped, not an error', async () => {
  const productId = await createProduct('SKU-AMAZON', 5);
  const mock = stubFetch();
  try {
    const result = await pushPriceToChannel(productId, 'amazon', 30);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true, 'ignoré sans lever');
    // Amazon expose bien updateOfferPrice, mais il répond « pas encore actif »
    // tant que les clés SP-API manquent : le canal est signalé, aucun appel réseau.
    assert.match(result.reason, /pas encore actif/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('a connector without the method is skipped too, never thrown', async () => {
  const missing = { isConfigured: () => true };
  assert.equal(typeof missing.updateOfferPrice, 'undefined');
  const { connectors } = await import('../src/connectors/index.js');
  const saved = connectors.own_site;
  // Un canal du registre peut ne pas exposer l'opération (le site propre n'a
  // aucune notion de stock) : on vérifie que le garde-fou `typeof` tient.
  connectors.own_site = missing;
  try {
    const productId = await createProduct('SKU-NO-METHOD', 5);
    const result = await pushPriceToChannel(productId, 'own_site', 20);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /ne permet pas la mise à jour de prix/);
  } finally {
    connectors.own_site = saved;
  }
});

test('a connector that throws is reported per channel without aborting the others', async () => {
  const productId = await createProduct('SKU-MIXTE', 5);
  await dbRun(
    'INSERT INTO channel_listings (product_id, channel, external_id, price, stock, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [productId, 'own_site', 'p1', 10, 0, Date.now()],
  );

  // Le site propre tombe, eBay répond : l'échec de l'un ne doit pas empêcher
  // l'autre d'être mis à jour.
  const mock = stubFetch({
    offers: [{ sku: 'SKU-MIXTE', offerId: 'offer-2', marketplaceId: 'EBAY_FR', status: 'PUBLISHED' }],
    fail: (call) => call.path.startsWith('/api/admin/products/'),
  });
  try {
    const results = await pushPriceToAllChannels(productId, 22);
    const own = results.find((r) => r.channel === 'own_site');
    const ebay = results.find((r) => r.channel === 'ebay');

    assert.equal(own.ok, false);
    assert.match(own.error, /500/);
    assert.equal(ebay.ok, true, 'eBay a bien été poussé malgré la panne du site');

    assert.equal((await listingFor(productId, 'ebay')).price, 22);
    assert.equal((await listingFor(productId, 'own_site')).price, 10, 'le canal en panne garde son ancien prix');

    const logs = await dbAll('SELECT * FROM activity_log ORDER BY id DESC LIMIT 10');
    assert.ok(logs.some((log) => log.kind === 'ERREUR_PUSH' && log.message.includes('own_site')));
  } finally {
    mock.restore();
  }
});

test('a price below cost_price is refused and never pushed', async () => {
  const productId = await createProduct('SKU-PERTE', 30);
  await dbRun(
    'INSERT INTO channel_listings (product_id, channel, external_id, price, stock, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [productId, 'ebay', 'SKU-PERTE', 39, 1, Date.now()],
  );

  const mock = stubFetch({ offers: [{ sku: 'SKU-PERTE', offerId: 'offer-3', marketplaceId: 'EBAY_FR', status: 'PUBLISHED' }] });
  try {
    await assert.rejects(
      () => pushPriceToChannel(productId, 'ebay', 19.9),
      /inférieur au prix de revient.*Vente à perte/s,
    );
    assert.equal(mock.calls.length, 0, 'le refus a lieu avant tout appel réseau');
    assert.equal((await listingFor(productId, 'ebay')).price, 39, 'le prix local ne bouge pas');
  } finally {
    mock.restore();
  }
});

test('pushPriceToAllChannels reports the anti-loss refusal per channel instead of throwing', async () => {
  const productId = await createProduct('SKU-PERTE-TOUS', 30);
  const mock = stubFetch();
  try {
    const results = await pushPriceToAllChannels(productId, 5);
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.ok === false));
    assert.ok(results.every((r) => /prix de revient/.test(r.error)));
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('a stock push is skipped on every channel, since none handles stock yet', async () => {
  const productId = await createProduct('SKU-STOCK', 5);
  const mock = stubFetch();
  try {
    const result = await pushStockToChannel(productId, 'own_site', 4);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /ne permet pas la mise à jour de stock/);
    assert.equal(mock.calls.length, 0);

    await assert.rejects(() => pushStockToChannel(productId, 'ebay', -1), /Quantité de stock invalide/);
  } finally {
    mock.restore();
  }
});

test('an unknown channel or a missing product is a real error, not a silent skip', async () => {
  await assert.rejects(() => pushPriceToChannel(1, 'leboncoin', 10), /Canal inconnu/);
  await assert.rejects(() => pushPriceToChannel(999999, 'ebay', 10), /Produit introuvable/);
  await assert.rejects(() => pushPriceToChannel(1, 'ebay', 0), /Prix invalide/);
});

test('ebay resolves the offerId from the SKU, preferring the EBAY_FR offer', async () => {
  const productId = await createProduct('SKU-MULTI', 5);
  const mock = stubFetch({
    offers: [
      { sku: 'SKU-MULTI', offerId: 'offer-de', marketplaceId: 'EBAY_DE', status: 'PUBLISHED' },
      { sku: 'SKU-MULTI', offerId: 'offer-fr', marketplaceId: 'EBAY_FR', status: 'PUBLISHED' },
    ],
  });
  try {
    const result = await pushPriceToChannel(productId, 'ebay', 25);
    assert.equal(result.externalId, 'offer-fr', 'la place de marché française prime');
    const lookup = mock.calls.find((call) => call.path === '/sell/inventory/v1/offer');
    assert.equal(lookup.query.get('sku'), 'SKU-MULTI');
  } finally {
    mock.restore();
  }
});
