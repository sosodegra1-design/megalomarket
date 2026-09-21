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

function apiCalls(mock) {
  return mock.calls.filter((call) => call.url.includes('/sell/fulfillment/v1/order'));
}

const SINCE = '2024-05-01T10:00:00.000Z';

test('listOrders passes the eBay creationdate filter on every page when since is given', async () => {
  const mock = mockFetch((call) => {
    const token = tokenResponse(call);
    if (token) return token;
    const offset = Number(new URL(call.url).searchParams.get('offset'));
    if (offset === 0) return { json: { orders: orderPage(20, 0) } };
    if (offset === 20) return { json: { orders: orderPage(2, 20) } };
    throw new Error(`offset inattendu : ${offset}`);
  });
  try {
    const orders = await ebay.listOrders({ since: SINCE });
    const calls = apiCalls(mock);
    assert.equal(calls.length, 2, 'la pagination complète doit être couverte');
    for (const call of calls) {
      const filter = new URL(call.url).searchParams.get('filter');
      assert.equal(filter, `creationdate:[${SINCE}..]`);
      // eBay exige les crochets percent-encodés (%5B / %5D) ; la forme brute
      // documentée est `creationdate:%5B2016-09-29T15:05:43.026Z..%5D`.
      assert.ok(
        call.url.includes('filter=creationdate:%5B2024-05-01T10:00:00.000Z..%5D'),
        `filtre percent-encodé attendu dans ${call.url}`,
      );
    }
    // La forme retournée ne doit pas bouger, filtre ou pas.
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

test('listOrders normalises a millisecond timestamp into the documented ISO filter', async () => {
  const ms = Date.parse('2024-03-15T08:30:00.000Z');
  const mock = mockFetch((call) => {
    const token = tokenResponse(call);
    if (token) return token;
    return { json: { orders: orderPage(1, 0) } };
  });
  try {
    await ebay.listOrders({ since: ms });
    assert.equal(
      new URL(apiCalls(mock)[0].url).searchParams.get('filter'),
      'creationdate:[2024-03-15T08:30:00.000Z..]',
    );
  } finally {
    mock.restore();
  }
});

test('listOrders sends no filter at all without since', async () => {
  const mock = mockFetch((call) => {
    const token = tokenResponse(call);
    if (token) return token;
    return { json: { orders: orderPage(1, 0) } };
  });
  try {
    await ebay.listOrders();
    const calls = apiCalls(mock);
    assert.ok(calls.length >= 1);
    for (const call of calls) {
      assert.equal(new URL(call.url).searchParams.has('filter'), false, 'aucun filtre ne doit être ajouté');
    }
  } finally {
    mock.restore();
  }
});

test('an invalid since is rejected before any network call', async () => {
  const mock = mockFetch(() => ({ json: { orders: [] } }));
  try {
    await assert.rejects(() => ebay.listOrders({ since: 'pas-une-date' }), /since/);
    assert.equal(mock.calls.length, 0, 'aucun appel réseau ne doit être tenté');
  } finally {
    mock.restore();
  }
});
