/*
 * Décodage des entités HTML dans les titres et descriptions extraits.
 *
 * Constaté en production sur un vrai import Alibaba (id 9) :
 *
 *   « Tableau De Dessin Lumineux Led Carr&eacute; En Acrylique Pour Enfants
 *     Avec Tableau D&#39;&eacute;criture Effa&ccedil;able »
 *
 * La cause : cheerio décode les entités de `.text()`, mais PAS celles d'un
 * attribut — et le titre venait de `meta[property="og:title"]` / `content`.
 * Ces entités partaient donc telles quelles dans le nom du produit, puis dans
 * les annonces publiées. Sur une boutique française, où les accents sont
 * partout, ce n'est pas un détail cosmétique.
 *
 * Ces tests verrouillent le décodage sur les DEUX chemins d'extraction — HTML
 * direct et lecteur tiers (markdown) — et vérifient qu'on ne décode qu'une fois.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeProductFromUrl } from '../src/importer/scraper.js';

const publicLookup = async () => ['93.184.216.34'];

function pageResponse(body, { status = 200, contentType = 'text/html; charset=utf-8' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

/** Installe un fetch routé par préfixe d'URL, et rend les appels observables. */
function mockFetchRouter(handler) {
  const original = global.fetch;
  const state = { calls: [] };
  global.fetch = async (url, options = {}) => {
    state.calls.push({ url: String(url) });
    return handler(String(url), options);
  };
  return { state, restore: () => { global.fetch = original; } };
}

/** Page produit minimale dont le titre vient d'un attribut `content`. */
function pageWithOgTitle(title) {
  return `<html><head>
    <meta property="og:title" content="${title}">
    <meta property="product:price:amount" content="2.67">
    <meta property="product:price:currency" content="USD">
  </head><body></body></html>`;
}

const URL_TEST = 'https://exemple-public.example/produit/1.html';

/* ===================== CHEMIN HTML DIRECT ===================== */

test('les entités nommées d’un og:title sont décodées (cas réel Alibaba)', async () => {
  const mock = mockFetchRouter(() => pageResponse(pageWithOgTitle(
    'Tableau De Dessin Lumineux Led Carr&eacute; En Acrylique Pour Enfants Avec Tableau D&#39;&eacute;criture Effa&ccedil;able',
  )));
  try {
    const result = await scrapeProductFromUrl(URL_TEST, { lookupHost: publicLookup });
    assert.equal(
      result.title,
      "Tableau De Dessin Lumineux Led Carré En Acrylique Pour Enfants Avec Tableau D'écriture Effaçable",
    );
  } finally {
    mock.restore();
  }
});

test('les entités numériques décimales et hexadécimales sont décodées', async () => {
  const mock = mockFetchRouter(() => pageResponse(pageWithOgTitle(
    'Memo Pad &#233;lectronique &#x26; jouet &#x20AC;',
  )));
  try {
    const result = await scrapeProductFromUrl(URL_TEST, { lookupHost: publicLookup });
    assert.equal(result.title, 'Memo Pad électronique & jouet €');
  } finally {
    mock.restore();
  }
});

test('&nbsp; devient une espace ordinaire, jamais une espace insécable', async () => {
  const mock = mockFetchRouter(() => pageResponse(pageWithOgTitle('Doudou&nbsp;lapin&nbsp;&nbsp;rose')));
  try {
    const result = await scrapeProductFromUrl(URL_TEST, { lookupHost: publicLookup });
    assert.equal(result.title, 'Doudou lapin rose');
    // Une espace insécable survivrait à l'affichage et casserait les recherches.
    assert.ok(!result.title.includes('\u00a0'), 'aucune espace insécable ne doit rester');
  } finally {
    mock.restore();
  }
});

test('le décodage s’applique aussi à la description', async () => {
  const page = `<html><head>
    <meta property="og:title" content="Doudou lapin">
    <meta property="og:description" content="Prix 12,50 &euro; &amp; livraison &quot;rapide&quot;">
    <meta property="product:price:amount" content="12.50">
    <meta property="product:price:currency" content="EUR">
  </head><body></body></html>`;
  const mock = mockFetchRouter(() => pageResponse(page));
  try {
    const result = await scrapeProductFromUrl(URL_TEST, { lookupHost: publicLookup });
    assert.equal(result.rawDescription, 'Prix 12,50 € & livraison "rapide"');
  } finally {
    mock.restore();
  }
});

