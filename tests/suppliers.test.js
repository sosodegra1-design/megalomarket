/*
 * Registre des partenaires (GET/POST/PATCH/DELETE /api/suppliers).
 *
 * Le hub ne connaissait aucun fournisseur : le nom se retapait à chaque import
 * et la marge négociée avec chacun n'existait nulle part. Ces tests verrouillent
 * le registre — et surtout ses deux refus qui protègent l'argent : un
 * coefficient de marge inférieur ou égal à 1 (vente à perte) et un partenaire
 * inexistant. Ils verrouillent aussi la suppression : retirer un partenaire ne
 * doit JAMAIS effacer l'import ni ses fiches.
 *
 * Aucun réseau : le serveur Express est écouté sur un port éphémère et les
 * imports sont insérés directement en base.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-suppliers-')), 'suppliers.db');
const ADMIN_KEY = 'cle-de-test-suppliers-0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbGet } = await import('../src/db/database.js');
const { config } = await import('../src/config/env.js');

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

function validSupplier(overrides = {}) {
  return {
    kind: 'fournisseur',
    name: 'Shenzhen Toys Ltd',
    siteUrl: 'https://shenzhen-toys.example.com',
    marginCoefficient: 2.4,
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

/* ===================== CRÉATION ===================== */

test('un partenaire valide est créé, nommé et doté de sa marge', async () => {
  const { status, body } = await call('/api/suppliers', {
    method: 'POST',
    body: validSupplier({ name: '  Shenzhen Toys Ltd  ', notes: '  plateforme de gros  ' }),
  });

  assert.equal(status, 201);
  assert.equal(body.kind, 'fournisseur');
  assert.equal(body.name, 'Shenzhen Toys Ltd', 'le nom est nettoyé des espaces');
  assert.equal(body.site_url, 'https://shenzhen-toys.example.com');
  assert.equal(body.margin_coefficient, 2.4);
  assert.equal(body.status, 'actif', 'un partenaire sans statut est actif');
  assert.equal(body.notes, 'plateforme de gros');
  assert.equal(body.import_count, 0);
  assert.ok(body.created_at, 'la date de création est renseignée');
  assert.ok(body.updated_at, 'la date de modification est renseignée');
});

test('un partenaire sans marge propre annonce le coefficient global', async () => {
  const { status, body } = await call('/api/suppliers', {
    method: 'POST',
    body: validSupplier({ kind: 'distributeur', name: 'Grossiste du coin', marginCoefficient: null }),
  });

  assert.equal(status, 201);
  assert.equal(body.margin_coefficient, null);
  // NULL n'est pas « marge = défaut » : c'est « pas de marge propre ». L'UI doit
  // pouvoir le dire, et l'import doit retomber sur le défaut global.
  assert.equal(body.usesDefaultMargin, true);
  assert.equal(body.effectiveMarginCoefficient, config.pricing.marginCoefficient);
  assert.equal(body.defaultMarginCoefficient, config.pricing.marginCoefficient);
});

/* ===================== VALIDATION ===================== */

test('le type est obligatoire et limité à fournisseur/distributeur', async () => {
  for (const kind of [undefined, null, '', 'grossiste', 'FOURNISSEUR']) {
    const { status, body } = await call('/api/suppliers', { method: 'POST', body: validSupplier({ kind }) });
    assert.equal(status, 400, `type « ${String(kind)} »`);
    assert.match(body.error, /Type de partenaire invalide/);
  }
});

test('le nom est obligatoire et ne peut pas être vide', async () => {
  for (const name of [undefined, null, '', '   ', 42]) {
    const { status, body } = await call('/api/suppliers', { method: 'POST', body: validSupplier({ name }) });
    assert.equal(status, 400, `nom « ${String(name)} »`);
    assert.match(body.error, /Nom invalide/);
  }
});

test("une marge inférieure ou égale à 1 est refusée : ce serait une vente à perte", async () => {
  for (const marginCoefficient of [1, 0.5, -1, 0]) {
    const { status, body } = await call('/api/suppliers', {
      method: 'POST',
      body: validSupplier({ marginCoefficient }),
    });
    assert.equal(status, 400, `marge ${marginCoefficient}`);
    assert.match(body.error, /Coefficient de marge invalide/);
    assert.match(body.error, /vente à perte/, 'la conséquence doit être dite');
  }
});

test("une marge fournie en texte est refusée plutôt que devinée", async () => {
  for (const marginCoefficient of ['2.5', '2,5', {}, []]) {
    const { status } = await call('/api/suppliers', {
      method: 'POST',
      body: validSupplier({ marginCoefficient }),
    });
    assert.equal(status, 400, `marge ${JSON.stringify(marginCoefficient)}`);
  }
});

test('une URL de site non http(s) est refusée', async () => {
  for (const siteUrl of ['ftp://exemple.com', 'pas-une-url', 'javascript:alert(1)', 'exemple.com']) {
    const { status, body } = await call('/api/suppliers', { method: 'POST', body: validSupplier({ siteUrl }) });
    assert.equal(status, 400, `URL « ${siteUrl} »`);
    assert.match(body.error, /URL de site invalide/);
  }
});

test('un statut hors liste est refusé', async () => {
  const { status, body } = await call('/api/suppliers', {
    method: 'POST',
    body: validSupplier({ status: 'pending' }),
  });
  assert.equal(status, 400);
  assert.match(body.error, /Statut invalide/);
});

