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
        assert.match(erreur.message, /n'existe ni sur le site/);
        assert.match(erreur.message, /catégorie/, 'le message doit dire ce qui manque');
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


/* ===================== PUBLICATION AUTOMATIQUE ===================== */

/* Demande explicite : « publier automatiquement puis propager le prix, en une
 * seule action ». Un produit du hub n'a pas les champs exigés par le site
 * (catégorie, univers, âge, icône, bilingue) — seul le `site_payload` d'une
 * fiche d'import les porte. On publie donc CETTE fiche, puis le prix suit. */

test('un produit absent du site est publié depuis sa fiche d’import', async () => {
  await dbRun(
    // Une photo est desormais EXIGEE pour publier sur BBVolteX (voir publisher.js) :
    // la fiche de test en porte donc une, comme une vraie fiche fournisseur.
    "INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at) VALUES ('https://x.test/a', 'alibaba', 'Lampe lunaire', '', 5, 'EUR', ?, 'pret', ?)",
    [JSON.stringify(['https://exemple.test/lampe.jpg']), Date.now()],
  );
  const { dbGet } = await import('../src/db/database.js');
  const imp = await dbGet("SELECT id FROM imports WHERE title = 'Lampe lunaire'");

  await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, site_payload, created_at, updated_at)
     VALUES (?, 'own_site', 'Lampe lunaire', 'desc', 19.9, 'a_valider', ?, ?, ?)`,
    [imp.id, JSON.stringify({ name: 'Lampe lunaire', category: 'deco', universe: 'maison', age: '3-6', iconKey: 'lamp' }), Date.now(), Date.now()],
  );

  await dbRun(
    "INSERT INTO products (sku, name, description, cost_price, created_at) VALUES ('Lampe lunaire', 'Lampe lunaire', '', 5, ?)",
    [Date.now()],
  );
  const produit = await dbGet("SELECT id FROM products WHERE sku = 'Lampe lunaire'");

  let creation = 0;
  const { appels, restore } = stubSite((url, options) => {
    if (url.endsWith('/api/products')) return jsonReponse([]);   // absent du site
    if (url.endsWith('/api/admin/products') && (options.method || 'GET') === 'POST') {
      creation += 1;
      const corps = JSON.parse(options.body || '{}');
      // Le prix publié est celui de la fiche.
      assert.equal(corps.price, 19.9);
      // L'API du site renvoie le produit créé, avec son `id` — c'est lui que le
      // connecteur lit pour fabriquer l'offerId.
      return jsonReponse({ id: 'p42', name: corps.name }, 201);
    }
    return jsonReponse({ ok: true });
  });

  try {
    const resultat = await pushPriceToChannel(produit.id, 'own_site', 24.9);
    assert.equal(creation, 1, 'la fiche doit être publiée une fois');
    assert.equal(resultat.ok, true);
    assert.equal(resultat.externalId, 'p42', 'l’id créé sert ensuite au push du prix');

    // Et le prix est bien poussé sur l'article fraîchement créé.
    const patch = appels.find((a) => a.method === 'PATCH');
    assert.ok(patch.url.endsWith('/api/admin/products/p42'));
  } finally {
    restore();
  }
});

/* ===================== PAS DE PHOTO, PAS DE PUBLICATION ===================== */

test('publier une fiche BBVolteX sans aucune photo est refusé', async () => {
  // Constaté en production : le lot de 3 bavoirs est parti sur le site avec zéro
  // photo. Le client voit une page vide, et il faut retirer l'article.
  const { dbRun, dbGet } = await import('../src/db/database.js');
  const { publishListing } = await import('../src/importer/publisher.js');

  await dbRun(
    "INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at) VALUES ('https://x.test/sansphoto', 'alibaba', 'Sans photo', '', 3, 'EUR', '[]', 'pret', ?)",
    [Date.now()],
  );
  const imp = await dbGet("SELECT id FROM imports WHERE title = 'Sans photo'");
  await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, site_payload, created_at, updated_at)
     VALUES (?, 'own_site', 'Sans photo', 'desc', 9.9, 'a_valider', ?, ?, ?)`,
    [imp.id, JSON.stringify({ name: 'Sans photo', category: 'vetements', universe: 'bebe', age: '0-2', iconKey: 'body' }), Date.now(), Date.now()],
  );
  const listing = await dbGet("SELECT id FROM import_listings WHERE import_id = ? AND marketplace = 'own_site'", [imp.id]);

  await assert.rejects(
    () => publishListing(listing.id),
    (e) => {
      assert.match(e.message, /aucune photo/);
      assert.match(e.message, /ne se vend pas/);
      return true;
    },
  );
});
