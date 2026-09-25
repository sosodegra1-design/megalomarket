/*
 * Repli d'extraction : identité de navigateur complète, montée en stratégies
 * (navigateur → mobile → Googlebot → hôte alternatif), puis lecteurs tiers
 * (Wayback Machine, r.jina.ai).
 *
 * Bug d'origine : le scraper n'envoyait que deux en-têtes (User-Agent et
 * Accept-Language). Alibaba répondait 400/403 à ce PROFIL avant même de servir
 * une page, et il n'existait aucun repli — l'utilisateur recevait un message
 * qui lui conseillait une saisie manuelle que l'interface ne permettait pas.
 *
 * Aucun réseau : `global.fetch` est remplacé par un routeur piloté par l'URL, et
 * le DNS est injecté (`lookupHost`), comme dans tests/scraper.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeProductFromUrl } from '../src/importer/scraper.js';

/** Résolveur DNS factice : les tests ne doivent JAMAIS toucher au réseau. */
const publicLookup = async () => ['93.184.216.34'];

/** Page produit minimale exploitable (Open Graph). */
function productHtml(title) {
  return `<html><head><meta property="og:title" content="${title}"></head><body></body></html>`;
}

/** Réponse minimale du même shape que celle attendue par `readBodyWithLimit`. */
function pageResponse(body, { status = 200, contentType = 'text/html; charset=utf-8' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

/**
 * Installe un `fetch` dont la réponse dépend de l'URL et des en-têtes. Chaque
 * appel est mémorisé (URL + options) pour vérifier l'ordre exact des stratégies
 * et l'identité envoyée à chacune.
 */
function mockFetchRouter(handler) {
  const original = global.fetch;
  const state = { calls: [] };
  global.fetch = async (url, options = {}) => {
    const requested = String(url);
    const call = { url: requested, options, headers: options.headers || {} };
    state.calls.push(call);
    return handler(requested, call.headers, state.calls.length - 1);
  };
  return { state, restore: () => { global.fetch = original; } };
}

function hostOf(url) {
  return new URL(url).hostname;
}

/* ===================== 1. IDENTITÉ COMPLÈTE ===================== */

test('la requête initiale porte une identité de navigateur complète et cohérente', async () => {
  const routes = mockFetchRouter(() => pageResponse(productHtml('Produit complet')));
  try {
    const result = await scrapeProductFromUrl('https://boutique.example.com/produit/1', { lookupHost: publicLookup });
    assert.equal(result.title, 'Produit complet');
    // Aucun repli nécessaire : une seule requête part quand la première suffit.
    assert.equal(routes.state.calls.length, 1);

    const headers = routes.state.calls[0].headers;
    for (const name of [
      'User-Agent', 'Accept', 'Accept-Encoding', 'Accept-Language', 'Cache-Control', 'Pragma',
      'Upgrade-Insecure-Requests', 'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site',
      'Sec-Fetch-User', 'Referer', 'Sec-Ch-Ua', 'Sec-Ch-Ua-Mobile', 'Sec-Ch-Ua-Platform', 'Connection',
    ]) {
      assert.ok(headers[name], `en-tête de navigateur manquant : ${name}`);
    }
    // Un vrai visiteur arrive depuis la page d'accueil du site, pas en tapant
    // l'URL produit : le Referer est l'origine de l'hôte demandé.
    assert.equal(headers.Referer, 'https://boutique.example.com/');
    assert.equal(headers['Sec-Fetch-Site'], 'same-origin');
    assert.match(headers['User-Agent'], /Chrome\/124/);
    assert.equal(headers['Sec-Ch-Ua-Mobile'], '?0');
  } finally {
    routes.restore();
  }
});

/* ===================== 2. MONTÉE EN IDENTITÉS ===================== */

test('un 403 déclenche la tentative mobile : même URL, User-Agent mobile et Sec-Ch-Ua-Mobile ?1', async () => {
  const routes = mockFetchRouter((_url, headers) => {
    if (/Mobile/.test(headers['User-Agent'])) return pageResponse(productHtml('Peluche mobile'));
    return pageResponse('Forbidden', { status: 403 });
  });
  try {
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product/1.html', { lookupHost: publicLookup });
    assert.equal(result.strategy, 'mobile');
    assert.equal(result.title, 'Peluche mobile');
    assert.equal(routes.state.calls.length, 2);
    assert.deepEqual(
      routes.state.calls.map((call) => call.url),
      ['https://www.alibaba.com/product/1.html', 'https://www.alibaba.com/product/1.html'],
      'le repli rejoue la MÊME URL, seule l’identité change',
    );
    assert.match(routes.state.calls[1].headers['User-Agent'], /Android/);
    assert.equal(routes.state.calls[1].headers['Sec-Ch-Ua-Mobile'], '?1');
    assert.equal(routes.state.calls[1].headers['Sec-Ch-Ua-Platform'], '"Android"');
    // Toutes les tentatives passent par le même chemin validé (redirections
    // manuelles, signal d'abandon, budget partagé).
    for (const call of routes.state.calls) {
      assert.equal(call.options.redirect, 'manual');
      assert.ok(call.options.signal instanceof AbortSignal);
    }
    assert.deepEqual(result.attempts, [{ strategy: 'navigateur', status: 403 }]);
  } finally {
    routes.restore();
  }
});

test('un blocage persistant essaie Googlebot après mobile', async () => {
  const routes = mockFetchRouter((_url, headers) => {
    if (/Googlebot/.test(headers['User-Agent'])) return pageResponse(productHtml('Produit crawler'));
    return pageResponse('Forbidden', { status: 403 });
  });
  try {
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product/2.html', { lookupHost: publicLookup });
    assert.equal(result.strategy, 'googlebot');
    assert.equal(result.title, 'Produit crawler');
    assert.deepEqual(routes.state.calls.map((call) => call.headers['User-Agent'].slice(0, 9)), [
      'Mozilla/5', 'Mozilla/5', 'Mozilla/5',
    ]);
    // Googlebot n'annonce pas de Client Hints : les envoyer serait incohérent.
    assert.equal(routes.state.calls[2].headers['Sec-Ch-Ua'], undefined);
    assert.deepEqual(result.attempts, [
      { strategy: 'navigateur', status: 403 },
      { strategy: 'mobile', status: 403 },
    ]);
  } finally {
    routes.restore();
  }
});

test('après trois blocages, l’hôte alternatif m.alibaba.com est essayé', async () => {
  const routes = mockFetchRouter((url) => {
    if (url.includes('m.alibaba.com')) return pageResponse(productHtml('Produit hôte mobile'));
    return pageResponse('Forbidden', { status: 403 });
  });
  try {
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product/3.html', { lookupHost: publicLookup });
    assert.equal(result.strategy, 'hôte alternatif (m.alibaba.com)');
    assert.equal(result.title, 'Produit hôte mobile');
    assert.deepEqual(
      routes.state.calls.map((call) => hostOf(call.url)),
      ['www.alibaba.com', 'www.alibaba.com', 'www.alibaba.com', 'm.alibaba.com'],
    );
    // Le chemin et la requête sont conservés, seul l'hôte change.
    assert.equal(new URL(routes.state.calls[3].url).pathname, '/product/3.html');
  } finally {
    routes.restore();
  }
});

test('un hôte alternatif qui résout vers une adresse privée est refusé par la barrière SSRF', async () => {
  const routes = mockFetchRouter(() => pageResponse('Forbidden', { status: 403 }));
  const lookupHost = async (hostname) => (hostname.startsWith('m.') ? ['192.168.1.10'] : ['93.184.216.34']);
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://www.evil.example/product/4.html', { lookupHost }),
      /interne/,
    );
    assert.ok(
      !routes.state.calls.some((call) => hostOf(call.url) === 'm.evil.example'),
      'l’hôte alternatif privé ne doit jamais être requêté',
    );
  } finally {
    routes.restore();
  }
});