test('une entité n’est décodée qu’UNE fois : &amp;eacute; reste le texte « &eacute; »', async () => {
  // Un double décodage transformerait un titre littéralement échappé en accent,
  // c'est-à-dire corromprait une donnée que le site affichait correctement.
  const mock = mockFetchRouter(() => pageResponse(pageWithOgTitle('Guide &amp;eacute;tape par &amp;eacute;tape')));
  try {
    const result = await scrapeProductFromUrl(URL_TEST, { lookupHost: publicLookup });
    assert.equal(result.title, 'Guide &eacute;tape par &eacute;tape');
  } finally {
    mock.restore();
  }
});

test('le refus des pages d’annuaire s’applique APRÈS décodage', async () => {
  // Le titre doublé n'apparaît qu'une fois les entités décodées : si le contrôle
  // passait avant, la page d'annuaire serait acceptée et créerait un import vide
  // — exactement le faux succès déjà corrigé.
  const mock = mockFetchRouter(() => pageResponse(pageWithOgTitle(
    'Alibaba Manufacturer&nbsp;DirectoryAlibaba Manufacturer&nbsp;Directory',
  )));
  try {
    await assert.rejects(
      () => scrapeProductFromUrl(URL_TEST, { lookupHost: publicLookup }),
      /Stratégies essayées/,
    );
  } finally {
    mock.restore();
  }
});

/* ===================== CHEMIN JSON-LD (LA SOURCE DU BUG) ===================== */

test('le JSON-LD est décodé : c’est LA source du titre « Carr&eacute; » vu en production', async () => {
  // Les valeurs du DOM sont déjà décodées par cheerio ; celles du JSON-LD, non,
  // parce qu'elles ne traversent que `JSON.parse`. Le JSON-LD est prioritaire
  // sur l'og:title, donc c'est bien lui qui produisait le titre fautif.
  const page = `<html><head>
    <meta property="og:title" content="Titre de repli sans accent">
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Tableau De Dessin Lumineux Led Carr&eacute; En Acrylique Avec Tableau D&#39;&eacute;criture Effa&ccedil;able',
      description: 'Prix 12,50 &euro; &amp; livraison &quot;rapide&quot;',
      offers: { '@type': 'Offer', price: '2.67', priceCurrency: 'USD' },
    })}</script>
  </head><body></body></html>`;

  const mock = mockFetchRouter(() => pageResponse(page));
  try {
    const result = await scrapeProductFromUrl(URL_TEST, { lookupHost: publicLookup });
    assert.equal(
      result.title,
      "Tableau De Dessin Lumineux Led Carré En Acrylique Avec Tableau D'écriture Effaçable",
    );
    assert.equal(result.rawDescription, 'Prix 12,50 € & livraison "rapide"');
    assert.equal(result.purchasePrice, 2.67);
    assert.equal(result.currency, 'USD');
  } finally {
    mock.restore();
  }
});

test('le JSON-LD n’est décodé qu’une fois lui aussi', async () => {
  const page = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'Guide &amp;eacute;tape par &amp;eacute;tape',
      offers: { '@type': 'Offer', price: '5', priceCurrency: 'EUR' },
    })}</script>
  </head><body></body></html>`;
  const mock = mockFetchRouter(() => pageResponse(page));
  try {
    const result = await scrapeProductFromUrl(URL_TEST, { lookupHost: publicLookup });
    assert.equal(result.title, 'Guide &eacute;tape par &eacute;tape');
  } finally {
    mock.restore();
  }
});

/* ===================== CHEMIN LECTEUR TIERS (MARKDOWN) ===================== */

test('le markdown du lecteur tiers est décodé lui aussi', async () => {
  const routes = mockFetchRouter((url) => {
    if (url.startsWith('https://archive.org/wayback/available')) {
      return pageResponse('{"archived_snapshots":{}}', { contentType: 'application/json' });
    }
    if (url.startsWith('https://r.jina.ai/')) {
      return pageResponse(
        'Title: Doudou lapin &eacute;veill&eacute;\n\nMarkdown Content:\n# Doudou lapin\n\nPrix : 12,50 €\n',
        { contentType: 'text/plain' },
      );
    }
    return pageResponse('Forbidden', { status: 403 });
  });
  try {
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product/10.html', { lookupHost: publicLookup });
    assert.equal(result.strategy, 'jina');
    assert.equal(result.title, 'Doudou lapin éveillé');
  } finally {
    routes.restore();
  }
});
