import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeProductFromUrl } from '../src/importer/scraper.js';

function mockFetchOnce(html, { ok = true, status = 200 } = {}) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok,
    status,
    text: async () => html,
  });
  return () => {
    global.fetch = originalFetch;
  };
}

test('extracts title, price and images from JSON-LD product data', async () => {
  const html = `
    <html><head>
      <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Peluche renard 30cm",
          "description": "Une douce peluche pour enfants",
          "image": ["https://supplier.example/img1.jpg", "/img2.jpg"],
          "offers": {"price": "4.90", "priceCurrency": "USD"}
        }
      </script>
    </head><body><h1>Ignoré (JSON-LD prioritaire)</h1></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://www.aliexpress.com/item/123.html');
    assert.equal(result.sourceSite, 'aliexpress');
    assert.equal(result.title, 'Peluche renard 30cm');
    assert.equal(result.purchasePrice, 4.9);
    assert.equal(result.currency, 'USD');
    assert.deepEqual(result.imageUrls, [
      'https://supplier.example/img1.jpg',
      'https://www.aliexpress.com/img2.jpg',
    ]);
  } finally {
    restore();
  }
});

test('falls back to og:title/meta description when no JSON-LD is present', async () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Doudou lapin">
      <meta name="description" content="Un doudou tout doux">
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product/456.html');
    assert.equal(result.sourceSite, 'alibaba');
    assert.equal(result.title, 'Doudou lapin');
    assert.equal(result.rawDescription, 'Un doudou tout doux');
  } finally {
    restore();
  }
});

test('throws a clear error when the page has no exploitable title (bot-blocked page)', async () => {
  const restore = mockFetchOnce('<html><head></head><body></body></html>');
  try {
    await assert.rejects(() => scrapeProductFromUrl('https://www.alibaba.com/blocked.html'), /bloque/);
  } finally {
    restore();
  }
});

test('rejects an invalid URL before making any request', async () => {
  await assert.rejects(() => scrapeProductFromUrl('not-a-url'), /invalide/);
});
