/*
 * Recherche fournisseur réelle (src/ai/supplierFinder.js, Perplexity Agent
 * API, POST /api/niches/supplier-search).
 *
 * Remplace le bug signalé en production : le bouton "Chercher chez un
 * fournisseur" du Dénicheur renvoyait d'abord toujours vers Alibaba, puis
 * vers une recherche Google générique — jamais une vraie page fournisseur.
 * Ce module appelle réellement l'Agent API (web_search) et extrait les liens
 * sourcés de la réponse. Aucun réseau réel dans ces tests : `fetch` est stubé,
 * même convention que nicheHunter.test.js / nicheCoach.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-supplier-finder-')), 'supplier.db');
const ADMIN_KEY = 'cle-de-test-supplier-finder-0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;

function stubPerplexityFetch(handler) {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).includes('api.perplexity.ai')) return original(url, options);
    return handler(url, options);
  };
  return () => { global.fetch = original; };
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// config.perplexity reads process.env live via getters (see config/env.js),
// so a single shared import already reacts to process.env changes below —
// no need to re-import the module per test.
const { findSupplierLinks } = await import('../src/ai/supplierFinder.js');

let server;
let base;

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

test('without PERPLEXITY_API_KEY, the module refuses before any network call', async () => {
  delete process.env.PERPLEXITY_API_KEY;
  await assert.rejects(
    () => findSupplierLinks({ title: 'Gourde isotherme' }),
    /PERPLEXITY_API_KEY manquante/,
  );
});

test('the prompt requires a verified product+price page, forbids generic category pages, and asks fetch_url to be used', async () => {
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  const restore = stubPerplexityFetch(async (url, options) => {
    const sentBody = JSON.parse(options.body);
    assert.match(sentBody.input, /prix visible/);
    assert.match(sentBody.input, /page de catégorie générique/);
    assert.match(sentBody.input, /Europe/);
    return jsonResponse(200, { output_text: 'ok', search_results: [] });
  });
  try {
    await findSupplierLinks({ title: 'Gourde isotherme', sourcingHint: 'fabricant en Pologne' });
  } finally {
    restore();
  }
});

test('a successful call merges links from search_results and from text annotations, deduplicated by URL', async () => {
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  const restore = stubPerplexityFetch(async (url, options) => {
    assert.equal(String(url), 'https://api.perplexity.ai/v1/agent');
    assert.equal(options.headers.Authorization, 'Bearer cle-de-test-perplexity');
    const sentBody = JSON.parse(options.body);
    assert.match(sentBody.input, /Gourde isotherme/);
    // Le preset "pro-search" (réglé par Perplexity elle-même) inclut déjà
    // web_search ET l'ouverture de page — un choix manuel de modèle+outils
    // avait saturé le service en production (HTTP 429 "overloaded") dès
    // que la consigne forçait l'ouverture de plusieurs pages.
    assert.equal(sentBody.preset, 'pro-search');
    assert.equal(sentBody.model, undefined);
    assert.equal(sentBody.tools, undefined);
    return jsonResponse(200, {
      output_text: 'Voici deux fournisseurs vérifiés.',
      search_results: [
        { url: 'https://www.europages.fr/entreprises/exemple.html', title: 'Europages — Exemple' },
      ],
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Voici deux fournisseurs vérifiés.',
              annotations: [
                { type: 'citation', url: 'https://www.europages.fr/entreprises/exemple.html', title: 'Europages — Exemple' },
                { type: 'citation', url: 'https://fabricant-reel.example/fiche', title: 'Fabricant réel' },
              ],
            },
          ],
        },
      ],
    });
  });
  try {
    const result = await findSupplierLinks({ title: 'Gourde isotherme', sourcingHint: 'fabricant en Pologne' });
    assert.equal(result.links.length, 2, 'la même URL vue deux fois (search_results + annotation) ne doit compter qu\'une fois');
    const urls = result.links.map((l) => l.url).sort();
    assert.deepEqual(urls, [
      'https://fabricant-reel.example/fiche',
      'https://www.europages.fr/entreprises/exemple.html',
    ]);
    assert.match(result.outputText, /fournisseurs vérifiés/);
  } finally {
    restore();
  }
});

test('a 401 from Perplexity surfaces as a clear authentication error', async () => {
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  const restore = stubPerplexityFetch(async () => jsonResponse(401, { error: 'invalid api key' }));
  try {
    await assert.rejects(
      () => findSupplierLinks({ title: 'Produit' }),
      /HTTP 401.*PERPLEXITY_API_KEY/s,
    );
  } finally {
    restore();
  }
});

test('a transient 429 ("overloaded") is retried once automatically and can still succeed', async () => {
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  let callCount = 0;
  const restore = stubPerplexityFetch(async () => {
    callCount += 1;
    if (callCount === 1) return jsonResponse(429, { error: 'overloaded' }, { 'retry-after': '0' });
    return jsonResponse(200, {
      output_text: 'Trouvé après réessai.',
      search_results: [{ url: 'https://www.europages.fr/entreprises/apres-retry.html', title: 'Après réessai' }],
    });
  });
  try {
    const result = await findSupplierLinks({ title: 'Produit' });
    assert.equal(callCount, 2, 'le module doit avoir réessayé une fois sans que l\'appelant n\'ait à recliquer');
    assert.equal(result.links.length, 1);
    assert.equal(result.links[0].url, 'https://www.europages.fr/entreprises/apres-retry.html');
  } finally {
    restore();
  }
});

test('a 429 that persists after the retry surfaces a clear, final error', async () => {
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  let callCount = 0;
  const restore = stubPerplexityFetch(async () => {
    callCount += 1;
    return jsonResponse(429, { error: 'rate limited' }, { 'retry-after': '0' });
  });
  try {
    await assert.rejects(
      () => findSupplierLinks({ title: 'Produit' }),
      /HTTP 429.*réessai/s,
    );
    assert.equal(callCount, 2, 'exactement un réessai, pas une boucle infinie');
  } finally {
    restore();
  }
});

test('when structured citations are absent, URLs written in the text itself (Markdown or bare) are still recovered', async () => {
  // Le champ exact des citations structurées n'a pas pu être vérifié contre
  // la doc officielle (docs.perplexity.ai était bloquée par le proxy réseau
  // pendant le développement) — le prompt demande donc des URL en clair, et
  // l'extraction doit les retrouver même sans search_results ni annotations.
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  const restore = stubPerplexityFetch(async () => jsonResponse(200, {
    output_text: 'Voici [Europages — Exemple](https://www.europages.fr/entreprises/exemple.html) '
      + 'et aussi https://fabricant-reel.example/fiche, deux pistes sérieuses.',
  }));
  try {
    const result = await findSupplierLinks({ title: 'Lampe de chevet LED' });
    const urls = result.links.map((l) => l.url).sort();
    assert.deepEqual(urls, [
      'https://fabricant-reel.example/fiche',
      'https://www.europages.fr/entreprises/exemple.html',
    ]);
    const markdownLink = result.links.find((l) => l.url.includes('europages'));
    assert.equal(markdownLink.label, 'Europages — Exemple', 'le libellé Markdown doit être conservé, pas juste l\'URL brute');
  } finally {
    restore();
  }
});

test('a Google or Bing search URL is never surfaced, even if the model cites one in its text', async () => {
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  const restore = stubPerplexityFetch(async () => jsonResponse(200, {
    output_text: 'Essaie https://www.google.com/search?q=fabricant+lampe ou https://vrai-fabricant.example/fiche.',
    search_results: [{ url: 'https://www.bing.com/search?q=lampe', title: 'Bing' }],
  }));
  try {
    const result = await findSupplierLinks({ title: 'Lampe de chevet LED' });
    const urls = result.links.map((l) => l.url);
    assert.ok(!urls.some((u) => u.includes('google.com') || u.includes('bing.com')), 'un lien de moteur de recherche ne doit jamais passer, même cité par le modèle');
    assert.deepEqual(urls, ['https://vrai-fabricant.example/fiche']);
  } finally {
    restore();
  }
});

test('a response with no links at all comes back as an empty (not fabricated) list', async () => {
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  const restore = stubPerplexityFetch(async () => jsonResponse(200, {
    output_text: "Aucun fournisseur vérifiable trouvé pour ce produit précis.",
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Aucun fournisseur vérifiable trouvé.', annotations: [] }] }],
  }));
  try {
    const result = await findSupplierLinks({ title: 'Produit très spécifique' });
    assert.deepEqual(result.links, []);
    assert.match(result.outputText, /Aucun fournisseur/);
  } finally {
    restore();
  }
});

/* ===================== POST /api/niches/supplier-search ===================== */

