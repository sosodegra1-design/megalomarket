/*
 * Agent « coach » du Dénicheur (src/ai/nicheCoach.js, POST /api/niches/coach).
 *
 * Il affine un axe de recherche AVANT une chasse — il ne génère aucune idée
 * de produit lui-même. Ces tests verrouillent le format renvoyé, le repli
 * "aucun axe donné", et le fait qu'une réponse IA inexploitable produit une
 * erreur claire plutôt qu'un plantage. Même approche que nicheHunter.test.js :
 * le chemin « compatible OpenAI » est stubé via global.fetch, sans réseau.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-niche-coach-')), 'coach.db');
const ADMIN_KEY = 'cle-de-test-niche-coach-0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'https://api.groq.example/openai/v1';
process.env.AI_API_KEY = 'cle-de-test';
process.env.AI_MODEL = 'modele-de-test';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../src/server.js');
const { initDatabase } = await import('../src/db/database.js');

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

test('affine un axe donné et renvoie le raisonnement', async () => {
  const restore = stubAiFetch(JSON.stringify({
    refinedFocus: 'Petit électroménager compact pour studios urbains, saison rentrée, sourcing Europe de l\'Est privilégié.',
    reasoning: 'La rentrée pousse les emménagements en petite surface.',
  }));
  let result;
  try {
    result = await call('/api/niches/coach', { method: 'POST', body: { focus: 'électroménager' } });
  } finally {
    restore();
  }

  assert.equal(result.status, 200);
  assert.match(result.body.refinedFocus, /électroménager|studios/i);
  assert.ok(result.body.reasoning.length > 0);
});

test('sans axe fourni, le coach en propose un et le dit dans le raisonnement', async () => {
  const restore = stubAiFetch(JSON.stringify({
    refinedFocus: 'Accessoires zéro déchet pour la cuisine, forte recherche saisonnière en ce moment.',
    reasoning: 'Aucun axe fourni, proposition par défaut orientée tendance actuelle.',
  }));
  let result;
  try {
    result = await call('/api/niches/coach', { method: 'POST', body: {} });
  } finally {
    restore();
  }

  assert.equal(result.status, 200);
  assert.ok(result.body.refinedFocus.length > 0);
  assert.match(result.body.reasoning, /défaut/i);
});

test('une réponse IA sans refinedFocus exploitable est refusée avec une erreur claire', async () => {
  const restore = stubAiFetch(JSON.stringify({ reasoning: 'incomplet' }));
  let result;
  try {
    result = await call('/api/niches/coach', { method: 'POST', body: { focus: 'jouets' } });
  } finally {
    restore();
  }
  assert.equal(result.status, 400);
  assert.match(result.body.error, /incomplète|manquant/i);
});

test('une réponse IA non-JSON produit une erreur explicite plutôt qu\'un plantage', async () => {
  const restore = stubAiFetch('ceci n\'est pas du JSON');
  let result;
  try {
    result = await call('/api/niches/coach', { method: 'POST', body: { focus: 'jouets' } });
  } finally {
    restore();
  }
  assert.equal(result.status, 400);
  assert.match(result.body.error, /non exploitable/);
});

test('la route exige la clé admin', async () => {
  const response = await fetch(base + '/api/niches/coach', { method: 'POST' });
  assert.equal(response.status, 401);
});