/* ===================== 3. LECTEURS TIERS ===================== */

test('Wayback Machine est essayé avant Jina et son instantané est exploité', async () => {
  const snapshotUrl = 'http://web.archive.org/web/20240101000000/https://www.alibaba.com/product/9.html';
  const routes = mockFetchRouter((url) => {
    if (url.startsWith('https://archive.org/wayback/available')) {
      return pageResponse(
        JSON.stringify({ archived_snapshots: { closest: { available: true, url: snapshotUrl } } }),
        { contentType: 'application/json' },
      );
    }
    if (url.startsWith('http://web.archive.org/')) return pageResponse(productHtml('Produit archivé'));
    return pageResponse('Forbidden', { status: 403 });
  });
  try {
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product/9.html', { lookupHost: publicLookup });
    assert.equal(result.strategy, 'wayback');
    assert.equal(result.title, 'Produit archivé');

    const availability = routes.state.calls.find((call) => call.url.startsWith('https://archive.org/wayback/available'));
    assert.ok(availability, 'l’API de disponibilité Wayback doit être interrogée');
    assert.ok(
      availability.url.includes(encodeURIComponent('https://www.alibaba.com/product/9.html')),
      'l’URL cible doit être encodée dans la requête Wayback',
    );
    assert.ok(
      !routes.state.calls.some((call) => call.url.includes('r.jina.ai')),
      'Jina ne doit pas être appelé quand Wayback a fourni la page',
    );
  } finally {
    routes.restore();
  }
});

