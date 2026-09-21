/*
 * Registre des distributeurs (GET/POST/PATCH/DELETE /api/distributors).
 *
 * Ces distributeurs sont des clients B2B en aval (Megalomarket leur vend en
 * gros) — l'inverse du `kind: 'distributeur'` de /api/suppliers (une
 * plateforme de sourcing, en amont). Tests calqués sur suppliers.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-distributors-')), 'distributors.db');
const ADMIN_KEY = 'cle-de-test-distributors-0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase } = await import('../src/db/database.js');

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

function validDistributor(overrides = {}) {
  return {
    name: 'Toys & Co Wholesale',
    contactEmail: 'achats@toysandco.example',
    region: 'Bénélux',
    ...overrides,
  };
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

test('un distributeur valide est créé, nommé et actif par défaut', async () => {
  const { status, body } = await call('/api/distributors', {
    method: 'POST',
    body: validDistributor({ name: '  Toys & Co Wholesale  ' }),
  });

  assert.equal(status, 201);
  assert.equal(body.name, 'Toys & Co Wholesale', 'le nom est nettoyé des espaces');
  assert.equal(body.contact_email, 'achats@toysandco.example');
  assert.equal(body.region, 'Bénélux');
  assert.equal(body.status, 'actif');
  assert.ok(body.created_at);
  assert.ok(body.updated_at);
});

test('un nom vide est refusé', async () => {
  const { status, body } = await call('/api/distributors', { method: 'POST', body: validDistributor({ name: '   ' }) });
  assert.equal(status, 400);
  assert.match(body.error, /Nom invalide/);
});

test('un e-mail mal formé est refusé', async () => {
  const { status, body } = await call('/api/distributors', {
    method: 'POST',
    body: validDistributor({ contactEmail: 'pas-un-email' }),
  });
  assert.equal(status, 400);
  assert.match(body.error, /invalide/);
});

test('un statut inconnu est refusé', async () => {
  const { status, body } = await call('/api/distributors', {
    method: 'POST',
    body: validDistributor({ status: 'archive' }),
  });
  assert.equal(status, 400);
  assert.match(body.error, /Statut invalide/);
});

test('la liste renvoie les distributeurs triés par nom, filtrable par statut', async () => {
  await call('/api/distributors', { method: 'POST', body: validDistributor({ name: 'Zeta Retail', status: 'inactif' }) });
  await call('/api/distributors', { method: 'POST', body: validDistributor({ name: 'Alpha Retail' }) });

  const all = await call('/api/distributors');
  assert.equal(all.status, 200);
  const names = all.body.map((d) => d.name);
  assert.ok(names.indexOf('Alpha Retail') < names.indexOf('Zeta Retail'), 'tri alphabétique');

  const actifs = await call('/api/distributors?status=actif');
  assert.ok(actifs.body.every((d) => d.status === 'actif'));
});

test('un filtre de statut inconnu est refusé plutôt qu\'ignoré', async () => {
  const { status, body } = await call('/api/distributors?status=archive');
  assert.equal(status, 400);
  assert.match(body.error, /Statut invalide/);
});

test('la modification partielle ne touche que les champs fournis', async () => {
  const created = await call('/api/distributors', { method: 'POST', body: validDistributor({ name: 'Nordic Kids' }) });
  const { status, body } = await call('/api/distributors/' + created.body.id, {
    method: 'PATCH',
    body: { status: 'inactif' },
  });
  assert.equal(status, 200);
  assert.equal(body.status, 'inactif');
  assert.equal(body.name, 'Nordic Kids', 'le nom non fourni reste inchangé');
  assert.equal(body.contact_email, 'achats@toysandco.example', 'l\'e-mail non fourni reste inchangé');
});

test('modifier un distributeur inexistant est refusé', async () => {
  const { status, body } = await call('/api/distributors/999999', { method: 'PATCH', body: { status: 'inactif' } });
  assert.equal(status, 400);
  assert.match(body.error, /introuvable/);
});

test('la suppression retire bien la fiche', async () => {
  const created = await call('/api/distributors', { method: 'POST', body: validDistributor({ name: 'À supprimer' }) });
  const del = await call('/api/distributors/' + created.body.id, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  const after1 = await call('/api/distributors');
  assert.ok(!after1.body.some((d) => d.id === created.body.id));
});

test('supprimer un distributeur inexistant est refusé', async () => {
  const { status, body } = await call('/api/distributors/999999', { method: 'DELETE' });
  assert.equal(status, 400);
  assert.match(body.error, /introuvable/);
});

test('toutes les routes distributeurs exigent la clé admin', async () => {
  const response = await fetch(base + '/api/distributors');
  assert.equal(response.status, 401);
});
