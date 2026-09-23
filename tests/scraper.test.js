import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeProductFromUrl } from '../src/importer/scraper.js';

/**
 * Résolveur DNS factice : les tests ne doivent JAMAIS toucher au réseau. La
 * protection SSRF résout le nom avant de requêter ; on lui injecte donc une
 * adresse publique au lieu de laisser un vrai `dns.lookup` s'exécuter.
 */
const publicLookup = async () => ['93.184.216.34'];

function mockFetchOnce(html, { ok = true, status = 200, headers = {} } = {}) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => html,
  });
  return () => {
    global.fetch = originalFetch;
  };
}

/** Installe un `fetch` qui doit rester inutilisé (cas d'une URL refusée avant tout appel). */
function forbidFetch() {
  const originalFetch = global.fetch;
  const state = { calls: 0 };
  global.fetch = async () => {
    state.calls += 1;
    throw new Error('fetch ne doit pas être appelé pour une URL refusée');
  };
  return { state, restore: () => { global.fetch = originalFetch; } };
}

/**
 * Sert une réponse différente par appel `fetch` et mémorise les URLs demandées.
 * Le suivi des redirections étant désormais manuel (`redirect: 'manual'`), une
 * chaîne déclenche plusieurs `fetch` qu'il faut piloter un par un — toujours sans
 * toucher au réseau.
 */
function mockFetchSequence(responses) {
  const originalFetch = global.fetch;
  const state = { calls: 0, urls: [], options: [] };
  global.fetch = async (url, options = {}) => {
    state.urls.push(String(url));
    state.options.push(options);
    const response = responses[state.calls];
    state.calls += 1;
    if (!response) throw new Error(`fetch inattendu (appel n°${state.calls})`);
    return response;
  };
  return { state, restore: () => { global.fetch = originalFetch; } };
}

/** Réponse 3xx minimale, du même shape que ce qu'attend `readBodyWithLimit`. */
function redirectResponse(location, { status = 302, body = '' } = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'location' ? location : null) },
    text: async () => body,
  };
}

/** Réponse 200 minimale dont le titre est exploitable par l'extraction. */
function htmlResponse(title = 'Produit') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => `<html><head><title>${title}</title></head></html>`,
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
    const result = await scrapeProductFromUrl('https://www.aliexpress.com/item/123.html', { lookupHost: publicLookup });
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

