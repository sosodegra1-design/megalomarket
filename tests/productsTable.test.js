/*
 * buildProductsFragment (src/services/productsTable.js) — rendu HTML du
 * tableau Produits côté serveur, qui remplace le filtre/tri/pagination
 * autrefois purement client (voir GET /api/products/fragment). Fonction
 * pure : ces tests ne touchent ni la base ni le réseau, et verrouillent que
 * le comportement (filtre, tri, pagination, échappement HTML) reste
 * identique à l'ancien moteur client (createTable() dans index.html).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductsFragment, PRODUCTS_PAGE_SIZE } from '../src/services/productsTable.js';

function product(overrides = {}) {
  return {
    id: 1,
    sku: 'SKU-1',
    name: 'Produit',
    description: '',
    cost_price: 10,
    listings: [],
    ...overrides,
  };
}

test('un catalogue vide renvoie le message vide dédié', () => {
  const result = buildProductsFragment({ products: [] });
  assert.match(result.html, /Aucun produit\. Crée-en un ci-dessus\./);
  assert.equal(result.total, 0);
  assert.equal(result.pages, 1);
});

test('un filtre sans résultat renvoie un message distinct, avec le texte cherché', () => {
  const result = buildProductsFragment({
    products: [product({ name: 'Peluche renard', sku: 'PEL-1' })],
    query: 'drone',
  });
  assert.match(result.html, /Aucun résultat pour « drone »\./);
  assert.equal(result.total, 0);
});

test('le filtre cherche dans le nom, le SKU et la description', () => {
  const products = [
    product({ id: 1, name: 'Peluche renard', sku: 'PEL-1', description: 'douce' }),
    product({ id: 2, name: 'Puzzle bois', sku: 'PUZ-1', description: 'renard des bois' }),
    product({ id: 3, name: 'Ballon', sku: 'BAL-1', description: 'sport' }),
  ];
  const byName = buildProductsFragment({ products, query: 'peluche' });
  assert.equal(byName.total, 1);

  const bySku = buildProductsFragment({ products, query: 'PUZ-1' });
  assert.equal(bySku.total, 1);

  const byDescription = buildProductsFragment({ products, query: 'renard' });
  assert.equal(byDescription.total, 2, 'renard apparaît dans le nom du 1er ET la description du 2e');
});

test('le tri par prix est numérique, pas alphabétique', () => {
  const products = [
    product({ id: 1, name: 'A', cost_price: 9 }),
    product({ id: 2, name: 'B', cost_price: 10 }),
    product({ id: 3, name: 'C', cost_price: 2 }),
  ];
  const asc = buildProductsFragment({ products, sortKey: 'cost_price', sortDir: 'asc' });
  const order = [...asc.html.matchAll(/data-label="Produit"><span class="cell-strong">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['C', 'A', 'B'], 'tri numérique : 2 < 9 < 10, jamais "10" < "2" façon texte');
});

test('le tri desc inverse l\'ordre', () => {
  const products = [
    product({ id: 1, name: 'Abricot' }),
    product({ id: 2, name: 'Zèbre' }),
  ];
  const desc = buildProductsFragment({ products, sortKey: 'name', sortDir: 'desc' });
  const order = [...desc.html.matchAll(/data-label="Produit"><span class="cell-strong">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['Zèbre', 'Abricot']);
});

test('une clé de tri inconnue retombe sur le nom, sans planter', () => {
  const products = [product({ id: 1, name: 'B' }), product({ id: 2, name: 'A' })];
  const result = buildProductsFragment({ products, sortKey: 'unknown-column' });
  const order = [...result.html.matchAll(/data-label="Produit"><span class="cell-strong">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['A', 'B']);
});

test('la pagination respecte PRODUCTS_PAGE_SIZE et borne une page hors limites', () => {
  const products = Array.from({ length: PRODUCTS_PAGE_SIZE + 3 }, (_, i) => product({ id: i, name: `Produit ${String(i).padStart(2, '0')}` }));
  const page1 = buildProductsFragment({ products, page: 1 });
  assert.equal(page1.total, PRODUCTS_PAGE_SIZE + 3);
  assert.equal(page1.pages, 2);
  assert.equal((page1.html.match(/<tr class="row-in">/g) || []).length, PRODUCTS_PAGE_SIZE);

  const tooFar = buildProductsFragment({ products, page: 99 });
  assert.equal(tooFar.page, 2, 'une page demandée trop loin retombe sur la dernière page existante');
});

test('un id/nom/sku est échappé dans le HTML (pas d\'injection possible)', () => {
  const products = [product({ id: '"><img src=x onerror=alert(1)>', name: '<script>alert(1)</script>', sku: '"><b>x</b>' })];
  const result = buildProductsFragment({ products });
  assert.doesNotMatch(result.html, /<script>/);
  assert.doesNotMatch(result.html, /<img src=x/);
  assert.match(result.html, /&lt;script&gt;/);
});

test('les boutons IA sont désactivés quand aiReady est faux', () => {
  const products = [product()];
  const disabled = buildProductsFragment({ products, aiReady: false });
  assert.match(disabled.html, /data-action="suggest"[^>]*disabled/);

  const enabled = buildProductsFragment({ products, aiReady: true });
  assert.doesNotMatch(enabled.html, /data-action="suggest"[^>]*disabled/);
});

test('les fiches canaux publiées apparaissent dans la colonne dédiée', () => {
  const products = [product({ listings: [{ channel: 'ebay', price: 12.5 }, { channel: 'own_site', price: 14.9 }] })];
  const result = buildProductsFragment({ products });
  assert.match(result.html, /ebay 12,50 €/);
  assert.match(result.html, /own_site 14,90 €/);
});
