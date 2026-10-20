/*
 * Deux garde-fous issus de la littérature sécurité (OWASP, « Excessive
 * Agency ») : le MOINDRE PRIVILÈGE et l'IDEMPOTENCE.
 *
 * 1. Le chien de garde reçoit un jeton qui ne peut QUE créer un import et
 *    générer ses fiches. Il ne lit pas les commandes clients, ne change pas un
 *    prix, ne publie pas. Une fuite sur une machine personnelle casse peu.
 *
 * 2. Créer deux fois le même import est refusé — AVANT l'extraction. Scraper
 *    une page pour découvrir ensuite qu'on la connaissait déjà serait du
 *    travail payé deux fois (réseau, et parfois appel IA).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-jeton-')), 'jeton.db');
const ADMIN = 'cle-admin-de-test-0123456789abcdef';
const LIMITE = 'jeton-imports-de-test-0123456789';
process.env.ADMIN_API_KEY = ADMIN;
process.env.IMPORT_TOKEN = LIMITE;

const { app } = await import('../src/server.js');
const { initDatabase } = await import('../src/db/database.js');

let server;
let base;

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(path, { method = 'GET', body, key = LIMITE } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-Admin-Key'] = key;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

/* ===================== 1. MOINDRE PRIVILÈGE ===================== */

test('le jeton limité peut lire la liste des imports', async () => {
  const { status } = await call('/api/imports');
  assert.equal(status, 200);
});

test('le jeton limité NE PEUT PAS lire les commandes clients', async () => {
  const { status, body } = await call('/api/orders');
  assert.equal(status, 403);
  assert.match(body.error, /Jeton limité aux imports/);
});

test('le jeton limité NE PEUT PAS changer un prix', async () => {
  const { status } = await call('/api/products/1/price', {
    method: 'POST',
    body: { channel: 'own_site', price: 1 },
  });
  assert.equal(status, 403);
});

test('le jeton limité NE PEUT PAS supprimer un import', async () => {
  const { status } = await call('/api/imports/1', { method: 'DELETE' });
  assert.equal(status, 403);
});

test('le jeton limité NE PEUT PAS lire les partenaires ni les devises', async () => {
  assert.equal((await call('/api/suppliers')).status, 403);
  assert.equal((await call('/api/currencies')).status, 403);
});

test('la clé administrateur, elle, passe partout', async () => {
  assert.equal((await call('/api/orders', { key: ADMIN })).status, 200);
  assert.equal((await call('/api/suppliers', { key: ADMIN })).status, 200);
});

test('un jeton faux reste refusé', async () => {
  assert.equal((await call('/api/imports', { key: 'faux' })).status, 401);
});

/* ===================== 2. IDEMPOTENCE ===================== */

const URL_PRODUIT = 'https://fournisseur.test/produit-unique-42';

test('créer deux fois le même import est refusé, avec l’identifiant existant', async () => {
  // La saisie MANUELLE n'est pas dans la liste du jeton limité : c'est un acte
  // humain, pas une automatisation. Elle se fait donc avec la clé admin.
  const premier = await call('/api/imports/manual', {
    method: 'POST',
    key: ADMIN,
    body: { title: 'Produit unique', purchasePrice: 5, currency: 'EUR', url: URL_PRODUIT },
  });
  assert.equal(premier.status, 201);

  const second = await call('/api/imports', { method: 'POST', body: { url: URL_PRODUIT } });
  assert.equal(second.status, 409, 'le doublon doit être refusé');
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.existingId, premier.body.id, 'l’identifiant existant est renvoyé');
  assert.match(second.body.error, /existe déjà/);
});

test('le refus arrive AVANT l’extraction : aucune requête réseau n’est tentée', async () => {
  // Le domaine « fournisseur.test » ne résout pas. Si le hub tentait d'extraire
  // la page, on recevrait une erreur de scraping (400) et non un 409.
  const { status } = await call('/api/imports', { method: 'POST', body: { url: URL_PRODUIT } });
  assert.equal(status, 409);
});

test('un import différent n’est pas bloqué', async () => {
  const autre = await call('/api/imports/manual', {
    method: 'POST',
    key: ADMIN,
    body: { title: 'Autre produit', purchasePrice: 3, currency: 'EUR', url: 'https://fournisseur.test/autre-99' },
  });
  assert.equal(autre.status, 201);
});