test('le scan générique <img> ignore les logos, badges de paiement et vignettes du pied de page', async () => {
  // Reproduit un bug réel : une fiche produit sans JSON-LD complet a vu sa
  // galerie polluée par des dizaines de logos de moyens de paiement et de
  // pictogrammes de navigation, ramassés par le scan <img> générique faute de
  // filtre suffisant. Cette page imite la structure typique d'une boutique
  // (en-tête avec logo, contenu produit, pied de page avec badges de
  // confiance) pour vérifier que seules les vraies photos survivent.
  const html = `
    <html><body>
      <header>
        <img src="/assets/brand-logo.png" alt="Boutique">
        <img src="/assets/search-icon.png" width="20" height="20">
        <img src="/assets/globe-lang.png" width="18" height="18">
      </header>
      <main>
        <h1>Puzzle 3D en bois - Tour Eiffel</h1>
        <img src="/produits/eiffel-1.jpg">
        <img src="/produits/eiffel-2.jpg">
        <img src="/produits/eiffel-3.jpg">
      </main>
      <footer>
        <img src="/assets/visa.png">
        <img src="/assets/mastercard.png">
        <img src="/assets/paypal.png">
        <img src="/assets/applepay.png">
        <img src="/assets/klarna.png">
        <img src="/assets/trustpilot-badge.png">
        <img src="/assets/ssl-secure.png">
      </footer>
    </body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://boutique.example.com/produit/puzzle-eiffel', { lookupHost: publicLookup });
    assert.deepEqual(result.imageUrls, [
      'https://boutique.example.com/produits/eiffel-1.jpg',
      'https://boutique.example.com/produits/eiffel-2.jpg',
      'https://boutique.example.com/produits/eiffel-3.jpg',
    ]);
  } finally {
    restore();
  }
});

test('le scan générique <img> plafonne à 16 images même sans indice de mise en page', async () => {
  const photos = Array.from({ length: 25 }, (_, i) => `<img src="/photos/produit-${i}.jpg">`).join('\n');
  const html = `<html><body><h1>Grand lot de photos</h1>${photos}</body></html>`;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://boutique.example.com/produit/lot', { lookupHost: publicLookup });
    assert.equal(result.imageUrls.length, 16);
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
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product/456.html', { lookupHost: publicLookup });
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
    await assert.rejects(
      () => scrapeProductFromUrl('https://www.alibaba.com/blocked.html', { lookupHost: publicLookup }),
      /bloque/,
    );
  } finally {
    restore();
  }
});

test('rejects an invalid URL before making any request', async () => {
  await assert.rejects(() => scrapeProductFromUrl('not-a-url'), /invalide/);
});

test('rejects a non-http(s) scheme before any resolution or request', async () => {
  const forbidden = forbidFetch();
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('ftp://www.alibaba.com/product/1.html', { lookupHost: publicLookup }),
      /invalide/,
    );
    assert.equal(forbidden.state.calls, 0);
  } finally {
    forbidden.restore();
  }
});

test('rejects a URL with embedded credentials', async () => {
  const forbidden = forbidFetch();
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('http://user:pass@www.alibaba.com/product/1.html', { lookupHost: publicLookup }),
      /refusée/,
    );
    assert.equal(forbidden.state.calls, 0);
  } finally {
    forbidden.restore();
  }
});

test('rejects localhost and *.internal/*.local hostnames without a DNS lookup or request', async () => {
  const forbidden = forbidFetch();
  let lookups = 0;
  const lookupThatMustNotRun = async () => {
    lookups += 1;
    return ['93.184.216.34'];
  };
  try {
    for (const url of [
      'http://localhost:3000/product/1.html',
      'https://shop.internal/product/1.html',
      'https://nas.local/product/1.html',
    ]) {
      await assert.rejects(() => scrapeProductFromUrl(url, { lookupHost: lookupThatMustNotRun }), /refusée/);
    }
    assert.equal(lookups, 0, 'les hôtes internes connus ne doivent pas déclencher de résolution DNS');
    assert.equal(forbidden.state.calls, 0);
  } finally {
    forbidden.restore();
  }
});

test('rejects private, loopback, link-local and IPv4-mapped IPv6 literals', async () => {
  const forbidden = forbidFetch();
  try {
    for (const url of [
      'http://192.168.1.10/product/1.html',
      'http://10.0.0.5/product/1.html',
      'http://172.16.4.4/product/1.html',
      'http://127.0.0.1:8080/product/1.html',
      'http://169.254.169.254/latest/meta-data/', // métadonnées cloud
      'http://[::1]/product/1.html',
      'http://[::ffff:127.0.0.1]/product/1.html',
      'http://[fe80::1]/product/1.html',
      'http://[fc00::1]/product/1.html',
      'http://[fec0::1]/product/1.html',
    ]) {
      await assert.rejects(() => scrapeProductFromUrl(url, { lookupHost: publicLookup }), /refusée/, url);
    }
    assert.equal(forbidden.state.calls, 0);
  } finally {
    forbidden.restore();
  }
});

test('rejects a public hostname that resolves to a private address', async () => {
  const forbidden = forbidFetch();
  try {
    await assert.rejects(
      () =>
        scrapeProductFromUrl('https://supplier.example.com/product/1.html', {
          lookupHost: async () => ['93.184.216.34', '169.254.169.254'],
        }),
      /interne/,
    );
    assert.equal(forbidden.state.calls, 0);
  } finally {
    forbidden.restore();
  }
});

test('surfaces a clear error when the hostname cannot be resolved', async () => {
  const forbidden = forbidFetch();
  try {
    await assert.rejects(
      () =>
        scrapeProductFromUrl('https://unknown.example.com/product/1.html', {
          lookupHost: async () => { throw new Error('ENOTFOUND'); },
        }),
      /résoudre/,
    );
    assert.equal(forbidden.state.calls, 0);
  } finally {
    forbidden.restore();
  }
});

test('rejects a body that exceeds the byte limit instead of loading it all', async () => {
  const html = `<html><body>${'a'.repeat(4096)}</body></html>`;
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://www.alibaba.com/huge.html', { lookupHost: publicLookup, maxBytes: 512 }),
      /volumineuse/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects a body announced too large by Content-Length', async () => {
  const restore = mockFetchOnce('<html><head><title>X</title></head></html>', {
    headers: { 'content-length': String(50 * 1024 * 1024) },
  });
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://www.alibaba.com/huge.html', { lookupHost: publicLookup }),
      /volumineuse/,
    );
  } finally {
    restore();
  }
});

test('aborts with a clear message when the supplier page never responds', async () => {
  const originalFetch = global.fetch;
  const signals = [];
  global.fetch = async (_url, options = {}) => {
    signals.push(options.signal);
    return new Promise((_resolve, reject) => {
      // Un fetch réel rejette avec la raison du signal quand le délai expire.
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://www.alibaba.com/slow.html', { lookupHost: publicLookup, timeoutMs: 10 }),
      /Délai dépassé/,
    );
    assert.equal(signals.length, 1);
    assert.ok(signals[0] instanceof AbortSignal, 'le fetch doit recevoir un AbortSignal');
  } finally {
    global.fetch = originalFetch;
  }
});

test('follows a redirect chain within the limit and re-validates every hop', async () => {
  const lookedUp = [];
  const lookupHost = async (hostname) => {
    lookedUp.push(hostname);
    return ['93.184.216.34'];
  };
  const seq = mockFetchSequence([
    redirectResponse('https://www.alibaba.com/final/1.html'),
    redirectResponse('/final/2.html'), // relative : doit rester sur www.alibaba.com
    htmlResponse('Peluche redirigée'),
  ]);
  try {
    const result = await scrapeProductFromUrl('https://supplier.example/start.html', { lookupHost });
    assert.equal(result.title, 'Peluche redirigée');
    assert.deepEqual(seq.state.urls, [
      'https://supplier.example/start.html',
      'https://www.alibaba.com/final/1.html',
      'https://www.alibaba.com/final/2.html',
    ]);
    assert.ok(lookedUp.includes('supplier.example'));
    assert.ok(lookedUp.includes('www.alibaba.com'), 'chaque saut doit être résolu et validé');
    for (const options of seq.state.options) {
      assert.equal(options.redirect, 'manual', 'le suivi doit rester manuel pour re-valider chaque cible');
      assert.ok(options.signal instanceof AbortSignal);
    }
  } finally {
    seq.restore();
  }
});

test('refuses a redirect to an internal network address', async () => {
  const seq = mockFetchSequence([redirectResponse('http://169.254.169.254/latest/meta-data/')]);
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://supplier.example/product/1.html', { lookupHost: publicLookup }),
      /interne/,
    );
    assert.equal(seq.state.calls, 1, "la cible interne ne doit jamais être requêtée");
  } finally {
    seq.restore();
  }
});

test('refuses a redirect whose hostname resolves to a private address', async () => {
  const seq = mockFetchSequence([redirectResponse('https://nas.example.com/product/1.html')]);
  const lookupHost = async (hostname) =>
    hostname === 'nas.example.com' ? ['192.168.1.10'] : ['93.184.216.34'];
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://supplier.example/product/1.html', { lookupHost }),
      /interne/,
    );
    assert.equal(seq.state.calls, 1);
  } finally {
    seq.restore();
  }
});

test('refuses a redirect chain longer than the limit', async () => {
  const responses = Array.from({ length: 10 }, (_, index) =>
    redirectResponse(`https://supplier.example/hop/${index}.html`),
  );
  const seq = mockFetchSequence(responses);
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://supplier.example/start.html', { lookupHost: publicLookup }),
      /redirections/,
    );
    // 1 requête initiale + 5 redirections suivies ; la 6e est refusée sans être requêtée.
    assert.equal(seq.state.calls, 6);
  } finally {
    seq.restore();
  }
});

