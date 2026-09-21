import { test } from 'node:test';
import assert from 'node:assert/strict';

// config/env.js capture ces valeurs à l'import : elles doivent exister avant.
process.env.EBAY_APP_ID = 'app-id';
process.env.EBAY_CERT_ID = 'cert-id';
process.env.EBAY_DEV_ID = 'dev-id';
process.env.EBAY_REFRESH_TOKEN = 'refresh-token';

const ebay = await import('../src/connectors/ebay.js');

function mockFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body };
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

/** Le jeton est mis en cache par le module : un seul test paie l'appel OAuth. */
function tokenResponse(call) {
  if (call.url.includes('/identity/v1/oauth2/token')) {
    return { json: { access_token: 'access-token', expires_in: 3600 } };
  }
  return null;
}

function orderPage(count, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    orderId: `o${start + i}`,
    orderFulfillmentStatus: 'FULFILLED',
    pricingSummary: { total: { value: '19.90', currency: 'EUR' } },
    creationDate: '2024-01-01T00:00:00.000Z',
    lineItems: [{ sku: `s${start + i}`, quantity: 2, title: 'Jouet' }],
  }));
}

function inventoryPage(count, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    sku: `sku${start + i}`,
    availability: { shipToLocationAvailability: { quantity: 4 } },
    product: { title: `Jouet ${start + i}` },
  }));
}

function apiCalls(mock, fragment) {
  return mock.calls.filter((call) => call.url.includes(fragment));
}

test('listOrders follows the offset until a short page and keeps the mapped shape', async () => {
  const mock = mockFetch((call) => {
    const token = tokenResponse(call);
    if (token) return token;
    const offset = Number(new URL(call.url).searchParams.get('offset'));
    if (offset === 0) return { json: { orders: orderPage(20, 0) } };
    if (offset === 20) return { json: { orders: orderPage(5, 20) } };
    throw new Error(`offset inattendu : ${offset}`);
  });
  try {
    const orders = await ebay.listOrders();
    assert.equal(orders.length, 25);
    const offsets = apiCalls(mock, '/sell/fulfillment/v1/order').map((c) => new URL(c.url).searchParams.get('offset'));
    assert.deepEqual(offsets, ['0', '20'], 'la pagination a suivi l’offset puis s’est arrêtée sur la page incomplète');
    assert.deepEqual(orders[0], {
      externalOrderId: 'o0',
      status: 'FULFILLED',
      amount: 19.9,
      createdAt: '2024-01-01T00:00:00.000Z',
      lineItems: [{ sku: 's0', quantity: 2, title: 'Jouet' }],
    });
  } finally {
    mock.restore();
  }
});

test('listOrders stops at the first short page instead of asking for more', async () => {
  const mock = mockFetch((call) => {
    const token = tokenResponse(call);
    if (token) return token;
    const offset = Number(new URL(call.url).searchParams.get('offset'));
    if (offset === 0) return { json: { orders: orderPage(3, 0) } };
    throw new Error('aucune page ne doit être demandée après une page incomplète');
  });
  try {
    const orders = await ebay.listOrders();
    assert.equal(orders.length, 3);
    assert.equal(apiCalls(mock, '/sell/fulfillment/v1/order').length, 1);
  } finally {
    mock.restore();
  }
});

test('listInventoryItems follows the offset and keeps the { sku, quantity, title } shape', async () => {
  const mock = mockFetch((call) => {
    const token = tokenResponse(call);
    if (token) return token;
    const offset = Number(new URL(call.url).searchParams.get('offset'));
    if (offset === 0) return { json: { inventoryItems: inventoryPage(50, 0) } };
    if (offset === 50) return { json: { inventoryItems: inventoryPage(3, 50) } };
    throw new Error(`offset inattendu : ${offset}`);
  });
  try {
    const items = await ebay.listInventoryItems();
    assert.equal(items.length, 53);
    const offsets = apiCalls(mock, '/sell/inventory/v1/inventory_item').map((c) => new URL(c.url).searchParams.get('offset'));
    assert.deepEqual(offsets, ['0', '50']);
    assert.deepEqual(items[0], { sku: 'sku0', quantity: 4, title: 'Jouet 0' });
    assert.deepEqual(Object.keys(items[52]).sort(), ['quantity', 'sku', 'title']);
  } finally {
    mock.restore();
  }
});

test('pagination stops at the safety cap when every page comes back full', async () => {
  let apiCallCount = 0;
  const mock = mockFetch((call) => {
    const token = tokenResponse(call);
    if (token) return token;
    apiCallCount += 1;
    // L'API renvoie toujours une page pleine : sans plafond, la boucle serait infinie.
    return { json: { inventoryItems: inventoryPage(1, apiCallCount * 100) } };
  });
  try {
    const items = await ebay.listInventoryItems({ limit: 1 });
    assert.equal(apiCallCount, 20, 'le plafond de 20 pages borne les appels');
    assert.equal(items.length, 20);
  } finally {
    mock.restore();
  }
});

test('listOrders honours a custom page size', async () => {
  const mock = mockFetch((call) => {
    const token = tokenResponse(call);
    if (token) return token;
    const offset = Number(new URL(call.url).searchParams.get('offset'));
    if (offset === 0) return { json: { orders: orderPage(5, 0) } };
    if (offset === 5) return { json: { orders: orderPage(2, 5) } };
    throw new Error(`offset inattendu : ${offset}`);
  });
  try {
    const orders = await ebay.listOrders({ limit: 5 });
    assert.equal(orders.length, 7);
    const offsets = apiCalls(mock, '/sell/fulfillment/v1/order').map((c) => new URL(c.url).searchParams.get('offset'));
    assert.deepEqual(offsets, ['0', '5']);
  } finally {
    mock.restore();
  }
});
