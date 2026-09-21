/*
 * Agent « chasseur de pépites » (src/ai/nicheHunter.js, POST/GET /api/niches).
 *
 * Aucune donnée de ventes mondiales n'est disponible dans ce projet : le
 * résultat est une suggestion générée par le modèle, jamais un classement
 * vérifié. Ces tests verrouillent le format stocké (20 lignes classées,
 * un lot par génération) et le fait qu'une génération invalide ne casse
 * jamais le service — même approche que listingGenerator.test.js : le
 * chemin « compatible OpenAI » est stubé via global.fetch, sans réseau.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-niches-')), 'niches.db');
const ADMIN_KEY = 'cle-de-test-niches-0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'https://api.groq.example/openai/v1';
process.env.AI_API_KEY = 'cle-de-test';
process.env.AI_MODEL = 'modele-de-test';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../src/server.js');
const { initDatabase, dbAll } = await import('../src/db/database.js');

function makeFind(rank) {
  return {
    rank,
    title: `Produit tendance ${rank}`,
    category: 'Maison',
    rationale: 'Forte demande saisonnière constatée sur plusieurs canaux.',
    targetAudience: 'Familles avec jeunes enfants',
    priceRange: '15-25 €',
  };
}

/*
 * N'intercepte QUE l'appel sortant vers le fournisseur IA (/chat/completions) :
 * la fonction `call()` ci-dessous utilise elle aussi `fetch` pour joindre le
 * serveur local de test, et un stub inconditionnel avalerait ces deux appels
 * au lieu du seul appel réseau qu'on veut simuler.
 */
function stubAiFetch(content) {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).includes('/chat/completions')) return original(url, options);
    const payload = { choices: [{ message: { content } }] };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return () => { global.fetch = original; };
}

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

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('une chasse valide enregistre 20 suggestions classées et les renvoie triées', async () => {
  const finds = Array.from({ length: 20 }, (_, i) => makeFind(i + 1));
  const restore = stubAiFetch(JSON.stringify({ finds }));
  let result;
  try {
    result = await call('/api/niches/hunt', { method: 'POST', body: {} });
  } finally {
    restore();
  }

  assert.equal(result.status, 200);
  assert.equal(result.body.finds.length, 20);
  assert.ok(result.body.batchId);
  assert.deepEqual(result.body.finds.map((f) => f.rank), Array.from({ length: 20 }, (_, i) => i + 1));

  const rows = await dbAll('SELECT * FROM trend_finds WHERE batch_id = ?', [result.body.batchId]);
  assert.equal(rows.length, 20);
});

test('GET /api/niches/latest renvoie le lot le plus récent', async () => {
  const restore = stubAiFetch(JSON.stringify({ finds: Array.from({ length: 20 }, (_, i) => makeFind(i + 1)) }));
  let hunted;
  try {
    hunted = await call('/api/niches/hunt', { method: 'POST', body: {} });
  } finally {
    restore();
  }

  const latest = await call('/api/niches/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.body.batchId, hunted.body.batchId);
  assert.equal(latest.body.finds.length, 20);
  assert.equal(latest.body.finds[0].rank, 1);
});

test('une réponse IA sans "finds" exploitable est refusée sans rien enregistrer', async () => {
  const restore = stubAiFetch(JSON.stringify({ finds: [] }));
  let result;
  try {
    result = await call('/api/niches/hunt', { method: 'POST', body: {} });
  } finally {
    restore();
  }
  assert.equal(result.status, 400);
  assert.match(result.body.error, /aucune suggestion/);
});

test('une réponse IA non-JSON produit une erreur claire plutôt qu\'un plantage', async () => {
  const restore = stubAiFetch('ceci n\'est pas du JSON');
  let result;
  try {
    result = await call('/api/niches/hunt', { method: 'POST', body: {} });
  } finally {
    restore();
  }
  assert.equal(result.status, 400);
  assert.match(result.body.error, /non exploitable/);
});

test('la route de chasse exige la clé admin', async () => {
  const response = await fetch(base + '/api/niches/hunt', { method: 'POST' });
  assert.equal(response.status, 401);
});