test('refuses a redirect to a non-http(s) scheme', async () => {
  const seq = mockFetchSequence([redirectResponse('file:///etc/passwd')]);
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://supplier.example/product/1.html', { lookupHost: publicLookup }),
      /schéma/,
    );
    assert.equal(seq.state.calls, 1);
  } finally {
    seq.restore();
  }
});

test('refuses a redirect without a Location header', async () => {
  const seq = mockFetchSequence([
    { ok: false, status: 302, headers: { get: () => null }, text: async () => '' },
  ]);
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://supplier.example/product/1.html', { lookupHost: publicLookup }),
      /sans destination/,
    );
    assert.equal(seq.state.calls, 1);
  } finally {
    seq.restore();
  }
});

test('applies the byte cap across the whole redirect chain, not just the final response', async () => {
  const seq = mockFetchSequence([
    // Corps de redirection volumineux : sans décompte global, la réponse finale
    // passerait sous le plafond et l'import téléchargerait plus que maxBytes.
    redirectResponse('https://supplier.example/hop.html', { body: 'a'.repeat(400) }),
    htmlResponse('b'.repeat(400)),
  ]);
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://supplier.example/start.html', { lookupHost: publicLookup, maxBytes: 512 }),
      /volumineuse/,
    );
  } finally {
    seq.restore();
  }
});

