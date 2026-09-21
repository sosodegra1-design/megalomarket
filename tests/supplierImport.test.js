/*
 * Le partenaire choisi à l'import, et SA marge appliquée au prix conseillé.
 *
 * C'est la raison d'être du registre : la plateforme de gros et le distributeur
 * local ne vendent pas au même prix, donc le coefficient global du hub ne peut
 * pas être le bon pour les deux. Ces tests verrouillent le rattachement
 * (supplierId), la marge du partenaire qui l'emporte sur le défaut global, le
 * retour au défaut quand la marge est NULL, et le refus d'un partenaire
 * inconnu — sans jamais partir sur le réseau.
 *
 * Seam IA : `global.fetch` remplacé par un stub, comme
 * tests/listingGenerator.test.js (chemin « compatible OpenAI »). `own_site`
 * reste non configuré : un seul appel IA, donc un test déterministe.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-supplier-import-')), 'supplier-import.db');
const ADMIN_KEY = 'cle-de-test-supplier-import-0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;

process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'https://api.groq.example/openai/v1';
process.env.AI_API_KEY = 'cle-de-test';
process.env.AI_MODEL = 'modele-de-test';
process.env.ANTHROPIC_API_KEY = '';
process.env.OWN_SITE_API_URL = '';
process.env.OWN_SITE_API_KEY = '';

const { app } = await import('../src/server.js');
const { config } = await import('../src/config/env.js');
const { initDatabase, dbRun, dbGet, dbAll } = await import('../src/db/database.js');
const { computeSuggestedPrice } = await import('../src/importer/pricing.js');

const AI_REPLY = JSON.stringify({
  amazon: { title: 'Peluche renard 30cm', description: 'Douce et robuste.' },
  tiktok_shop: { title: 'Peluche renard', description: 'Trop mignonne !' },
  allegro: { title: 'Peluche renard 30cm', description: 'Douce et rassurante.' },
  ebay: { title: 'Peluche renard 30 cm', description: 'Peluché douce.' },
});

let server;
let base;

/* Le stub IA remplace global.fetch ; or c'est aussi lui qui sert au client HTTP
   du test. On garde donc une référence au fetch réel AVANT tout stub, pour que
   l'appel au serveur local n'aille pas se perdre dans la fausse réponse IA. */
const realFetch = globalThis.fetch;

async function call(path, { method = 'GET', body } = {}) {
  const response = await realFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

/** Stub réseau : une seule route, /chat/completions, qui renvoie `content`. */
function stubAiFetch(content = AI_REPLY) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body === undefined ? undefined : JSON.parse(options.body) });
    const payload = { choices: [{ message: { content } }] };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

async function createSupplier({ name = 'Partenaire test', marginCoefficient = null, kind = 'fournisseur' } = {}) {
  const now = new Date().toISOString();
  const info = await dbRun(
    `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'actif', NULL, ?, ?)`,
    [kind, name, marginCoefficient, now, now],
  );
  return info.lastInsertRowid;
}

