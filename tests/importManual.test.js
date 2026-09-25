/*
 * POST /api/imports/manual — la saisie manuelle qui fonctionne TOUJOURS.
 *
 * Le message d'échec d'extraction conseillait « remplis la fiche manuellement »
 * alors que la seule route de création (POST /api/imports) exigeait de scraper :
 * sur un site qui bloque, le conseil était donc impossible à suivre. Cette route
 * crée l'import sans jamais visiter la page, avec EXACTEMENT la même rigueur de
 * validation que PATCH /api/imports/:id — 0 reste refusé, devise = 3 lettres.
 *
 * Aucun réseau : le serveur Express écoute sur un port éphémère et les imports
 * sont vérifiés directement en base.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-manual-import-')), 'manual.db');
const ADMIN_KEY = 'cle-de-test-import-manuel';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbGet } = await import('../src/db/database.js');

let server;
let base;

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

async function createSupplier({ name = 'Grossiste manuel', marginCoefficient = 2.2 } = {}) {
  const now = new Date().toISOString();
  const info = await dbRun(
    `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
     VALUES ('fournisseur', ?, NULL, ?, 'actif', NULL, ?, ?)`,
    [name, marginCoefficient, now, now],
  );
  return info.lastInsertRowid;
}

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/* ===================== CAS NOMINAL ===================== */

test('crée un import complet sans jamais scraper la page', async () => {
  const { status, body } = await call('/api/imports/manual', {
    method: 'POST',
    body: {
      url: 'https://www.alibaba.com/product/123.html',
      title: 'Blendeur extracteur de jus 12 lames',
      purchasePrice: 9.9,
      currency: 'usd',
      rawDescription: 'Un blendeur puissant, 12 lames inox.',
      imageUrls: ['https://cdn.example/blender-1.jpg', 'https://cdn.example/blender-2.jpg'],
    },
  });

  assert.equal(status, 201);
  assert.equal(body.title, 'Blendeur extracteur de jus 12 lames');
  assert.equal(body.purchasePrice, 9.9);
  assert.equal(body.currency, 'USD', 'la devise est normalisée en majuscules');
  assert.equal(body.sourceSite, 'alibaba', 'même étiquette que l’extraction automatique');
  assert.equal(body.strategy, 'manuel', 'l’origine de la donnée est explicite');
  assert.deepEqual(body.imageUrls, ['https://cdn.example/blender-1.jpg', 'https://cdn.example/blender-2.jpg']);
  assert.ok(body.id > 0);

  const stored = await dbGet(
    'SELECT source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id FROM imports WHERE id = ?',
    [body.id],
  );
  assert.equal(stored.source_url, 'https://www.alibaba.com/product/123.html');
  assert.equal(stored.source_site, 'alibaba');
  assert.equal(stored.raw_description, 'Un blendeur puissant, 12 lames inox.');
  assert.equal(stored.purchase_price, 9.9);
  assert.equal(stored.currency, 'USD');
  assert.equal(stored.status, 'brouillon');
  assert.equal(stored.supplier_id, null);
  assert.deepEqual(JSON.parse(stored.image_urls), ['https://cdn.example/blender-1.jpg', 'https://cdn.example/blender-2.jpg']);
});

test('l’URL est facultative : sans elle, l’import est étiqueté « manuel »', async () => {
  const { status, body } = await call('/api/imports/manual', {
    method: 'POST',
    body: { title: 'Doudou lapin', purchasePrice: 4.5, currency: 'EUR' },
  });
  assert.equal(status, 201);
  assert.equal(body.sourceSite, 'manuel');
  assert.equal(body.sourceUrl, '');
  assert.deepEqual(body.imageUrls, []);

  const stored = await dbGet('SELECT source_url, source_site FROM imports WHERE id = ?', [body.id]);
  assert.equal(stored.source_url, '', 'colonne NOT NULL : la chaîne vide est la valeur « pas d’URL »');
  assert.equal(stored.source_site, 'manuel');
});

