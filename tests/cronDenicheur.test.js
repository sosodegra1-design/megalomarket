/*
 * Déclencheur externe du Dénicheur (`POST /api/cron/denicheur`).
 *
 * Ce qui est verrouillé ici, c'est la SÉCURITÉ et le comportement en échec :
 *  - pas de jeton configuré -> service fermé (503), jamais ouvert ;
 *  - jeton absent ou faux -> 401 ;
 *  - jeton valide -> la chasse part réellement ;
 *  - une chasse récente -> 429, pour qu'un jeton dérobé ne brûle pas le quota
 *    du modèle en boucle.
 *
 * Le point le plus important : ce jeton est DISTINCT de la clé admin. Il ne doit
 * rien ouvrir d'autre que cette route.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CRON_SECRET = 'jeton-de-test-cron-0123456789';
const ADMIN_KEY = 'cle-admin-de-test-cron-0123456789';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-cron-')), 'cron.db');
process.env.CRON_SECRET = CRON_SECRET;
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'https://api.groq.example/openai/v1';
process.env.AI_API_KEY = 'cle-de-test';
process.env.AI_MODEL = 'modele-de-test';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../src/server.js');
const { initDatabase, dbRun } = await import('../src/db/database.js');
const { config } = await import('../src/config/env.js');

function stubAiFetch() {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).includes('/chat/completions')) return original(url, options);
    const finds = [
      {
        rank: 1,
        title: 'Produit déclenché',
        category: 'Maison',
        rationale: 'Test.',
        targetAudience: 'Tout public',
        priceRange: '10-20 €',
        sourcingHint: 'grossiste européen',
      },
    ];
    const payload = { choices: [{ message: { content: JSON.stringify({ finds }) } }] };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return () => { global.fetch = original; };
}

let server;
let base;

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  config.cron.secret = CRON_SECRET;
});

async function call(path, { method = 'POST', token, adminKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers['X-Cron-Token'] = token;
  if (adminKey !== undefined) headers['X-Admin-Key'] = adminKey;
  const response = await fetch(base + path, { method, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

/* ===================== ÉCHEC EN FERMÉ ===================== */

test('sans CRON_SECRET configurée, le déclencheur est FERMÉ (503)', async () => {
  const sauve = config.cron.secret;
  config.cron.secret = null;
  try {
    const { status } = await call('/api/cron/denicheur', { token: 'nimportequoi' });
    assert.equal(status, 503, 'le défaut dangereux serait « pas de secret, donc pas de contrôle »');
  } finally {
    config.cron.secret = sauve;
  }
});

test('un jeton absent est refusé', async () => {
  const { status } = await call('/api/cron/denicheur', {});
  assert.equal(status, 401);
});

test('un jeton faux est refusé', async () => {
  const { status } = await call('/api/cron/denicheur', { token: 'faux' });
  assert.equal(status, 401);
});

test('la clé ADMIN NE remplace pas le jeton de cron', async () => {
  // Le jeton de cron a un pouvoir étroit : il ne doit pas y avoir de passerelle
  // entre les deux, sinon le secret déposé dans le dépôt ouvrirait tout.
  const { status } = await call('/api/cron/denicheur', { adminKey: ADMIN_KEY });
  assert.equal(status, 401);
});

test('le jeton de cron n’ouvre PAS le reste du back-office', async () => {
  const { status } = await call('/api/imports', { method: 'GET', token: CRON_SECRET });
  assert.equal(status, 401, 'le jeton ne doit ouvrir que la route de chasse');
});

/* ===================== FONCTIONNEMENT ===================== */

test('un jeton valide lance réellement une chasse', async () => {
  const restore = stubAiFetch();
  let resultat;
  try {
    resultat = await call('/api/cron/denicheur', { token: CRON_SECRET });
  } finally {
    restore();
  }

  assert.equal(resultat.status, 200);
  assert.equal(resultat.body.ok, true);
  assert.equal(resultat.body.pistes, 1);
  assert.ok(resultat.body.batchId, 'un lot doit être identifié');
});

test('une chasse récente déclenche le délai de garde (429)', async () => {
  // Le lot vient d'être créé par le test précédent : un jeton dérobé ne doit pas
  // pouvoir enchaîner les chasses et brûler le quota du modèle.
  const restore = stubAiFetch();
  let resultat;
  try {
    resultat = await call('/api/cron/denicheur', { token: CRON_SECRET });
  } finally {
    restore();
  }

  assert.equal(resultat.status, 429);
  assert.match(resultat.body.error, /déjà eu lieu/);
  assert.ok(resultat.body.dernierLotIlYaMinutes >= 0);
});

test('GET donne l’état du déclencheur sans lancer de chasse', async () => {
  const { status, body } = await call('/api/cron/denicheur', { method: 'GET', token: CRON_SECRET });
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.cooldownMinutes, 10);
  assert.equal(body.pret, false, 'le lot vient d’être créé');
});

test('GET exige aussi le jeton', async () => {
  const { status } = await call('/api/cron/denicheur', { method: 'GET' });
  assert.equal(status, 401);
});

test('une chasse en échec renvoie 500, pour que le déclencheur externe le voie', async () => {
  // Sinon un GitHub Actions vert masquerait une chasse qui n'a jamais eu lieu.
  await dbRun('DELETE FROM trend_finds');
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).includes('/chat/completions')) return original(url, options);
    return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
  };
  let resultat;
  try {
    resultat = await call('/api/cron/denicheur', { token: CRON_SECRET });
  } finally {
    global.fetch = original;
  }

  assert.equal(resultat.status, 500);
  assert.equal(resultat.body.ok, false);
  assert.ok(resultat.body.error);
});
