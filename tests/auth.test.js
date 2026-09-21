/* Authentification du service.
 *
 * Megalomarket est un back-office : ses routes exposent les commandes clients,
 * le catalogue et le journal d'activité, et certaines publient réellement sur
 * les marketplaces. Aucune n'était protégée. Ces tests verrouillent le
 * comportement attendu, y compris le cas le plus dangereux — une clé oubliée
 * lors d'un déploiement.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-auth-')), 'auth.db');
const ADMIN_KEY = 'cle-de-test-0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase } = await import('../src/db/database.js');

let server;
let base;

async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
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

/* ===================== SEULE ROUTE PUBLIQUE ===================== */

test('/api/health stays public so monitoring and the keep-alive ping work', async () => {
  const { status, body } = await call('/api/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
});

test('health stays reachable even when the service is locked', async () => {
  const saved = process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_API_KEY;
  try {
    assert.equal((await call('/api/health')).status, 200, 'sinon le service serait indiagnosticable');
  } finally {
    process.env.ADMIN_API_KEY = saved;
  }
});

/* ===================== ÉCHEC EN FERMÉ ===================== */

test('without ADMIN_API_KEY the service locks itself instead of opening up', async () => {
  const saved = process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_API_KEY;
  try {
    const { status, body } = await call('/api/products');
    assert.equal(status, 503);
    assert.match(body.error, /ADMIN_API_KEY/);

    // Les routes qui publient réellement sont évidemment concernées.
    assert.equal((await call('/api/sync/stock', { method: 'POST' })).status, 503);
    assert.equal((await call('/api/imports', { method: 'POST', body: { url: 'https://x/y' } })).status, 503);
  } finally {
    process.env.ADMIN_API_KEY = saved;
  }
});

/* ===================== REJET DES MAUVAISES CLÉS ===================== */

test('a request without any key is refused', async () => {
  const { status, body } = await call('/api/products');
  assert.equal(status, 401);
  assert.match(body.error, /absente ou invalide/);
});

test('a 401 advertises Basic auth so a browser shows its login prompt', async () => {
  const { status, headers } = await call('/api/products');
  assert.equal(status, 401);
  // Sans cet en-tête, ouvrir le tableau de bord afficherait un JSON 401 au lieu
  // de demander les identifiants.
  assert.match(headers.get('www-authenticate') || '', /^Basic realm=/);
});

test('a wrong key is refused, including one of a different length', async () => {
  assert.equal((await call('/api/products', { headers: { 'X-Admin-Key': 'mauvais' } })).status, 401);
  // timingSafeEqual lève sur des longueurs différentes : la longueur est donc
  // testée avant, et une clé trop courte doit simplement être rejetée.
  assert.equal((await call('/api/products', { headers: { 'X-Admin-Key': 'x' } })).status, 401);
  assert.equal((await call('/api/products', { headers: { 'X-Admin-Key': ADMIN_KEY + 'x' } })).status, 401);
});

test('a malformed Authorization header does not crash the service', async () => {
  for (const value of ['Basic', 'Basic !!!not-base64!!!', 'Bearer', 'Basic ' + Buffer.from('sansseparateur').toString('base64')]) {
    const { status } = await call('/api/products', { headers: { Authorization: value } });
    assert.equal(status, 401, `en-tête « ${value} »`);
  }
  // Le service répond toujours après ces tentatives.
  assert.equal((await call('/api/health')).status, 200);
});

/* ===================== LES TROIS MODES D'ACCÈS ===================== */

test('the key is accepted as X-Admin-Key', async () => {
  const { status, body } = await call('/api/products', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('the key is accepted as a Bearer token', async () => {
  const { status } = await call('/api/products', { headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
  assert.equal(status, 200);
});

test('the key is accepted as the password of an HTTP Basic pair', async () => {
  // C'est le mode qui rend le tableau de bord utilisable sans page de connexion :
  // le navigateur met les identifiants en cache et les renvoie sur chaque
  // requête, y compris celles lancées en JavaScript.
  const encoded = Buffer.from(`peu-importe:${ADMIN_KEY}`).toString('base64');
  const { status } = await call('/api/products', { headers: { Authorization: `Basic ${encoded}` } });
  assert.equal(status, 200);
});

test('the user name of the Basic pair is ignored', async () => {
  const encoded = Buffer.from(`admin:${ADMIN_KEY}`).toString('base64');
  assert.equal((await call('/api/products', { headers: { Authorization: `Basic ${encoded}` } })).status, 200);
});

/* ===================== CE QUI EST PROTÉGÉ ===================== */

test('the whole back-office is behind the key', async () => {
  const routes = [
    ['/api/products', 'GET'],
    ['/api/channels', 'GET'],
    ['/api/orders', 'GET'],
    ['/api/recommendations', 'GET'],
    ['/api/activity', 'GET'],
    ['/api/imports', 'GET'],
    ['/api/sync/stock', 'POST'],
    ['/api/sync/orders', 'POST'],
  ];
  for (const [path, method] of routes) {
    const { status } = await call(path, { method });
    assert.equal(status, 401, `${method} ${path} doit exiger la clé`);
  }
});

test('the dashboard page itself is behind the key', async () => {
  assert.equal((await call('/')).status, 401);
  const withKey = await call('/', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  assert.equal(withKey.status, 200);
  assert.match(withKey.body, /Megalomarket/);
});

test('publishing to a marketplace is behind the key, which was the real risk', async () => {
  // Cette route publiait sur eBay et sur le site propre, sans aucune protection.
  const { status } = await call('/api/imports/1/listings/own_site/publish', { method: 'POST' });
  assert.equal(status, 401);
});

/* ===================== L'API FONCTIONNE TOUJOURS ===================== */

test('with the key, the API behaves exactly as before', async () => {
  const created = await call('/api/products', {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY },
    body: { sku: 'AUTH-1', name: 'Produit authentifié', costPrice: 5 },
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.id);

  const listed = await call('/api/products', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.some((product) => product.sku === 'AUTH-1'));
});

test('an unauthenticated write leaves no trace in the database', async () => {
  await call('/api/products', { method: 'POST', body: { sku: 'INTRUS', name: 'Intrusion' } });
  const listed = await call('/api/products', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  assert.ok(!listed.body.some((product) => product.sku === 'INTRUS'));
});
