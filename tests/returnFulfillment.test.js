import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-returns-test-')), 'test.db');
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_BASE_URL;

const { initDatabase, dbAll } = await import('../src/db/database.js');
await initDatabase();

const { processPendingReturns } = await import('../src/services/returnFulfillment.js');

function fakeOrder(overrides = {}) {
  return {
    id: 'BB001',
    name: 'Ada Test',
    email: 'ada@example.com',
    address: '1 rue Test',
    city: 'Paris',
    zip: '75000',
    items: [{ productId: 'p1', name: 'Puzzle 3D', qty: 1, price: 29.9 }],
    returnStatus: 'requested',
    returnReason: "Le produit ne correspond pas à la description",
    ...overrides,
  };
}

function fakeConnector(orders, { markReturnHandled } = {}) {
  const calls = { markReturnHandled: [] };
  return {
    calls,
    connector: {
      isConfigured: () => true,
      listOrders: async () => orders,
      markReturnHandled: async (id, patch) => {
        calls.markReturnHandled.push({ id, patch });
        if (markReturnHandled) return markReturnHandled(id, patch);
        return { id, ...patch };
      },
    },
  };
}

let originalFetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; delete process.env.BREVO_API_KEY; delete process.env.BREVO_SENDER_EMAIL; delete process.env.SENDCLOUD_PUBLIC_KEY; delete process.env.SENDCLOUD_SECRET_KEY; });

test('no pending returns: nothing is logged, no connector write happens', async () => {
  const { connector, calls } = fakeConnector([fakeOrder({ returnStatus: null })]);
  const result = await processPendingReturns({ registry: { own_site: connector } });
  assert.deepEqual(result, { handled: 0, withLabel: 0, errors: [] });
  assert.equal(calls.markReturnHandled.length, 0);
});

test('Brevo not configured: the return is left untouched (status stays "requested") so it is retried later', async () => {
  const { connector, calls } = fakeConnector([fakeOrder()]);
  const result = await processPendingReturns({ registry: { own_site: connector } });
  assert.equal(result.handled, 0);
  assert.equal(calls.markReturnHandled.length, 0, 'must not advance the status when the customer was never actually notified');

  const activity = await dbAll("SELECT * FROM activity_log WHERE kind = 'EMAIL_IGNORE' ORDER BY id DESC LIMIT 1");
  assert.equal(activity.length, 1);
  assert.match(activity[0].message, /BB001/);
});

test('Brevo configured, Sendcloud not configured: email sent with fallback instructions, no label', async () => {
  process.env.BREVO_API_KEY = 'fake_brevo';
  process.env.BREVO_SENDER_EMAIL = 'boutique@example.com';

  let brevoCall = null;
  global.fetch = async (url, options) => {
    if (String(url).includes('api.brevo.com')) {
      brevoCall = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'abc' }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const { connector, calls } = fakeConnector([fakeOrder()]);
  const result = await processPendingReturns({ registry: { own_site: connector } });

  assert.equal(result.handled, 1);
  assert.equal(result.withLabel, 0);
  assert.equal(calls.markReturnHandled.length, 1);
  assert.equal(calls.markReturnHandled[0].patch.returnStatus, 'instructions_sent');
  assert.equal(calls.markReturnHandled[0].patch.returnLabelUrl, null);
  assert.match(brevoCall.htmlContent, /reconditionner/); // the fallback instructions text
  assert.match(brevoCall.htmlContent, /en cours de préparation/); // honest "no label yet" wording
});

test('Brevo and Sendcloud both configured: a real label is created and referenced in the email', async () => {
  process.env.BREVO_API_KEY = 'fake_brevo';
  process.env.BREVO_SENDER_EMAIL = 'boutique@example.com';
  process.env.SENDCLOUD_PUBLIC_KEY = 'fake_pub';
  process.env.SENDCLOUD_SECRET_KEY = 'fake_secret';

  let brevoCall = null;
  global.fetch = async (url, options) => {
    const href = String(url);
    if (href.includes('api.brevo.com')) {
      brevoCall = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'abc' }) };
    }
    if (href.includes('/shipping_methods')) {
      return {
        ok: true, status: 200,
        json: async () => ({ shipping_methods: [{ id: 5, name: 'Colissimo Retour', carrier: 'Colissimo', countries: [{ iso_2: 'FR', price: 4.5 }] }] }),
      };
    }
    if (href.includes('/parcels')) {
      const body = JSON.parse(options.body);
      assert.equal(body.parcel.is_return, true);
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ parcel: { id: 1, tracking_number: 'RET1', tracking_url: 'https://x', label: { label_printer: ['https://panel.sendcloud.sc/return/1.pdf'] } } }),
      };
    }
    throw new Error(`unexpected fetch to ${href}`);
  };

  const { connector, calls } = fakeConnector([fakeOrder()]);
  const result = await processPendingReturns({ registry: { own_site: connector } });

  assert.equal(result.handled, 1);
  assert.equal(result.withLabel, 1);
  assert.equal(calls.markReturnHandled[0].patch.returnStatus, 'label_sent');
  assert.equal(calls.markReturnHandled[0].patch.returnLabelUrl, 'https://panel.sendcloud.sc/return/1.pdf');
  assert.match(brevoCall.htmlContent, /panel\.sendcloud\.sc\/return\/1\.pdf/);
});

test('one failing return does not block the others', async () => {
  process.env.BREVO_API_KEY = 'fake_brevo';
  process.env.BREVO_SENDER_EMAIL = 'boutique@example.com';
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.to[0].email === 'broken@example.com') {
      return { ok: false, status: 500, text: async () => 'Brevo internal error' };
    }
    return { ok: true, status: 201, json: async () => ({ messageId: 'ok' }) };
  };

  const orders = [
    fakeOrder({ id: 'BB001', email: 'broken@example.com' }),
    fakeOrder({ id: 'BB002', email: 'fine@example.com' }),
  ];
  const { connector, calls } = fakeConnector(orders);
  const result = await processPendingReturns({ registry: { own_site: connector } });

  assert.equal(result.handled, 1);
  assert.equal(calls.markReturnHandled.length, 1);
  assert.equal(calls.markReturnHandled[0].id, 'BB002');
});

test('throws clearly when own_site is not configured, so the scheduler logs a real reason', async () => {
  await assert.rejects(
    () => processPendingReturns({ registry: { own_site: { isConfigured: () => false } } }),
    /site propre non configuré/,
  );
});