before(async () => {
  process.env.PERPLEXITY_API_KEY = 'cle-de-test-perplexity';
  const { app } = await import('../src/server.js');
  const { initDatabase } = await import('../src/db/database.js');
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('the route requires the admin key', async () => {
  const response = await fetch(base + '/api/niches/supplier-search', { method: 'POST' });
  assert.equal(response.status, 401);
});

test('the route returns the real links found for a given title/sourcingHint', async () => {
  const restore = stubPerplexityFetch(async () => jsonResponse(200, {
    output_text: 'Un fournisseur trouvé.',
    search_results: [{ url: 'https://www.europages.fr/entreprises/vrai-fournisseur.html', title: 'Vrai fournisseur' }],
  }));
  let result;
  try {
    result = await call('/api/niches/supplier-search', {
      method: 'POST',
      body: { title: 'Support téléphone vélo', sourcingHint: 'fabricant accessoires vélo au Portugal' },
    });
  } finally {
    restore();
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.links.length, 1);
  assert.equal(result.body.links[0].url, 'https://www.europages.fr/entreprises/vrai-fournisseur.html');
});

test('a missing title is refused before any network call', async () => {
  const restore = stubPerplexityFetch(async () => {
    throw new Error('must not be called');
  });
  let result;
  try {
    result = await call('/api/niches/supplier-search', { method: 'POST', body: {} });
  } finally {
    restore();
  }
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Titre du produit manquant/);
});
