/*
 * Agent « superviseur » du Dénicheur (src/ai/nicheSupervisor.js,
 * POST /api/niches/:batchId/review).
 *
 * Il relit un lot déjà généré : signale les incohérences internes (piste de
 * sourcing hors sujet, prix irréaliste, nom de fournisseur inventé) et,
 * indépendamment du modèle, détecte les quasi-doublons de titre en code —
 * un fait vérifiable, pas une opinion. Un échec de l'appel IA laisse les
 * lignes à `ok: null` (non vérifiées), jamais à un faux "ok".
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-niche-supervisor-')), 'supervisor.db');
const ADMIN_KEY = 'cle-de-test-niche-supervisor-0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'https://api.groq.example/openai/v1';
process.env.AI_API_KEY = 'cle-de-test';
process.env.AI_MODEL = 'modele-de-test';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbAll } = await import('../src/db/database.js');
const { reviewFinds } = await import('../src/ai/nicheSupervisor.js');

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

async function seedBatch(batchId, finds) {
  const now = Date.now();
  for (const find of finds) {
    await dbRun(
      `INSERT INTO trend_finds (batch_id, rank, title, category, rationale, target_audience, price_range, sourcing_hint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [batchId, find.rank, find.title, find.category || '', '', '', find.priceRange || '', find.sourcingHint || '', now],
    );
  }
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

/* ===================== reviewFinds() en mémoire, sans DB ===================== */

test('un quasi-doublon de titre est détecté en code, indépendamment de la réponse IA', async () => {
  const restore = stubAiFetch(JSON.stringify({
    reviewed: [
      { rank: 1, ok: true, issue: null },
      { rank: 2, ok: true, issue: null },
    ],
  }));
  let result;
  try {
    result = await reviewFinds([
      { rank: 1, title: 'Gourde isotherme 750 ml', category: 'Maison', priceRange: '15-25 €', sourcingHint: '' },
      { rank: 2, title: 'gourde,   isotherme   750 ML !!', category: 'Maison', priceRange: '15-25 €', sourcingHint: '' },
    ]);
  } finally {
    restore();
  }
  // Le doublon l'emporte sur le "ok: true" renvoyé par l'IA : c'est un fait
  // vérifiable, il ne doit jamais être masqué par l'avis du modèle.
  assert.equal(result.reviewed[0].ok, false);
  assert.equal(result.reviewed[1].ok, false);
  assert.match(result.reviewed[0].issue, /#2/);
  assert.match(result.reviewed[1].issue, /#1/);
});

test('reprend le verdict de l\'IA pour les lignes sans doublon', async () => {
  const restore = stubAiFetch(JSON.stringify({
    reviewed: [
      { rank: 1, ok: true, issue: null },
      { rank: 2, ok: false, issue: 'Fournisseur textile proposé pour un objet électronique.' },
    ],
  }));
  let result;
  try {
    result = await reviewFinds([
      { rank: 1, title: 'Gourde isotherme', category: 'Maison', priceRange: '15-25 €', sourcingHint: 'fabricant en Pologne' },
      { rank: 2, title: 'Casque bluetooth', category: 'Électronique', priceRange: '20-30 €', sourcingHint: 'fabricant textile au Portugal' },
    ]);
  } finally {
    restore();
  }
  assert.equal(result.reviewed[0].ok, true);
  assert.equal(result.reviewed[1].ok, false);
  assert.match(result.reviewed[1].issue, /textile/);
});

test('un échec de l\'appel IA laisse les lignes non vérifiées, jamais un faux "ok"', async () => {
  const restore = stubAiFetch('ceci n\'est pas du JSON');
  let result;
  try {
    result = await reviewFinds([
      { rank: 1, title: 'Produit A', category: 'Maison', priceRange: '10 €', sourcingHint: '' },
    ]);
  } finally {
    restore();
  }
  assert.equal(result.reviewed[0].ok, null);
  assert.match(result.reviewed[0].issue, /indisponible/);
  assert.ok(result.error);
});

/* ===================== POST /api/niches/:batchId/review ===================== */

test('la relecture d\'un lot met à jour chaque ligne en base et journalise le résultat', async () => {
  const restore = stubAiFetch(JSON.stringify({
    reviewed: [
      { rank: 1, ok: true, issue: null },
      { rank: 2, ok: false, issue: 'Prix manifestement trop bas pour ce type de produit.' },
    ],
  }));
  let result;
  try {
    await seedBatch('batch-review-1', [
      { rank: 1, title: 'Produit sain', priceRange: '20-30 €' },
      { rank: 2, title: 'Produit suspect', priceRange: '0,50-1 €' },
    ]);
    result = await call('/api/niches/batch-review-1/review', { method: 'POST' });
  } finally {
    restore();
  }

  assert.equal(result.status, 200);
  assert.equal(result.body.reviewed.length, 2);

  const rows = await dbAll('SELECT rank, review_ok AS reviewOk, review_issue AS reviewIssue FROM trend_finds WHERE batch_id = ? ORDER BY rank', ['batch-review-1']);
  assert.equal(rows[0].reviewOk, 1);
  assert.equal(rows[0].reviewIssue, null);
  assert.equal(rows[1].reviewOk, 0);
  assert.match(rows[1].reviewIssue, /trop bas/);
});

test('relire un lot inconnu échoue avec un message clair, sans écrire quoi que ce soit', async () => {
  const restore = stubAiFetch(JSON.stringify({ reviewed: [] }));
  let result;
  try {
    result = await call('/api/niches/lot-fantome/review', { method: 'POST' });
  } finally {
    restore();
  }
  assert.equal(result.status, 400);
  assert.match(result.body.error, /introuvable/);
});

test('GET /api/niches/latest renvoie le verdict de supervision après relecture', async () => {
  const restore = stubAiFetch(JSON.stringify({
    reviewed: [{ rank: 1, ok: true, issue: null }],
  }));
  try {
    await seedBatch('batch-review-2', [{ rank: 1, title: 'Produit unique', priceRange: '10 €' }]);
    await call('/api/niches/batch-review-2/review', { method: 'POST' });
  } finally {
    restore();
  }

  const latest = await call('/api/niches/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.body.batchId, 'batch-review-2');
  assert.equal(latest.body.finds[0].reviewOk, 1);
});