test('l’import créé se lit ensuite comme n’importe quel import scrapé', async () => {
  const created = await call('/api/imports/manual', {
    method: 'POST',
    body: { title: 'Mug céramique', purchasePrice: 3.2, currency: 'EUR' },
  });
  const detail = await call(`/api/imports/${created.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.title, 'Mug céramique');
  assert.equal(detail.body.purchase_price, 3.2);
  assert.deepEqual(detail.body.imageUrls, []);
  assert.deepEqual(detail.body.listings, [], 'aucune fiche avant la génération IA');
});

test('un partenaire connu est rattaché et sa marge résolue est renvoyée', async () => {
  const supplierId = await createSupplier();
  const { status, body } = await call('/api/imports/manual', {
    method: 'POST',
    body: { title: 'Casque audio', purchasePrice: 20, currency: 'EUR', supplierId },
  });
  assert.equal(status, 201);
  assert.ok(body.supplier, 'le partenaire doit voyager avec l’import');
  assert.equal(body.supplier.id, supplierId);
  assert.equal(body.supplier.effectiveMarginCoefficient, 2.2);
});

/* ===================== REFUS DU PRIX ===================== */

test('un prix à 0 est refusé : c’est le symptôme d’une extraction manquée', async () => {
  const { status, body } = await call('/api/imports/manual', {
    method: 'POST',
    body: { title: 'Produit', purchasePrice: 0, currency: 'EUR' },
  });
  assert.equal(status, 400);
  assert.match(body.error, /Prix d'achat invalide/);
  assert.match(body.error, /supérieur à 0/);
});

test('un prix négatif, non numérique ou non fini est refusé (jamais coercé)', async () => {
  for (const purchasePrice of [-1, -0.01, '12.5', null, true, Infinity, NaN]) {
    const { status } = await call('/api/imports/manual', {
      method: 'POST',
      body: { title: 'Produit', purchasePrice, currency: 'EUR' },
    });
    assert.equal(status, 400, `prix ${String(purchasePrice)}`);
  }
});

/* ===================== REFUS DU TITRE ET DE LA DEVISE ===================== */

test('un titre vide, absent ou non textuel est refusé', async () => {
  for (const title of ['', '   ', null, undefined, 42, ['x']]) {
    const { status, body } = await call('/api/imports/manual', {
      method: 'POST',
      body: { title, purchasePrice: 5, currency: 'EUR' },
    });
    assert.equal(status, 400, `titre ${JSON.stringify(title)}`);
    assert.match(body.error, /Titre invalide/);
  }
});

test('une devise qui n’est pas un code de 3 lettres est refusée', async () => {
  for (const currency of ['DOLLARS', 'US', '12', '', '   ', 'US$', 'eu ro', undefined]) {
    const { status, body } = await call('/api/imports/manual', {
      method: 'POST',
      body: { title: 'Produit', purchasePrice: 5, currency },
    });
    assert.equal(status, 400, `devise ${String(currency)}`);
    assert.match(body.error, /Devise invalide/);
  }
});

/* ===================== URL ET PHOTOS ===================== */

test('une URL invalide ou non http(s) est refusée', async () => {
  for (const url of ['pas-une-url', 'ftp://www.alibaba.com/product/1.html', 'file:///etc/passwd']) {
    const { status, body } = await call('/api/imports/manual', {
      method: 'POST',
      body: { url, title: 'Produit', purchasePrice: 5, currency: 'EUR' },
    });
    assert.equal(status, 400, `url ${url}`);
    assert.match(body.error, /URL invalide/);
  }
});

test('une photo mal formée ou non http(s) est refusée avant toute écriture', async () => {
  const before = await call('/api/imports');
  const { status, body } = await call('/api/imports/manual', {
    method: 'POST',
    body: { title: 'Produit', purchasePrice: 5, currency: 'EUR', imageUrls: ['https://ok.example/a.jpg', 'ftp://ok.example/b.jpg'] },
  });
  assert.equal(status, 400);
  assert.match(body.error, /imageUrls\[1\]/);

  const listed = await call('/api/imports');
  assert.equal(listed.body.length, before.body.length, 'un refus ne doit rien créer');
});

test('plus de 30 photos est refusé', async () => {
  const { status, body } = await call('/api/imports/manual', {
    method: 'POST',
    body: {
      title: 'Produit',
      purchasePrice: 5,
      currency: 'EUR',
      imageUrls: Array.from({ length: 31 }, (_, i) => `https://supplier.example/img${i}.jpg`),
    },
  });
  assert.equal(status, 400);
  assert.match(body.error, /30 photos maximum/);
});

test('un supplierId inconnu est refusé', async () => {
  const { status, body } = await call('/api/imports/manual', {
    method: 'POST',
    body: { title: 'Produit', purchasePrice: 5, currency: 'EUR', supplierId: 999999 },
  });
  assert.equal(status, 400);
  assert.match(body.error, /Partenaire introuvable/);
});

/* ===================== AUTH ===================== */

test('la route est protégée par la clé admin, comme le reste de l’API', async () => {
  const response = await fetch(base + '/api/imports/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Produit', purchasePrice: 5, currency: 'EUR' }),
  });
  assert.equal(response.status, 401);
});
