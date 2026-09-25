/*
 * Une page d'annuaire n'est pas une fiche produit.
 *
 * Constaté en production sur un vrai lien Alibaba, après la mise en place de la
 * chaîne de replis : Alibaba ne répond plus 400, il répond 200 avec un mur
 * anti-robot, puis — via m.alibaba.com — avec une page d'annuaire dont le titre
 * est « Alibaba Manufacturer Directory » répété deux fois, et sans aucun prix.
 *
 * Le scraper acceptait ce résultat : l'import était créé avec un titre bidon et
 * un prix à 0. C'est PIRE qu'un échec, parce que l'utilisateur croit que tout
 * s'est bien passé et ne comprend pas pourquoi sa fiche est vide.
 *
 * Ces tests verrouillent le refus de ces pages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeProductFromUrl } from '../src/importer/scraper.js';

const publicLookup = async () => ['93.184.216.34'];

function pageResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => body,
  };
}

function mockFetch(handler) {
  const original = global.fetch;
  const state = { calls: [] };
  global.fetch = async (url, options = {}) => {
    state.calls.push({ url: String(url), headers: options.headers || {} });
    return handler(String(url), options);
  };
  return { state, restore: () => { global.fetch = original; } };
}

/** La page d'annuaire exacte que renvoie m.alibaba.com : titre doublé, pas de prix. */
const DIRECTORY_PAGE = `
<html><head>
  <title>Alibaba Manufacturer DirectoryAlibaba Manufacturer Directory</title>
  <meta property="og:title" content="Alibaba Manufacturer DirectoryAlibaba Manufacturer Directory">
</head><body><h1>Alibaba Manufacturer Directory</h1></body></html>`;

test('un titre générique répété n’est pas accepté comme un produit', async () => {
  const mock = mockFetch(() => pageResponse(DIRECTORY_PAGE));
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://www.alibaba.com/product-detail/x_123.html', { lookupHost: publicLookup }),
      (error) => {
        // Le message doit dire ce qui a été tenté, et non prétendre avoir réussi.
        assert.match(error.message, /Stratégies essayées/);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test('le scraper continue l’échelle au lieu de s’arrêter sur une page d’annuaire', async () => {
  // La première identité reçoit l'annuaire, la suivante reçoit enfin le produit.
  const REAL_PRODUCT = `<html><head>
    <meta property="og:title" content="Memo Pad electronique pour enfants">
    <meta property="product:price:amount" content="3.85">
    <meta property="product:price:currency" content="USD">
  </head><body></body></html>`;

  let seen = 0;
  const mock = mockFetch(() => {
    seen += 1;
    return pageResponse(seen === 1 ? DIRECTORY_PAGE : REAL_PRODUCT);
  });

  try {
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product-detail/x_123.html', { lookupHost: publicLookup });
    assert.equal(result.title, 'Memo Pad electronique pour enfants');
    assert.equal(result.purchasePrice, 3.85);
    assert.ok(seen > 1, 'le scraper doit avoir réessayé au lieu d’accepter la page d’annuaire');
  } finally {
    mock.restore();
  }
});

test('un mur anti-robot dans le titre est refusé, même sans les mots du corps', async () => {
  const CAPTCHA_TITLE = `<html><head>
    <meta property="og:title" content="Just a moment...">
  </head><body><p>Vérification en cours</p></body></html>`;

  const mock = mockFetch(() => pageResponse(CAPTCHA_TITLE));
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://exemple-test.example/produit/1.html', { lookupHost: publicLookup }),
      /Stratégies essayées/,
    );
  } finally {
    mock.restore();
  }
});