test('Jina prend le relais quand Wayback n’a aucun instantané, et le markdown est exploité', async () => {
  const routes = mockFetchRouter((url) => {
    if (url.startsWith('https://archive.org/wayback/available')) {
      return pageResponse('{"archived_snapshots":{}}', { contentType: 'application/json' });
    }
    if (url.startsWith('https://r.jina.ai/')) {
      return pageResponse(
        'Title: Doudou lapin\nURL Source: https://www.alibaba.com/product/10.html\n\nMarkdown Content:\n'
        + '# Doudou lapin\n\nPrix : 12,50 €\n\n![photo](https://cdn.example/doudou.jpg)\n',
        { contentType: 'text/plain' },
      );
    }
    return pageResponse('Forbidden', { status: 403 });
  });
  try {
    const result = await scrapeProductFromUrl('https://www.alibaba.com/product/10.html', { lookupHost: publicLookup });
    assert.equal(result.strategy, 'jina');
    assert.equal(result.title, 'Doudou lapin');
    assert.equal(result.purchasePrice, 12.5);
    assert.equal(result.currency, 'EUR');
    assert.deepEqual(result.imageUrls, ['https://cdn.example/doudou.jpg']);

    const jinaCall = routes.state.calls.find((call) => call.url.startsWith('https://r.jina.ai/'));
    assert.ok(jinaCall.url.endsWith('https://www.alibaba.com/product/10.html'));
    // Aucun instantané : l'échec de Wayback est enregistré, pas silencieux.
    assert.ok(result.attempts.some((attempt) => attempt.strategy === 'wayback'));
  } finally {
    routes.restore();
  }
});

/* ===================== 4. SÉCURITÉ : ADRESSE PRIVÉE ===================== */

test('une adresse privée est refusée sans qu’aucun lecteur tiers (jina, archive.org) ne soit prévenu', async () => {
  const originalFetch = global.fetch;
  const state = { urls: [] };
  global.fetch = async (url) => {
    state.urls.push(String(url));
    throw new Error('aucune requête ne doit partir pour une adresse privée');
  };
  try {
    for (const target of [
      'http://127.0.0.1:8080/produit/1.html',
      'http://10.0.0.5/produit/1.html',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/produit/1.html',
    ]) {
      await assert.rejects(
        () => scrapeProductFromUrl(target, { lookupHost: publicLookup }),
        /refusée|interne/,
        target,
      );
    }
    assert.equal(state.urls.length, 0, 'aucun fetch ne doit être tenté');
    assert.ok(
      !state.urls.some((url) => /r\.jina\.ai|archive\.org|web\.archive\.org/.test(url)),
      'une adresse privée ne doit JAMAIS être communiquée à r.jina.ai ou archive.org',
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('un hôte public qui résout vers du privé est refusé avant tout appel, lecteurs tiers compris', async () => {
  const originalFetch = global.fetch;
  const state = { urls: [] };
  global.fetch = async (url) => {
    state.urls.push(String(url));
    throw new Error('aucune requête ne doit partir');
  };
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://supplier.example.com/product/1.html', {
        lookupHost: async () => ['192.168.1.10'],
      }),
      /interne/,
    );
    assert.equal(state.urls.length, 0);
    assert.ok(!state.urls.some((url) => /r\.jina\.ai|archive\.org/.test(url)));
  } finally {
    global.fetch = originalFetch;
  }
});

/* ===================== 5. MESSAGE D'ÉCHEC ===================== */

test('l’échec total liste les stratégies, leurs statuts, et renvoie vers la saisie manuelle', async () => {
  const routes = mockFetchRouter((url) => {
    if (url.startsWith('https://archive.org/wayback/available')) {
      return pageResponse('{"archived_snapshots":{}}', { contentType: 'application/json' });
    }
    if (url.startsWith('https://r.jina.ai/')) return pageResponse('Service indisponible', { status: 503 });
    return pageResponse('Forbidden', { status: 403 });
  });
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://www.alibaba.com/product/11.html', { lookupHost: publicLookup }),
      (error) => {
        assert.match(error.message, /Aucune information exploitable/);
        assert.match(error.message, /bloque/);
        assert.match(error.message, /Stratégies essayées/);
        assert.match(error.message, /navigateur \(HTTP 403\)/);
        assert.match(error.message, /mobile \(HTTP 403\)/);
        assert.match(error.message, /googlebot \(HTTP 403\)/);
        assert.match(error.message, /hôte alternatif \(m\.alibaba\.com\) \(HTTP 403\)/);
        assert.match(error.message, /wayback/);
        assert.match(error.message, /jina/);
        assert.match(error.message, /saisis la fiche à la main/i);
        return true;
      },
    );
  } finally {
    routes.restore();
  }
});

test('un 404 n’est pas rejoué avec une autre identité : c’est une URL erronée, pas un blocage', async () => {
  const routes = mockFetchRouter((url) => {
    if (url.startsWith('https://archive.org/wayback/available')) {
      return pageResponse('{"archived_snapshots":{}}', { contentType: 'application/json' });
    }
    if (url.startsWith('https://r.jina.ai/')) return pageResponse('Not found', { status: 404 });
    return pageResponse('Not found', { status: 404 });
  });
  try {
    await assert.rejects(
      () => scrapeProductFromUrl('https://www.alibaba.com/product/12.html', { lookupHost: publicLookup }),
      (error) => {
        assert.match(error.message, /HTTP 404/);
        return true;
      },
    );
    const directCalls = routes.state.calls.filter((call) => !/archive\.org|r\.jina\.ai/.test(call.url));
    assert.equal(directCalls.length, 1, 'un 404 est définitif : aucune autre identité n’est essayée');
  } finally {
    routes.restore();
  }
});
