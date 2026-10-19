/*
 * MOQ — la quantité minimale que le fournisseur accepte.
 *
 * POURQUOI C'EST DEVENU UNE COLONNE À PART. Comparer des fournisseurs pour un
 * même produit, c'est d'abord comparer deux choses : le prix, et la quantité
 * minimale. Certains n'acceptent que 500 pièces, d'autres 10 — et pour tester un
 * produit sans immobiliser un stock, le MOQ est le premier critère.
 *
 * Deux erreurs sont verrouillées ici :
 *  - confondre MOQ et quantité commandée : le MOQ est un PLANCHER fournisseur,
 *    la quantité de lot est ce qu'on décide d'acheter ;
 *  - afficher « 1 » quand le MOQ est inconnu, ce qui laisserait croire à une
 *    vente à l'unité alors qu'on ne sait rien.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-moq-')), 'moq.db');
const ADMIN_KEY = 'cle-de-test-moq-0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;

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

/* ===================== L'API ===================== */

test('un import à la main porte le MOQ ET la quantité de lot', async () => {
  const { status, body } = await call('/api/imports/manual', {
    method: 'POST',
    body: { title: 'Pistolet à bulles EPT', purchasePrice: 8.3, currency: 'USD', moq: 10 },
  });
  assert.equal(status, 201);
  assert.equal(body.moq, 10, 'le MOQ fournisseur est conservé');
  assert.equal(body.lotQuantity, 10, 'et sert de quantité de lot par défaut');
});

test('sans MOQ connu, on ne prétend PAS qu’il vaut 1', async () => {
  const { body } = await call('/api/imports/manual', {
    method: 'POST',
    body: { title: 'Sans MOQ', purchasePrice: 3, currency: 'EUR' },
  });
  assert.equal(body.moq, null, 'inconnu reste inconnu');
  assert.equal(body.lotQuantity, 1, 'la quantité de lot garde son défaut');
});

test('le MOQ est relu par la liste des imports', async () => {
  const { body } = await call('/api/imports');
  const rows = Array.isArray(body) ? body : body.imports || [];
  const avec = rows.find((r) => r.title === 'Pistolet à bulles EPT');
  assert.ok(avec, 'l’import doit être dans la liste');
  assert.equal(avec.moq, 10);
});

/* ===================== L'ÉCRAN ===================== */

test('le tableau des imports a une colonne MOQ triable', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-sort="moq"/, 'la colonne doit être triable : c’est le premier critère de comparaison');
  assert.match(html, /data-label="MOQ"/, 'la cellule doit exister');
});

test('un MOQ inconnu s’affiche « — », jamais « 1 »', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  // La cellule doit distinguer explicitement le cas inconnu.
  const cellule = html.slice(html.indexOf('data-label="MOQ"'), html.indexOf('data-label="MOQ"') + 400);
  assert.match(cellule, /—/, 'le tiret cadratin signale l’absence');
  assert.match(cellule, /i\.moq == null/, 'le cas inconnu est testé explicitement');
});

test('un petit MOQ est mis en évidence', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const cellule = html.slice(html.indexOf('data-label="MOQ"'), html.indexOf('data-label="MOQ"') + 500);
  // « ≤ 10 » est le seuil qui intéresse l'utilisateur : on peut tester un
  // produit sans immobiliser de stock.
  assert.match(cellule, /<= 10/, 'le seuil de mise en évidence est explicite');
});
