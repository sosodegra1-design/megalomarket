/*
 * GET /api/products/fragment — le fragment HTML partiel qui a remplacé le
 * filtre/tri/pagination purement client sur la table Produits (voir
 * services/productsTable.js). Verrouille : l'authentification, la
 * pagination portée par les en-têtes X-Total-Count/X-Page/X-Pages (jamais
 * mélangée au corps HTML), et que le filtre/tri passés en query string sont
 * bien appliqués.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-products-fragment-')), 'fragment.db');
const ADMIN_KEY = 'cle-de-test-products-fragment';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbAll } = await import('../src/db/database.js');

let server;
let base;

async function call(path) {
  const response = await fetch(base + path, { headers: { 'X-Admin-Key': ADMIN_KEY } });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

async function createProduct({ sku, name, costPrice = 10 }) {
  await dbRun(
    'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)',
    [sku, name, '', costPrice, Date.now()],
  );
}

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await createProduct({ sku: 'PEL-1', name: 'Peluche renard', costPrice: 8.5 });
  await createProduct({ sku: 'PUZ-1', name: 'Puzzle bois', costPrice: 12 });
  await createProduct({ sku: 'BAL-1', name: 'Ballon de sport', costPrice: 5 });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('la route exige la clé admin', async () => {
  const response = await fetch(base + '/api/products/fragment');
  assert.equal(response.status, 401);
});

test('renvoie du HTML avec la pagination dans les en-têtes, pas dans le corps', async () => {
  const { status, headers, text } = await call('/api/products/fragment');
  assert.equal(status, 200);
  assert.match(headers.get('content-type'), /html/);
  assert.equal(headers.get('x-total-count'), '3');
  assert.equal(headers.get('x-page'), '1');
  assert.equal(headers.get('x-pages'), '1');
  assert.match(text, /Peluche renard/);
  assert.match(text, /Puzzle bois/);
  assert.match(text, /Ballon de sport/);
  assert.doesNotMatch(text, /"total"|"page"|"pages"/, 'les métadonnées ne doivent pas fuiter dans le HTML');
});

test('le filtre (q) réduit les lignes ET met à jour X-Total-Count', async () => {
  const { text, headers } = await call('/api/products/fragment?q=puzzle');
  assert.equal(headers.get('x-total-count'), '1');
  assert.match(text, /Puzzle bois/);
  assert.doesNotMatch(text, /Peluche renard/);
});

test('le tri (sort/dir) change l\'ordre des lignes', async () => {
  const asc = await call('/api/products/fragment?sort=cost_price&dir=asc');
  const ascOrder = [...asc.text.matchAll(/cell-strong">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(ascOrder, ['Ballon de sport', 'Peluche renard', 'Puzzle bois']);

  const desc = await call('/api/products/fragment?sort=cost_price&dir=desc');
  const descOrder = [...desc.text.matchAll(/cell-strong">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(descOrder, ['Puzzle bois', 'Peluche renard', 'Ballon de sport']);
});

test('un catalogue vide renvoie le message vide, pas une erreur', async () => {
  const products = await dbAll('SELECT id FROM products');
  for (const { id } of products) {
    await dbRun('DELETE FROM channel_listings WHERE product_id = ?', [id]);
    await dbRun('DELETE FROM products WHERE id = ?', [id]);
  }
  const { text, headers } = await call('/api/products/fragment');
  assert.equal(headers.get('x-total-count'), '0');
  assert.match(text, /Aucun produit/);
});