/* ===================== LISTE ET FILTRE ===================== */

test('la liste est triée par nom sans tenir compte de la casse', async () => {
  const { status, body } = await call('/api/suppliers');
  assert.equal(status, 200);
  const names = body.map((s) => s.name);
  const sorted = names.slice().sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  assert.deepEqual(names, sorted, 'l’ordre doit ignorer la casse');
});

test('le filtre ?kind sépare fournisseurs et distributeurs', async () => {
  await call('/api/suppliers', { method: 'POST', body: validSupplier({ name: 'Alpha Import', kind: 'fournisseur' }) });
  await call('/api/suppliers', { method: 'POST', body: validSupplier({ name: 'Zêta Distribution', kind: 'distributeur' }) });

  const fournisseurs = await call('/api/suppliers?kind=fournisseur');
  assert.equal(fournisseurs.status, 200);
  assert.ok(fournisseurs.body.length >= 2);
  assert.ok(fournisseurs.body.every((s) => s.kind === 'fournisseur'));

  const distributeurs = await call('/api/suppliers?kind=distributeur');
  assert.ok(distributeurs.body.every((s) => s.kind === 'distributeur'));

  // Un type inconnu est refusé, jamais ignoré en silence : sinon la liste
  // complète passerait pour la liste filtrée.
  const bad = await call('/api/suppliers?kind=grossiste');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Type de partenaire invalide/);
});

/* ===================== MODIFICATION ===================== */

test('un PATCH partiel ne touche que les champs fournis', async () => {
  const created = await call('/api/suppliers', { method: 'POST', body: validSupplier({ name: 'Partenaire à modifier' }) });
  const id = created.body.id;

  const { status, body } = await call(`/api/suppliers/${id}`, { method: 'PATCH', body: { marginCoefficient: 3.1 } });
  assert.equal(status, 200);
  assert.equal(body.margin_coefficient, 3.1);
  assert.equal(body.name, 'Partenaire à modifier', 'un PATCH partiel ne doit rien effacer');
  assert.equal(body.kind, 'fournisseur');
});

test('remettre la marge à null revient explicitement au coefficient global', async () => {
  const created = await call('/api/suppliers', { method: 'POST', body: validSupplier({ name: 'Retour au défaut', marginCoefficient: 4 }) });
  const { status, body } = await call(`/api/suppliers/${created.body.id}`, {
    method: 'PATCH',
    body: { marginCoefficient: null },
  });
  assert.equal(status, 200);
  assert.equal(body.margin_coefficient, null);
  assert.equal(body.usesDefaultMargin, true);
});

test('les champs inconnus sont ignorés et un corps sans champ exploitable est refusé', async () => {
  const created = await call('/api/suppliers', { method: 'POST', body: validSupplier({ name: 'Champs inconnus' }) });
  const id = created.body.id;

  const empty = await call(`/api/suppliers/${id}`, {
    method: 'PATCH',
    body: { id: 999, created_at: 'hier', import_count: 12 },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /Aucune modification fournie/);

  const mixed = await call(`/api/suppliers/${id}`, { method: 'PATCH', body: { name: 'Renommé', id: 999 } });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.body.name, 'Renommé');
  assert.equal(mixed.body.id, id, 'un champ inconnu ne doit jamais être appliqué');
});

test('un identifiant inconnu est signalé clairement', async () => {
  const patch = await call('/api/suppliers/999999', { method: 'PATCH', body: { name: 'Fantôme' } });
  assert.equal(patch.status, 400);
  assert.match(patch.body.error, /introuvable/i);

  const remove = await call('/api/suppliers/999999', { method: 'DELETE' });
  assert.equal(remove.status, 400);
  assert.match(remove.body.error, /introuvable/i);
});

/* ===================== SUPPRESSION SANS PERTE D'HISTORIQUE ===================== */

test("supprimer un partenaire détache ses imports au lieu de les détruire", async () => {
  const created = await call('/api/suppliers', { method: 'POST', body: validSupplier({ name: 'Partenaire éphémère' }) });
  const supplierId = created.body.id;

  const info = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 'brouillon', ?, ?)`,
    ['https://supplier.example/item/1.html', 'aliexpress', 'Archive à conserver', '', 9.9, 'USD', supplierId, Date.now()],
  );
  const importId = info.lastInsertRowid;

  // Le compteur d'imports rend visible l'usage avant de supprimer.
  const listed = await call('/api/suppliers');
  assert.equal(listed.body.find((s) => s.id === supplierId).import_count, 1);

  const removed = await call(`/api/suppliers/${supplierId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);
  assert.equal(removed.body.detachedImports, 1);

  const gone = await dbGet('SELECT id FROM suppliers WHERE id = ?', [supplierId]);
  assert.equal(gone, undefined, 'la fiche du partenaire disparaît');

  const kept = await dbGet('SELECT * FROM imports WHERE id = ?', [importId]);
  assert.ok(kept, "l'import est conservé : c'est une archive, pas une décoration");
  assert.equal(kept.supplier_id, null, "le lien est coupé, l'historique reste lisible");
  assert.equal(kept.title, 'Archive à conserver');

  const detail = await call(`/api/imports/${importId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.supplier, null, 'le détail ne prétend plus connaître le partenaire');
});
