import { test } from 'node:test';
import assert from 'node:assert/strict';

// config/env.js captures these at import time, so they must be set first.
process.env.OWN_SITE_API_URL = 'https://bbhappy.example.com/';
process.env.OWN_SITE_API_KEY = 'site-admin-key';

const ownSite = await import('../src/connectors/ownSite.js');

function mockFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
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

test('the connector targets the real API paths, not the original hypothesis', async () => {
  const mock = mockFetch(() => ({ json: [{ id: 'p1', name: 'Camion' }] }));
  try {
    const products = await ownSite.listProducts();
    assert.equal(mock.calls[0].url, 'https://bbhappy.example.com/api/products');
    assert.equal(mock.calls[0].method, 'GET');
    assert.equal(products[0].id, 'p1');
    // The catalog route is public: sending the admin key on a read would leak it
    // to a route that does not need it.
    assert.equal(mock.calls[0].headers['X-Admin-Key'], undefined);
  } finally {
    mock.restore();
  }
});

test('the trailing slash of OWN_SITE_API_URL does not double up', async () => {
  const mock = mockFetch(() => ({ json: [] }));
  try {
    await ownSite.listProducts();
    assert.equal(mock.calls[0].url, 'https://bbhappy.example.com/api/products');
  } finally {
    mock.restore();
  }
});

test('the site reports no stock, so stock sync leaves it alone', async () => {
  const mock = mockFetch(() => { throw new Error('must not be called'); });
  try {
    // BBVOLTEX has no stock field on any product and no route to change it:
    // inventing quantities would corrupt the hub's own stock view.
    assert.deepEqual(await ownSite.listInventoryItems(), []);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('updatePrice PATCHes the product and authenticates with X-Admin-Key', async () => {
  const mock = mockFetch(() => ({ json: { id: 'p1', price: 24.9 } }));
  try {
    const result = await ownSite.updatePrice('p1', 24.9);
    const call = mock.calls[0];
    assert.equal(call.url, 'https://bbhappy.example.com/api/admin/products/p1');
    assert.equal(call.method, 'PATCH');
    assert.equal(call.headers['X-Admin-Key'], 'site-admin-key');
    assert.deepEqual(call.body, { price: 24.9 });
    assert.equal(result.price, 24.9);
  } finally {
    mock.restore();
  }
});

test('updatePrice refuses an invalid price before any request', async () => {
  const mock = mockFetch(() => ({ json: {} }));
  try {
    await assert.rejects(() => ownSite.updatePrice('p1', 0), /Prix invalide/);
    await assert.rejects(() => ownSite.updatePrice('p1', -3), /Prix invalide/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('createListing posts the rich site payload and lets the site assign the id', async () => {
  const mock = mockFetch(() => ({ status: 201, json: { id: 'p13', name: 'Puzzle' } }));
  try {
    const result = await ownSite.createListing({
      id: 'should-be-ignored',
      category: 'jouets',
      name: 'Puzzle',
      name_en: 'Puzzle',
      price: 24.9,
      iconKey: 'puzzle',
    });
    const call = mock.calls[0];
    assert.equal(call.url, 'https://bbhappy.example.com/api/admin/products');
    assert.equal(call.method, 'POST');
    assert.equal(call.body.id, undefined, 'the site owns its id convention (p13, bj4...)');
    assert.equal(call.body.category, 'jouets');
    assert.equal(result.offerId, 'p13');
    assert.equal(result.listingId, 'p13');
  } finally {
    mock.restore();
  }
});

test('deleteListing DELETEs the product and authenticates with X-Admin-Key', async () => {
  const mock = mockFetch(() => ({ status: 204 }));
  try {
    const result = await ownSite.deleteListing('p13');
    const call = mock.calls[0];
    assert.equal(call.url, 'https://bbhappy.example.com/api/admin/products/p13');
    assert.equal(call.method, 'DELETE');
    assert.equal(call.headers['X-Admin-Key'], 'site-admin-key');
    assert.equal(call.body, undefined, 'a DELETE carries no body');
    assert.equal(result, null, '204 No Content resolves to null');
  } finally {
    mock.restore();
  }
});

test('deleteListing refuses a missing id before any request', async () => {
  const mock = mockFetch(() => ({ json: {} }));
  try {
    await assert.rejects(() => ownSite.deleteListing(), /Identifiant de produit manquant/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('getTaxonomy reads the closed lists the generator must respect', async () => {
  const mock = mockFetch(() => ({ json: { categories: ['jouets'], universes: ['educatif'], iconKeys: ['puzzle'] } }));
  try {
    const taxonomy = await ownSite.getTaxonomy();
    assert.equal(mock.calls[0].url, 'https://bbhappy.example.com/api/admin/taxonomy');
    assert.equal(mock.calls[0].headers['X-Admin-Key'], 'site-admin-key');
    assert.deepEqual(taxonomy.categories, ['jouets']);
  } finally {
    mock.restore();
  }
});

test('an API error surfaces the status and the body', async () => {
  const mock = mockFetch(() => ({ status: 400, text: '{"error":"Unknown category \\"drones\\"."}' }));
  try {
    await assert.rejects(
      () => ownSite.createListing({ category: 'drones', name: 'X', name_en: 'X', price: 1, iconKey: 'puzzle' }),
      /\(400\).*Unknown category/s,
    );
  } finally {
    mock.restore();
  }
});

test('the connector advertises the shared connector interface', async () => {
  // A generic caller must be able to treat every channel the same way; the
  // original code exposed updatePrice while ebay.js exposed updateOfferPrice.
  assert.equal(typeof ownSite.updateOfferPrice, 'function');
  assert.equal(typeof ownSite.createListing, 'function');
  assert.equal(typeof ownSite.listInventoryItems, 'function');
  assert.equal(ownSite.isConfigured(), true);
  // listOrders() exists (routes/orders.js and services/returnFulfillment.js
  // use it directly), but its shape — real shipping/delivery/return status,
  // address, items — is specific to the site's own order lifecycle and does
  // NOT match the generic { externalOrderId, lineItems, ... } shape the
  // marketplace connectors return. orderSync.js therefore still skips this
  // channel by name rather than calling it generically (see orderSync.js).
  assert.equal(typeof ownSite.listOrders, 'function');
});