test('the timeout budget covers the whole redirect chain', async () => {
  const originalFetch = global.fetch;
  const signals = [];
  let calls = 0;
  global.fetch = async (_url, options = {}) => {
    calls += 1;
    signals.push(options.signal);
    if (calls === 1) return redirectResponse('https://supplier.example/slow.html');
    return new Promise((_resolve, reject) => {
      // Le second saut ne répond jamais : c'est le délai restant qui doit le tuer.
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://supplier.example/start.html', { lookupHost: publicLookup, timeoutMs: 100 }),
      /Délai dépassé/,
    );
    assert.equal(calls, 2, 'la chaîne doit avoir été suivie jusqu\'au saut qui bloque');
    assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  } finally {
    global.fetch = originalFetch;
  }
});

/* ------------------------------------------------------------------ *
 * Chemins rapides plateformes (Shopify / WooCommerce) et extraction
 * élargie. `fetch` est piloté par URL : les chemins rapides ajoutent des
 * appels réseau, il ne suffit donc plus de compter les appels.
 * ------------------------------------------------------------------ */

/** Réponse 200 générique : corps texte, type de contenu optionnel. */
function textResponse(body, { contentType = 'text/html; charset=utf-8' } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

/**
 * Installe un `fetch` qui sert une réponse selon l'URL demandée.
 * `routes` est une liste `{ match, response }` : le premier motif qui matche
 * gagne. Toute URL non prévue rejette le test — plus de « fetch inattendu »
 * silencieux, et les URLs réellement appelées restent inspectables.
 */
function mockFetchRoutes(routes) {
  const originalFetch = global.fetch;
  const state = { urls: [] };
  global.fetch = async (url) => {
    const requested = String(url);
    state.urls.push(requested);
    for (const route of routes) {
      if (requested.includes(route.match)) return route.response;
    }
    throw new Error(`fetch inattendu : ${requested}`);
  };
  return { state, restore: () => { global.fetch = originalFetch; } };
}

test('Shopify: use la fiche JSON publique et détecte la plateforme', async () => {
  const productJson = JSON.stringify({
    product: {
      handle: 'peluche-renard',
      title: 'Peluche renard 30cm',
      body_html: '<p>Une douce <strong>peluche</strong> &amp; son coussin.</p>',
      images: [
        { src: 'https://cdn.shopify.com/img1.jpg' },
        { src: 'https://cdn.shopify.com/img2.jpg' },
      ],
      variants: [{ price: '4.90', compare_at_price: '7.00' }],
    },
  });
  const routes = mockFetchRoutes([
    { match: '/products/peluche-renard.json', response: textResponse(productJson, { contentType: 'application/json' }) },
  ]);
  try {
    const result = await scrapeProductFromUrl('https://fournisseur.myshopify.com/products/peluche-renard', {
      lookupHost: publicLookup,
    });
    assert.equal(result.sourceSite, 'shopify');
    assert.equal(result.title, 'Peluche renard 30cm');
    assert.equal(result.purchasePrice, 4.9);
    // La description Shopify est du HTML : elle doit ressortir en texte, entités décodées.
    assert.equal(result.rawDescription, 'Une douce peluche & son coussin.');
    assert.deepEqual(result.imageUrls, ['https://cdn.shopify.com/img1.jpg', 'https://cdn.shopify.com/img2.jpg']);
    assert.equal(routes.state.urls.length, 1, 'la fiche JSON évite tout téléchargement de page');
  } finally {
    routes.restore();
  }
});

test('Shopify: JSON désactivé (page de mot de passe) → repli HTML générique', async () => {
  const passwordPage = `
    <html><head>
      <meta property="og:title" content="Boutique protégée">
      <meta property="og:description" content="Saisissez le mot de passe">
      <meta property="og:image" content="/logo.jpg">
    </head><body></body></html>
  `;
  const routes = mockFetchRoutes([
    // `products.json` renvoie du HTML : le chemin rapide doit abandonner sans bruit.
    { match: '/products/peluche-renard.json', response: textResponse(passwordPage) },
    { match: '/products/peluche-renard', response: textResponse(passwordPage) },
    { match: '/products.json?limit=250', response: textResponse(passwordPage) },
    { match: '/wp-json/', response: textResponse(passwordPage) },
  ]);
  try {
    const result = await scrapeProductFromUrl('https://boutique.example.com/products/peluche-renard', {
      lookupHost: publicLookup,
    });
    assert.equal(result.title, 'Boutique protégée');
    assert.equal(result.sourceSite, 'autre', "un hôte inconnu n'est pas étiqueté Shopify sans preuve");
    // Les deux chemins rapides sont tentés, puis la page est lue en HTML : c'est
    // le repli qui sauve l'import quand toutes les API sont désactivées.
    assert.deepEqual(routes.state.urls, [
      'https://boutique.example.com/products/peluche-renard.json',
      'https://boutique.example.com/products.json?limit=250',
      'https://boutique.example.com/wp-json/wc/store/v1/products?slug=peluche-renard',
      'https://boutique.example.com/wp-json/wc/store/v1/products?search=peluche-renard',
      'https://boutique.example.com/products/peluche-renard',
    ]);
  } finally {
    routes.restore();
  }
});

test('Shopify: les variantes absentes retombent sur compare_at_price, jamais NaN', async () => {
  const productJson = JSON.stringify({
    product: { title: 'Sans variante', body_html: '', images: [], variants: [{ compare_at_price: '9.99' }] },
  });
  const routes = mockFetchRoutes([
    { match: '.json', response: textResponse(productJson, { contentType: 'application/json' }) },
  ]);
  try {
    const result = await scrapeProductFromUrl('https://boutique.example.com/products/sans-variante', {
      lookupHost: publicLookup,
    });
    assert.equal(result.purchasePrice, 9.99);
    assert.ok(Number.isFinite(result.purchasePrice));
  } finally {
    routes.restore();
  }
});

test('Shopify: la fiche unitaire illisible retombe sur le catalogue products.json', async () => {
  // Cas visé : `/products/x.json` est désactivé ou renvoie du HTML, alors que le
  // catalogue public reste interrogeable. On retrouve la fiche par sa poignée.
  const catalog = JSON.stringify({
    products: [
      { handle: 'autre-produit', title: 'Autre', body_html: '', images: [], variants: [{ price: '1.00' }] },
      {
        handle: 'peluche-renard',
        title: 'Peluche renard',
        body_html: '<p>Douce</p>',
        images: [{ src: 'https://cdn.shopify.com/renard.jpg' }],
        variants: [{ price: '14.50' }],
      },
    ],
  });
  const routes = mockFetchRoutes([
    { match: '/products/peluche-renard.json', response: textResponse('<html><body>Non disponible</body></html>') },
    {
      match: '/products.json?limit=250',
      response: textResponse(catalog, { contentType: 'application/json' }),
    },
  ]);
  try {
    const result = await scrapeProductFromUrl('https://boutique.example.com/collections/peluches/products/peluche-renard', {
      lookupHost: publicLookup,
    });
    assert.equal(result.sourceSite, 'shopify');
    assert.equal(result.title, 'Peluche renard');
    assert.equal(result.purchasePrice, 14.5);
    assert.deepEqual(result.imageUrls, ['https://cdn.shopify.com/renard.jpg']);
  } finally {
    routes.restore();
  }
});

test('WooCommerce: currency_minor_unit est respecté (prix non multiplié par 100)', async () => {
  // "1250" en unités mineures avec minor_unit 2 vaut 12,50 — et non 1250 ni 0,125.
  const storeJson = JSON.stringify([
    {
      id: 42,
      name: 'Mug céramique',
      description: '<p>Mug <em>artisanal</em> 350 ml</p>',
      short_description: 'Mug artisanal',
      images: [{ src: 'https://boutique.example.com/wp-content/uploads/mug.jpg' }],
      prices: { price: '1250', regular_price: '1500', currency_code: 'EUR', currency_minor_unit: 2 },
    },
  ]);
  const routes = mockFetchRoutes([
    { match: '/wp-json/wc/store/v1/products', response: textResponse(storeJson, { contentType: 'application/json' }) },
  ]);
  try {
    const result = await scrapeProductFromUrl('https://boutique.example.com/wp-json/wc/store/v1/products?slug=mug', {
      lookupHost: publicLookup,
    });
    assert.equal(result.sourceSite, 'woocommerce');
    assert.equal(result.title, 'Mug céramique');
    assert.equal(result.purchasePrice, 12.5, 'le prix est en unités mineures : 1250 / 10^2');
    assert.equal(result.currency, 'EUR');
    assert.equal(result.rawDescription, 'Mug artisanal 350 ml');
  } finally {
    routes.restore();
  }
});

test('WooCommerce: minor_unit 0 (devise sans décimale) ne divise pas le prix', async () => {
  const storeJson = JSON.stringify([
    { id: 7, name: 'Peluche', prices: { price: '1250', currency_code: 'JPY', currency_minor_unit: 0 } },
  ]);
  const routes = mockFetchRoutes([
    { match: '/wp-json/wc/store/v1/products?slug=', response: textResponse(storeJson, { contentType: 'application/json' }) },
  ]);
  try {
    const result = await scrapeProductFromUrl('https://boutique-woo.example.com/produits/peluche', {
      lookupHost: publicLookup,
    });
    assert.equal(result.purchasePrice, 1250);
    assert.equal(result.currency, 'JPY');
  } finally {
    routes.restore();
  }
});

test('extrait le prix d\'une AggregateOffer JSON-LD (lowPrice)', async () => {
  const html = `
    <html><head>
      <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Lot de 10 peluches",
          "offers": {
            "@type": "AggregateOffer",
            "lowPrice": "42.00",
            "highPrice": "58.00",
            "priceCurrency": "EUR"
          }
        }
      </script>
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://fournisseur.example.com/article/10', { lookupHost: publicLookup });
    assert.equal(result.purchasePrice, 42);
    assert.equal(result.currency, 'EUR');
    assert.equal(result.title, 'Lot de 10 peluches');
  } finally {
    restore();
  }
});

test('extrait prix et titre depuis la microdata schema.org', async () => {
  const html = `
    <html><head><title>Ignoré</title></head><body>
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="name">Doudou lapin</span>
        <meta itemprop="priceCurrency" content="EUR">
        <span itemprop="price" content="19,99">19,99 €</span>
        <img itemprop="image" src="/doudou.jpg">
      </div>
    </body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://fournisseur.example.com/article/lapin', { lookupHost: publicLookup });
    assert.equal(result.title, 'Doudou lapin');
    assert.equal(result.purchasePrice, 19.99);
    assert.equal(result.currency, 'EUR');
    assert.deepEqual(result.imageUrls, ['https://fournisseur.example.com/doudou.jpg']);
  } finally {
    restore();
  }
});

test('parse un prix à l\'européenne « 12,50 € » et en déduit EUR', async () => {
  const html = `
    <html><head><title>Mug</title>
      <meta property="product:price:amount" content="12,50 €">
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://fournisseur.example.com/article/mug', { lookupHost: publicLookup });
    assert.equal(result.purchasePrice, 12.5);
    assert.equal(result.currency, 'EUR');
  } finally {
    restore();
  }
});

test('parse « 1 234,56 € » avec espace insécable et séparateur de milliers', async () => {
  const html = `
    <html><head><title>Commode</title>
      <meta property="og:price:amount" content="1\u00a0234,56\u00a0€">
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://fournisseur.example.com/article/commode', { lookupHost: publicLookup });
    assert.equal(result.purchasePrice, 1234.56);
    assert.equal(result.currency, 'EUR');
  } finally {
    restore();
  }
});