async function createImport({ purchasePrice = 10, supplierId = null } = {}) {
  const info = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'USD', '[]', 'brouillon', ?, ?)`,
    ['https://supplier.example/item/1.html', 'aliexpress', 'Peluche renard 30cm', 'Douce peluche', purchasePrice, supplierId, Date.now()],
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

/* ===================== REFUS D'UN PARTENAIRE INCONNU ===================== */

test("un supplierId inconnu est refusé avant toute extraction", async () => {
  // Aucune page n'est joignable dans ce test : si la validation passait après
  // l'extraction, l'erreur serait un échec réseau, pas ce message clair.
  const { status, body } = await call('/api/imports', {
    method: 'POST',
    body: { url: 'https://supplier.example/item/1.html', supplierId: 999999 },
  });
  assert.equal(status, 400);
  assert.match(body.error, /Partenaire introuvable/);
  assert.match(body.error, /Fournisseurs/, 'la correction doit être indiquée');
});

test("un supplierId qui n'est pas un identifiant est refusé clairement", async () => {
  for (const supplierId of ['abc', 0, -3, 2.5]) {
    const { status, body } = await call('/api/imports', {
      method: 'POST',
      body: { url: 'https://supplier.example/item/1.html', supplierId },
    });
    assert.equal(status, 400, `supplierId ${String(supplierId)}`);
    assert.match(body.error, /Partenaire invalide/);
  }
});

/* ===================== DÉTAIL : LE PARTENAIRE EST VISIBLE ===================== */

test("le détail d'un import renvoie son partenaire et la marge résolue", async () => {
  const supplierId = await createSupplier({ name: 'Grossiste du coin', marginCoefficient: 2.5, kind: 'distributeur' });
  const importId = await createImport({ purchasePrice: 10, supplierId });

  const { status, body } = await call(`/api/imports/${importId}`);
  assert.equal(status, 200);
  assert.ok(body.supplier, 'le partenaire doit voyager avec l’import');
  assert.equal(body.supplier.id, supplierId);
  assert.equal(body.supplier.name, 'Grossiste du coin');
  assert.equal(body.supplier.margin_coefficient, 2.5);
  assert.equal(body.supplier.effectiveMarginCoefficient, 2.5);
  assert.equal(body.supplier.usesDefaultMargin, false);

  // La liste joint aussi le partenaire : la table des imports peut l'afficher
  // sans une requête par ligne.
  const list = await call('/api/imports');
  assert.equal(list.body[0].supplier_name, 'Grossiste du coin');
});

/* ===================== LA MARGE DU PARTENAIRE L'EMPORTE ===================== */

test('la marge du partenaire remplace le coefficient global pour cet import', async () => {
  const supplierId = await createSupplier({ name: 'Plateforme de gros', marginCoefficient: 2.5 });
  const importId = await createImport({ purchasePrice: 10, supplierId });

  const mock = stubAiFetch();
  let result;
  try {
    result = await call(`/api/imports/${importId}/generate`, { method: 'POST' });
  } finally {
    mock.restore();
  }

  assert.equal(result.status, 200);
  const expected = computeSuggestedPrice(10, {
    marginCoefficient: 2.5,
    fixedFee: config.pricing.fixedFee,
  });
  assert.equal(expected, 25);
  assert.ok(expected > computeSuggestedPrice(10, config.pricing), 'le test doit vraiment changer de prix');

  // Le prix est celui du partenaire, dans la réponse ET en base.
  assert.ok(result.body.listings.every((l) => l.suggestedPrice === expected));
  const rows = await dbAll('SELECT suggested_price FROM import_listings WHERE import_id = ?', [importId]);
  assert.equal(rows.length, 4, 'les quatre marketplaces');
  assert.ok(rows.every((row) => row.suggested_price === expected), 'la marge partenaire est bien persistée');
});

test('une marge NULL retombe sur le coefficient global', async () => {
  const supplierId = await createSupplier({ name: 'Sans marge négociée', marginCoefficient: null });
  const importId = await createImport({ purchasePrice: 10, supplierId });

  const mock = stubAiFetch();
  let result;
  try {
    result = await call(`/api/imports/${importId}/generate`, { method: 'POST' });
  } finally {
    mock.restore();
  }

  assert.equal(result.status, 200);
  const expected = computeSuggestedPrice(10, config.pricing);
  assert.ok(result.body.listings.every((l) => l.suggestedPrice === expected));
});

test('un import sans partenaire garde le coefficient global', async () => {
  const importId = await createImport({ purchasePrice: 10, supplierId: null });

  const mock = stubAiFetch();
  let result;
  try {
    result = await call(`/api/imports/${importId}/generate`, { method: 'POST' });
  } finally {
    mock.restore();
  }

  assert.equal(result.status, 200);
  const expected = computeSuggestedPrice(10, config.pricing);
  assert.ok(result.body.listings.every((l) => l.suggestedPrice === expected));
});

/* ===================== ANTI-VENTE À PERTE ===================== */

test('le verrou anti-vente à perte reste actif avec une marge partenaire', async () => {
  // Prix d'achat illisible (0) : le prix conseillé reste 0, jamais négatif.
  const supplierId = await createSupplier({ name: 'Marge sur prix nul', marginCoefficient: 3 });
  const importId = await createImport({ purchasePrice: 0, supplierId });

  const mock = stubAiFetch();
  let result;
  try {
    result = await call(`/api/imports/${importId}/generate`, { method: 'POST' });
  } finally {
    mock.restore();
  }

  assert.equal(result.status, 200);
  assert.ok(result.body.listings.every((l) => l.suggestedPrice === 0));
  assert.match(result.body.warning, /Prix d'achat/);

  const stored = await dbGet('SELECT suggested_price FROM import_listings WHERE import_id = ?', [importId]);
  assert.equal(stored.suggested_price, 0);
});
