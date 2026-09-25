/*
 * `generateListingsForImport` face à un prix d'achat que le scraper n'a pas lu.
 *
 * Le test de bout en bout réel : un import créé à 0 € produisait cinq fiches à
 * 0 €, silencieusement. On garde la génération du texte (elle reste utile) mais
 * le prix nul doit être signalé dans la réponse ET dans le journal.
 *
 * Seam choisi : `global.fetch` remplacé par un stub, comme
 * tests/aiProvider.test.js — c'est le chemin « compatible OpenAI »
 * (AI_BASE_URL/AI_API_KEY/AI_MODEL) que `askModel` emprunte, et il ne demande
 * aucune connexion. `own_site` est laissé non configuré : un seul appel IA a
 * donc lieu (les marketplaces), ce qui rend le test déterministe.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-generator-')), 'generator.db');

// Fournisseur compatible OpenAI, explicite pour qu'un ANTHROPIC_API_KEY de
// l'environnement ne fasse pas basculer la résolution. Les variables vides
// empêchent dotenv de les remplir depuis un .env local.
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'https://api.groq.example/openai/v1';
process.env.AI_API_KEY = 'cle-de-test';
process.env.AI_MODEL = 'modele-de-test';
process.env.ANTHROPIC_API_KEY = '';
process.env.OWN_SITE_API_URL = '';
process.env.OWN_SITE_API_KEY = '';

const { config } = await import('../src/config/env.js');
const { initDatabase, dbRun, dbAll } = await import('../src/db/database.js');
const {
  generateListingsForImport,
  MISSING_PURCHASE_PRICE_WARNING,
} = await import('../src/importer/listingGenerator.js');
const { computeLandedCost, computeSuggestedPrice } = await import('../src/importer/pricing.js');

/* Réponse IA minimale mais exploitable : les quatre marketplaces. */
const AI_REPLY = JSON.stringify({
  amazon: { title: 'Peluche renard 30cm', description: 'Douce et robuste.' },
  tiktok_shop: { title: 'Peluche renard', description: 'Trop mignonne !' },
  allegro: { title: 'Peluche renard 30cm', description: 'Douce et rassurante.' },
  ebay: { title: 'Peluche renard 30 cm', description: 'Peluché douce.' },
});

/** Stub réseau : une seule route, /chat/completions, qui renvoie `content`. */
function stubAiFetch(content = AI_REPLY) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body === undefined ? undefined : JSON.parse(options.body) });
    const payload = { choices: [{ message: { content } }] };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

async function createImport(purchasePrice, currency = 'USD') {
  const info = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 'brouillon', ?)`,
    ['https://supplier.example/item/1.html', 'aliexpress', 'Peluche renard 30cm', 'Douce peluche', purchasePrice, currency, Date.now()],
  );
  return info.lastInsertRowid;
}

before(async () => {
  await initDatabase();
});

/* ===================== PRIX D'ACHAT MANQUANT ===================== */

test('a 0 purchase price still generates the text sheets but returns an explicit warning', async () => {
  const id = await createImport(0);
  const mock = stubAiFetch();
  let result;
  try {
    result = await generateListingsForImport(id);
  } finally {
    mock.restore();
  }

  // Le texte reste généré : la génération n'est pas perdue, seulement signalée.
  assert.ok(Array.isArray(result.listings));
  assert.equal(result.listings.length, 4, 'les quatre marketplaces');
  assert.ok(result.listings.every((l) => l.suggestedPrice === 0));

  // Le prix est nul, mais plus jamais en silence.
  assert.equal(result.warning, MISSING_PURCHASE_PRICE_WARNING);
  assert.match(result.warning, /Prix d'achat/);
  assert.match(result.warning, /0 €/);
  assert.match(result.warning, /PATCH \/api\/imports\/:id/, 'la façon de corriger doit être nommée');
  assert.match(result.warning, /publier/);

  const rows = await dbAll('SELECT suggested_price FROM import_listings WHERE import_id = ?', [id]);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.suggested_price === 0), 'le prix stocké reste celui du calcul, inchangé');
});

test('the missing price is written to the activity log so the dashboard journal shows it', async () => {
  const id = await createImport(0);
  const mock = stubAiFetch();
  try {
    await generateListingsForImport(id);
  } finally {
    mock.restore();
  }

  const entries = await dbAll(
    "SELECT * FROM activity_log WHERE kind = 'IMPORT_PRIX_MANQUANT' AND message LIKE ?",
    [`Import #${id}%`],
  );
  assert.equal(entries.length, 1);
  assert.match(entries[0].message, new RegExp(`Import #${id}`));
  assert.match(entries[0].message, /PATCH \/api\/imports\/:id/);
  assert.match(entries[0].message, /0 €/);
});

/* ===================== PRIX D'ACHAT VALIDE ===================== */

test('a valid purchase price produces no warning at all (no permanent noise)', async () => {
  const id = await createImport(10);
  const mock = stubAiFetch();
  let result;
  try {
    result = await generateListingsForImport(id);
  } finally {
    mock.restore();
  }

  assert.equal(result.warning, undefined);
  assert.ok(!('warning' in result), 'le champ ne doit pas exister quand le prix est exploitable');

  // L'import de test est en USD (taux 0,92) : le coût rendu vaut 9,20 et non 10.
  const landed = computeLandedCost({ purchasePrice: 10, currency: 'USD', rates: { USD: 0.92 } });
  const expected = computeSuggestedPrice(landed, config.pricing);
  assert.ok(expected > 0);
  assert.ok(result.listings.every((l) => l.suggestedPrice === expected));

  // Le journal peut déjà contenir les alertes des tests précédents : on ne
  // vérifie l'absence que pour CET import.
  const entries = await dbAll(
    "SELECT * FROM activity_log WHERE kind = 'IMPORT_PRIX_MANQUANT' AND message LIKE ?",
    [`Import #${id}%`],
  );
  assert.equal(entries.length, 0, 'aucune alerte quand le prix est présent');
});

/* ===================== CAS LIMITES ===================== */

test('a valid purchase price still reaches the model prompt', async () => {
  const id = await createImport(4.9, 'EUR');
  const mock = stubAiFetch();
  try {
    await generateListingsForImport(id);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 1, 'un seul appel IA : les marketplaces (own_site non configuré)');
  assert.match(mock.calls[0].url, /\/chat\/completions$/);
  const prompt = mock.calls[0].body.messages[1].content;
  assert.match(prompt, /4\.9 EUR/, 'le prix d\'achat doit figurer dans le prompt');
});

test('an unknown import is still reported rather than generating anything', async () => {
  const mock = stubAiFetch();
  try {
    await assert.rejects(() => generateListingsForImport(999999), /introuvable/);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 0, 'aucun appel IA pour un import inexistant');
});