test('parse un prix en złoty et en déduit PLN', async () => {
  const html = `
    <html><head><title>Peluche</title>
      <meta property="product:price:amount" content="1 234,56 zł">
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://fournisseur.example.com/article/peluche-pl', { lookupHost: publicLookup });
    assert.equal(result.purchasePrice, 1234.56);
    assert.equal(result.currency, 'PLN');
  } finally {
    restore();
  }
});

test('parse « $19.99 » et en déduit USD', async () => {
  const html = `
    <html><head><title>Casque</title>
      <meta property="og:price:amount" content="$19.99">
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://fournisseur.example.com/article/casque', { lookupHost: publicLookup });
    assert.equal(result.purchasePrice, 19.99);
    assert.equal(result.currency, 'USD');
  } finally {
    restore();
  }
});

test('un prix illisible vaut 0 (jamais NaN) pour laisser l\'avertissement se déclencher', async () => {
  const html = `
    <html><head><title>Article</title>
      <meta property="product:price:amount" content="Prix sur demande">
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://fournisseur.example.com/article/x', { lookupHost: publicLookup });
    assert.equal(result.purchasePrice, 0);
    assert.ok(Number.isFinite(result.purchasePrice), 'jamais NaN');
  } finally {
    restore();
  }
});

test('un hôte inconnu sans permalien produit ne tente aucun chemin rapide', async () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Produit générique">
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  const innerFetch = global.fetch;
  const urls = [];
  global.fetch = async (url, options) => {
    const requested = String(url);
    urls.push(requested);
    assert.ok(!requested.includes('/wp-json/'), `aucune API ne doit être sondée sur un hôte inconnu : ${requested}`);
    assert.ok(!requested.includes('products.json'), `aucune API ne doit être sondée sur un hôte inconnu : ${requested}`);
    return innerFetch(url, options);
  };
  try {
    const result = await scrapeProductFromUrl('https://boutique-inconnue.example.com/p/12345', { lookupHost: publicLookup });
    assert.equal(result.sourceSite, 'autre');
    assert.equal(result.title, 'Produit générique');
    assert.equal(urls.length, 1, "la page est lue une seule fois, sans sonde d'API");
  } finally {
    restore();
  }
});

test('une adresse privée est refusée AVANT même le chemin rapide Shopify', async () => {
  const forbidden = forbidFetch();
  try {
    await assert.rejects(
      () =>
        scrapeProductFromUrl('http://127.0.0.1:8080/products/mon-produit.json', {
          lookupHost: publicLookup,
        }),
      /refusée/,
    );
    assert.equal(forbidden.state.calls, 0, 'le JSON Shopify ne doit jamais être demandé à la boucle locale');
  } finally {
    forbidden.restore();
  }
});

test('un hôte public qui résout vers du privé est refusé, chemin rapide compris', async () => {
  const forbidden = forbidFetch();
  try {
    await assert.rejects(
      () =>
        scrapeProductFromUrl('https://fournisseur.myshopify.com/products/mon-produit', {
          lookupHost: async () => ['169.254.169.254'],
        }),
      /interne/,
    );
    assert.equal(forbidden.state.calls, 0);
  } finally {
    forbidden.restore();
  }
});

test('une redirection du chemin rapide vers une adresse interne est refusée', async () => {
  // La redirection piégée vise toutes les tentatives (deux API × deux URL, puis le
  // repli HTML) : la barrière SSRF étant commune à tous les appels, aucun ne doit
  // la suivre et l'adresse interne ne doit jamais être requêtée.
  const trap = () => redirectResponse('http://169.254.169.254/latest/meta-data/');
  const seq = mockFetchSequence([trap(), trap(), trap(), trap(), trap()]);
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://boutique.example.com/products/mon-produit', { lookupHost: publicLookup }),
      /interne/,
    );
    assert.equal(seq.state.calls, 5, 'la redirection interne ne doit jamais être suivie');
    assert.ok(seq.state.urls[0].endsWith('/products/mon-produit.json'), 'sonde Shopify');
    assert.ok(seq.state.urls[2].includes('/wp-json/wc/store/v1/products?slug=mon-produit'), 'sonde WooCommerce');
    assert.equal(seq.state.urls[4], 'https://boutique.example.com/products/mon-produit', 'puis le repli HTML');
  } finally {
    seq.restore();
  }
});

test('la table de reconnaissance couvre les grandes familles d\'hôtes', async () => {
  const restore = mockFetchOnce('<html><head><title>Produit</title></head></html>');
  const expected = [
    ['https://fr.aliexpress.com/item/1.html', 'aliexpress'],
    ['https://www.alibaba.com/product/1.html', 'alibaba'],
    ['https://www.1688.com/offer/1.html', '1688'],
    ['https://www.made-in-china.com/product/1.html', 'made-in-china'],
    ['https://www.globalsources.com/product/1.html', 'globalsources'],
    ['https://www.dhgate.com/product/1.html', 'dhgate'],
    ['https://www.banggood.com/product/1.html', 'banggood'],
    ['https://www.temu.com/goods/1.html', 'temu'],
    ['https://fr.shein.com/product/1.html', 'shein'],
    ['https://item.taobao.com/item/1.html', 'taobao'],
    ['https://www.wish.com/product/1', 'wish'],
    ['https://www.joom.com/fr/products/1', 'joom'],
    ['https://www.bigbuy.eu/fr/produit.html', 'bigbuy'],
    ['https://app.spocket.co/products/1', 'spocket'],
    ['https://www.syncee.com/product/1', 'syncee'],
    ['https://www.modalyst.com/product/1', 'modalyst'],
    ['https://www.faire.com/product/1', 'faire'],
    ['https://www.ankorstore.com/product/1', 'ankorstore'],
    ['https://www.orderchamp.com/product/1', 'orderchamp'],
    ['https://www.printful.com/product/1', 'printful'],
    ['https://www.printify.com/product/1', 'printify'],
    ['https://www.gelato.com/product/1', 'gelato'],
    ['https://www.amazon.fr/dp/1', 'amazon'],
    ['https://www.ebay.com/itm/1', 'ebay'],
    ['https://www.walmart.com/ip/1', 'walmart'],
    ['https://www.etsy.com/listing/1', 'etsy'],
    ['https://www.cdiscount.com/produit/1.html', 'cdiscount'],
    ['https://www.fnac.com/produit/1', 'fnac'],
    ['https://fr.shopping.rakuten.com/1', 'rakuten'],
    ['https://www.bol.com/nl/p/1', 'bol'],
    ['https://www.zalando.fr/1', 'zalando'],
    ['https://www.otto.de/p/1', 'otto'],
    ['https://www.kaufland.de/product/1', 'kaufland'],
    ['https://allegro.pl/oferta/1', 'allegro'],
    ['https://www.emag.ro/produs/1', 'emag'],
    ['https://boutique.myshopify.com/products/1', 'shopify'],
    ['https://www.prestashop.com/fr/1', 'prestashop'],
    ['https://www.bigcommerce.com/product/1', 'bigcommerce'],
    ['https://magento.com/product/1', 'magento'],
    ['https://www.wix.com/shop/1', 'wix'],
    ['https://www.squarespace.com/shop/1', 'squarespace'],
    ['https://www.shopware.com/product/1', 'shopware'],
    ['https://www.ecwid.com/product/1', 'ecwid'],
    ['https://www.lightspeedhq.com/product/1', 'lightspeed'],
    // Un hôte inconnu reste « autre » : c'est la promesse de non-exhaustivité.
    ['https://boutique-inconnue.example.com/produit/1', 'autre'],
  ];
  try {
    for (const [url, site] of expected) {
      const result = await scrapeProductFromUrl(url, { lookupHost: publicLookup });
      assert.equal(result.sourceSite, site, url);
    }
  } finally {
    restore();
  }
});

test('la table de reconnaissance est illustrative : un hôte inconnu est scrapé quand même', async () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Produit d\'un distributeur inconnu">
      <meta property="og:price:amount" content="7,90 €">
    </head><body></body></html>
  `;
  const restore = mockFetchOnce(html);
  try {
    const result = await scrapeProductFromUrl('https://un-fournisseur-quelconque.example.net/p/9', { lookupHost: publicLookup });
    assert.equal(result.sourceSite, 'autre');
    assert.equal(result.title, "Produit d'un distributeur inconnu");
    assert.equal(result.purchasePrice, 7.9);
    assert.equal(result.currency, 'EUR');
  } finally {
    restore();
  }
});

test('la description issue de body_html est débarrassée de ses balises et entités', async () => {
  const productJson = JSON.stringify({
    product: {
      title: 'Thé vert',
      body_html: '<div><h2>Th&eacute; vert</h2><script>alert(1)</script><p>100&#37; bio &amp; frais</p></div>',
      variants: [{ price: '8.00' }],
      images: [],
    },
  });
  const routes = mockFetchRoutes([
    { match: '.json', response: textResponse(productJson, { contentType: 'application/json' }) },
  ]);
  try {
    const result = await scrapeProductFromUrl('https://boutique.example.com/products/the-vert', { lookupHost: publicLookup });
    assert.equal(result.rawDescription, 'Thé vert 100% bio & frais');
    assert.ok(!result.rawDescription.includes('<'), 'aucune balise ne doit survivre');
  } finally {
    routes.restore();
  }
});
