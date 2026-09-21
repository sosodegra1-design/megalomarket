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
