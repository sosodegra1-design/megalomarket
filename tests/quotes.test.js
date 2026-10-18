import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuoteMessage, buildQuotesReport, cleanTitle } from '../src/services/quotes.js';

test('the message asks for MOQ and shipping cost, in English', () => {
  const text = buildQuoteMessage({ title: 'Balle Magique - Buy Product on Alibaba.com', destination: 'Switzerland' });
  assert.match(text, /minimum order quantity \(MOQ\)/);
  assert.match(text, /shipping cost to Switzerland/);
  assert.ok(!/Buy Product on Alibaba/.test(text));
  assert.equal(cleanTitle('X - Buy Product on Alibaba.com'), 'X');
});

test('only Alibaba imports get a quote request', () => {
  const report = buildQuotesReport([
    { id: 1, title: 'A', source_url: 'https://www.alibaba.com/product-detail/A_1.html' },
    { id: 2, title: 'B', source_url: 'https://fr.aliexpress.com/item/2.html' },
    { id: 3, title: 'C', source_url: '' },
  ]);
  assert.match(report, /1 produit/);
  assert.match(report, /alibaba\.com\/product-detail\/A_1/);
  assert.ok(!/aliexpress/.test(report));
});
