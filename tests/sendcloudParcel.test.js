import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SENDCLOUD_PUBLIC_KEY = 'pub_test';
process.env.SENDCLOUD_SECRET_KEY = 'secret_test';

const { createParcel, createReturnParcel, verifyWebhookSignature } = await import('../src/services/sendcloud.js');

let originalFetch;
let lastRequest;

function mockFetchOnce(status, body) {
  originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    lastRequest = { url, options, body: JSON.parse(options.body) };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
}

beforeEach(() => { lastRequest = null; });
afterEach(() => { if (originalFetch) global.fetch = originalFetch; });

const toAddress = {
  toName: 'Ada Test',
  toAddress: '1 rue Test',
  toCity: 'Paris',
  toPostalCode: '75000',
  toCountry: 'FR',
  toEmail: 'ada@example.com',
};

test('createParcel sends a well-formed request and requests a label immediately', async () => {
  mockFetchOnce(200, {
    parcel: {
      id: 987,
      tracking_number: '6A12345',
      tracking_url: 'https://track.example/6A12345',
      carrier: { name: 'Colissimo' },
      status: { message: 'Ready to send' },
      label: { label_printer: ['https://panel.sendcloud.sc/label/987.pdf'] },
    },
  });

  const result = await createParcel({ ...toAddress, shippingMethodId: 42, weightKg: 0.8, orderNumber: 'BB123' });

  assert.equal(lastRequest.url, 'https://panel.sendcloud.sc/api/v2/parcels');
  assert.equal(lastRequest.body.parcel.name, 'Ada Test');
  assert.equal(lastRequest.body.parcel.weight, '0.800');
  assert.equal(lastRequest.body.parcel.shipment.id, 42);
  assert.equal(lastRequest.body.parcel.order_number, 'BB123');
  assert.equal(lastRequest.body.parcel.request_label, true);
  assert.equal(lastRequest.body.parcel.is_return, undefined);

  assert.equal(result.trackingNumber, '6A12345');
  assert.equal(result.trackingUrl, 'https://track.example/6A12345');
  assert.equal(result.carrier, 'Colissimo');
  assert.equal(result.labelUrl, 'https://panel.sendcloud.sc/label/987.pdf');
});

test('createParcel rejects an invalid weight before making any request', async () => {
  await assert.rejects(
    () => createParcel({ ...toAddress, shippingMethodId: 42, weightKg: 0, orderNumber: 'BB123' }),
    /Poids du colis invalide/,
  );
});

test('createParcel surfaces the raw Sendcloud error body on failure', async () => {
  mockFetchOnce(422, { error: { message: 'Invalid shipping method for destination' } });
  await assert.rejects(
    () => createParcel({ ...toAddress, shippingMethodId: 42, weightKg: 1, orderNumber: 'BB123' }),
    /HTTP 422.*Invalid shipping method/s,
  );
});

test('createParcel copes with a parcel that has no label yet (labelUrl stays null, no crash)', async () => {
  mockFetchOnce(200, {
    parcel: { id: 1, tracking_number: null, tracking_url: null, status: { message: 'Announced' } },
  });
  const result = await createParcel({ ...toAddress, shippingMethodId: 42, weightKg: 1, orderNumber: 'BB123' });
  assert.equal(result.labelUrl, null);
  assert.equal(result.trackingNumber, null);
});

test('createReturnParcel marks the parcel as a return and uses the customer as origin', async () => {
  mockFetchOnce(200, {
    parcel: { id: 2, tracking_number: 'RET1', tracking_url: 'https://track.example/RET1', label: { normal_printer: ['https://panel.sendcloud.sc/return/2.pdf'] } },
  });
  const result = await createReturnParcel({
    fromName: 'Ada Test', fromAddress: '1 rue Test', fromCity: 'Paris', fromPostalCode: '75000',
    shippingMethodId: 42, weightKg: 0.5, orderNumber: 'BB123',
  });
  assert.equal(lastRequest.body.parcel.is_return, true);
  assert.equal(lastRequest.body.parcel.name, 'Ada Test');
  assert.equal(result.labelUrl, 'https://panel.sendcloud.sc/return/2.pdf');
});

test('verifyWebhookSignature accepts a correctly signed body and rejects a tampered one', async () => {
  const body = JSON.stringify({ parcel: { order_number: 'BB123', status: { message: 'Delivered' } } });
  const goodSignature = crypto.createHmac('sha256', 'secret_test').update(body, 'utf8').digest('hex');

  assert.equal(verifyWebhookSignature(body, goodSignature), true);
  assert.equal(verifyWebhookSignature(body + 'tampered', goodSignature), false);
  assert.equal(verifyWebhookSignature(body, 'not-even-hex-of-the-right-length'), false);
  assert.equal(verifyWebhookSignature(body, null), false);
});
