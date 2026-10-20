/*
 * Pousser un prix vers le SITE PROPRE — les deux pièges constatés en production.
 *
 * DÉFAUT 1 : le site n'identifie pas ses produits par un SKU mais par un id
 * court (« p2 », « bj1 »…). Sans `external_id` enregistré, le hub envoyait le
 * SKU — qui vaut ici le NOM du produit. Résultat :
 *   PATCH /api/admin/products/Tablette%20d%27%C3%A9criture… (404)
 * et le prix n'était jamais propagé.
 *
 * DÉFAUT 2 : le site limite le débit (HTTP 429). Un push qui tombait sur la
 * limite échouait sans que rien ne le rattrape.
 *
 * Ce qui est verrouillé ici :
 *  - l'identifiant est RÉSOLU par le nom, jamais le nom envoyé tel quel ;
 *  - un produit absent du site donne un message qui dit quoi faire, pas un 404 ;
 *  - un 429 passager est réessayé une fois.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-ownsite-')), 'own.db');
process.env.OWN_SITE_API_URL = 'https://bbhappy.example.com';
process.env.OWN_SITE_API_KEY = 'cle-site-de-test';

const { initDatabase, dbRun } = await import('../src/db/database.js');
const { pushPriceToChannel } = await import('../src/services/pushSync.js');

before(async () => {
  await initDatabase();
});

/** Intercepte les appels au site propre, et note ce qui a été demandé. */
function stubSite(handler) {
  const original = global.fetch;
  const appels = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.startsWith('https://bbhappy.example.com')) return original(url, options);
    appels.push({ url: u, method: options.method || 'GET', body: options.body });
    return handler(u, options);
  };
  return { appels, restore: () => { global.fetch = original; } };
}

function jsonReponse(objet, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => objet,
    text: async () => JSON.stringify(objet),
  };
}

/* ===================== DÉFAUT 1 : L'IDENTIFIANT ===================== */

test('le prix est poussé sur l’ID du site, pas sur le nom du produit', async () => {
  await dbRun(
    "INSERT INTO products (sku, name, description, cost_price, created_at) VALUES ('Tablette d écriture numérique pour enfants,', 'Tablette', '', 5, ?)",
    [Date.now()],
  );
  const { dbGet } = await import('../src/db/database.js');
  const produit = await dbGet("SELECT id FROM products WHERE sku LIKE 'Tablette%'");

  const { appels, restore } = stubSite((url, options) => {
    // Le site expose son catalogue avec des ids courts.
    // Le catalogue PUBLIC : c'est lui que le connecteur interroge pour résoudre.
    if (url.endsWith('/api/products') && (options.method || 'GET') === 'GET') {
      return jsonReponse([{ id: 'p2', name: 'Tablette d écriture numérique pour enfants,' }]);
    }
    return jsonReponse({ ok: true });
  });

  try {
    const resultat = await pushPriceToChannel(produit.id, 'own_site', 9.99);
    assert.equal(resultat.ok, true);
    assert.equal(resultat.externalId, 'p2', 'l’identifiant envoyé doit être celui du site');

    const patch = appels.find((a) => a.method === 'PATCH');
    assert.ok(patch, 'un PATCH doit partir');
    assert.ok(
      patch.url.endsWith('/api/admin/products/p2'),
      `le PATCH doit viser /p2, il vise ${patch.url}`,
    );
    assert.ok(!patch.url.includes('Tablette'), 'le nom ne doit jamais servir d’identifiant');
  } finally {
    restore();
  }
});

test('un produit absent du site donne un message qui dit quoi faire', async () => {
  await dbRun(
    "INSERT INTO products (sku, name, description, cost_price, created_at) VALUES ('Produit fantôme', 'Fantôme', '', 1, ?)",
    [Date.now()],
  );
  const { dbGet } = await import('../src/db/database.js');
  const produit = await dbGet("SELECT id FROM products WHERE sku = 'Produit fantôme'");

  const { appels, restore } = stubSite(() => jsonReponse([{ id: 'p2', name: 'Autre chose' }]));
  try {
    await assert.rejects(
      () => pushPriceToChannel(produit.id, 'own_site', 9.99),
      (erreur) => {
        assert.match(erreur.message, /n'existe pas sur le site propre/);
        assert.match(erreur.message, /Publie/, 'le message doit dire quoi faire');
        return true;
      },
    );
    // Aucun PATCH voué au 404 ne doit partir.
    assert.equal(appels.filter((a) => a.method === 'PATCH').length, 0);
  } finally {
    restore();
  }
});

/* ===================== DÉFAUT 2 : LE 429 ===================== */

test('un 429 passager est réessayé une fois', async () => {
  await dbRun(
    "INSERT INTO ch, name, description, cost_price, created_at) VALUES ('P-429', 'P', '', 1, ?)".replace('ch, name', 'products (sku, name'),
    [Date.now()],
  );
  const { dbGet } = await import('../src/db/database.js');
  const produit = await dbGet("SELECT id FROM products WHERE sku = 'P-429'");
  await dbRun(
    "INSERT INTO channel_listings (product_id, channel, external_id, price, stock, status, updated_at) VALUES (?, 'own_site', 'p9', 1, 0, 'active', ?)",
    [produit.id, Date.now()],
  );

  let tentatives = 0;
  const { restore } = stubSite(() => {
    tentatives += 1;
    if (tentatives === 1) {
      return { ok: false, status: 429, headers: { get: () => '1' }, text: async () => 'Too Many Requests' };
    }
    return jsonReponse({ ok: true });
  });

  try {
    const resultat = await pushPriceToChannel(produit.id, 'own_site', 12);
    assert.equal(resultat.ok, true, 'le second essai doit réussir');
    assert.equal(tentatives, 2, 'exactement un réessai');
  } finally {
    restore();
  }
});
