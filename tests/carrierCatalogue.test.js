/*
 * Catalogue des transporteurs internationaux et route des partenaires.
 *
 * Le propriétaire source en Chine et vend en France : la logistique est la
 * moitié de son métier. Ces tests verrouillent trois choses :
 *
 *   - la forme du catalogue (chaque entrée passerait la validation de l'API :
 *     type valide, nom unique, adresse http(s), notes utiles) ;
 *   - son installation, réservée à l'absence de TOUT transporteur — un
 *     fournisseur ne doit jamais bloquer le catalogue logistique, et
 *     inversement ;
 *   - la route : `transporteur` est un type à part entière, filtrable, et un
 *     type inconnu reste refusé.
 *
 * Aucun réseau : le serveur Express est écouté sur un port éphémère et la base
 * est un fichier temporaire.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-carriers-')), 'carriers.db');
const ADMIN_KEY = 'cle-de-test-transporteurs-0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { CARRIER_CATALOGUE, seedCarriersIfEmpty } = await import('../src/db/carrier-catalogue.js');
const { app } = await import('../src/server.js');
const { client, initDatabase, dbAll, dbRun, dbGet } = await import('../src/db/database.js');

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

async function countCarriers() {
  const rows = await dbAll("SELECT COUNT(*) AS total FROM suppliers WHERE kind = 'transporteur'");
  return Number(rows[0].total);
}

async function insertSupplier(kind, name) {
  const now = new Date().toISOString();
  return dbRun(
    `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
     VALUES (?, ?, NULL, 2.0, 'actif', NULL, ?, ?)`,
    [kind, name, now, now],
  );
}

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await client.close();
});

/* ===================== FORME DU CATALOGUE ===================== */

test('chaque entrée du catalogue transporteur est exploitable telle quelle', () => {
  assert.ok(CARRIER_CATALOGUE.length > 0, 'un catalogue vide ne réglerait pas le problème');
  assert.equal(CARRIER_CATALOGUE.length, 23, 'les 23 transporteurs réels doivent tous être présents');

  for (const entry of CARRIER_CATALOGUE) {
    const label = entry?.name ?? JSON.stringify(entry);
    assert.equal(entry.kind, 'transporteur', `${label} : type transporteur`);

    assert.equal(typeof entry.name, 'string', `${label} : nom textuel`);
    assert.ok(entry.name.trim().length > 0, `${label} : nom non vide`);

    // Sans protocole http(s), la route POST refuserait l'adresse : le catalogue
    // installerait alors des fiches impossibles à reproduire depuis l'écran.
    assert.match(entry.siteUrl, /^https?:\/\/\S+$/, `${label} : adresse http(s)`);

    // Le coefficient n'a pas de sens pour un transporteur (un service ne se
    // revend pas avec une marge) : c'est un remplissage technique qui doit
    // simplement satisfaire la règle « > 1 » de l'API.
    assert.equal(typeof entry.marginCoefficient, 'number', `${label} : coefficient numérique`);
    assert.ok(entry.marginCoefficient > 1, `${label} : coefficient strictement supérieur à 1`);

    assert.equal(typeof entry.notes, 'string', `${label} : notes textuelles`);
    assert.ok(entry.notes.trim().length > 0, `${label} : notes non vides — elles expliquent l'usage`);
  }
});

test('aucun nom de transporteur n’est présent deux fois', () => {
  const names = CARRIER_CATALOGUE.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, 'un doublon créerait deux fiches indiscernables');

  // Les notes sont rédigées en français : le catalogue doit rester accentué,
  // sinon l'écran afficherait des libellés amputés.
  assert.match(CARRIER_CATALOGUE.map((entry) => entry.notes).join(' '), /[éèêàçùôî]/);
});

/* ===================== INSTALLATION ===================== */

test('un fournisseur présent ne bloque pas le catalogue des transporteurs', async () => {
  await dbRun('DELETE FROM suppliers');
  await insertSupplier('fournisseur', 'Fournisseur déjà saisi');

  assert.equal(await countCarriers(), 0, 'aucun transporteur avant de semer');

  const result = await seedCarriersIfEmpty();
  assert.deepEqual(result, { seeded: CARRIER_CATALOGUE.length });
  assert.equal(await countCarriers(), CARRIER_CATALOGUE.length);

  // Le fournisseur préexistant ne doit pas avoir été touché.
  const fournisseur = await dbGet("SELECT * FROM suppliers WHERE kind = 'fournisseur'");
  assert.equal(fournisseur.name, 'Fournisseur déjà saisi');

  // Les lignes installées doivent être complètes, comme celles de la route POST.
  const carriers = await dbAll("SELECT * FROM suppliers WHERE kind = 'transporteur'");
  assert.ok(carriers.every((row) => row.status === 'actif'), 'les transporteurs installés sont actifs');
  assert.ok(carriers.every((row) => typeof row.created_at === 'string' && row.created_at.length > 0), 'created_at renseigné');
  assert.ok(carriers.every((row) => typeof row.updated_at === 'string' && row.updated_at.length > 0), 'updated_at renseigné');
});

test('un second appel n’insère rien et ne change pas le total', async () => {
  const before = await countCarriers();
  assert.ok(before > 0, 'ce test suppose le catalogue déjà installé');

  const result = await seedCarriersIfEmpty();
  assert.deepEqual(result, { seeded: 0 }, 'le catalogue ne doit pas être réinstallé');
  assert.equal(await countCarriers(), before, 'aucune ligne n’a été ajoutée');
});

test('un transporteur déjà présent bloque l’installation, sans être écrasé', async () => {
  await dbRun('DELETE FROM suppliers');
  await insertSupplier('transporteur', 'Mon transporteur négocié');

  const result = await seedCarriersIfEmpty();
  assert.deepEqual(result, { seeded: 0 });
  assert.equal(await countCarriers(), 1, 'le transporteur personnalisé doit rester seul, intact');

  const row = await dbGet("SELECT * FROM suppliers WHERE kind = 'transporteur'");
  assert.equal(row.name, 'Mon transporteur négocié');
});

/* ===================== ROUTE ===================== */

test('POST /api/suppliers accepte transporteur et la fiche fait l’aller-retour', async () => {
  const { status, body } = await call('/api/suppliers', {
    method: 'POST',
    body: {
      kind: 'transporteur',
      name: '  DHL Express  ',
      siteUrl: 'https://www.dhl.com/fr-fr/home.html',
      marginCoefficient: 1.5,
      notes: '  Express international  ',
    },
  });

  assert.equal(status, 201);
  assert.equal(body.kind, 'transporteur');
  assert.equal(body.name, 'DHL Express', 'le nom est nettoyé des espaces');
  assert.equal(body.site_url, 'https://www.dhl.com/fr-fr/home.html');
  assert.equal(body.margin_coefficient, 1.5);
  assert.equal(body.status, 'actif', 'un transporteur sans statut est actif');
  assert.equal(body.notes, 'Express international');
  assert.ok(body.id > 0);

  const listed = await call('/api/suppliers?kind=transporteur');
  const roundTripped = listed.body.find((s) => s.id === body.id);
  assert.ok(roundTripped, 'la fiche créée doit se retrouver dans la liste filtrée');
  assert.equal(roundTripped.kind, 'transporteur');
  assert.equal(roundTripped.name, 'DHL Express');
});

test('le filtre ?kind=transporteur ne renvoie que des transporteurs', async () => {
  await call('/api/suppliers', { method: 'POST', body: { kind: 'fournisseur', name: 'Alpha Import', marginCoefficient: 2 } });
  await call('/api/suppliers', { method: 'POST', body: { kind: 'distributeur', name: 'Zêta Distribution', marginCoefficient: 2 } });

  const { status, body } = await call('/api/suppliers?kind=transporteur');
  assert.equal(status, 200);
  assert.ok(body.length >= 1, 'il doit y avoir au moins un transporteur créé par le test précédent');
  assert.ok(body.every((s) => s.kind === 'transporteur'), 'aucun fournisseur ni distributeur ne doit fuir dans le filtre');

  const fournisseurs = await call('/api/suppliers?kind=fournisseur');
  assert.ok(fournisseurs.body.every((s) => s.kind === 'fournisseur'));
});

test('un type inconnu reste refusé, et le message liste les trois valeurs', async () => {
  for (const kind of ['grossiste', 'TRANSPORTEUR', '', null]) {
    const { status, body } = await call('/api/suppliers', {
      method: 'POST',
      body: { kind, name: 'Type douteux', marginCoefficient: 2 },
    });
    assert.equal(status, 400, `type « ${String(kind)} »`);
    assert.match(body.error, /Type de partenaire invalide/);
    for (const allowed of ['fournisseur', 'distributeur', 'transporteur']) {
      assert.match(body.error, new RegExp(allowed), `le message doit citer ${allowed}`);
    }
  }
});

test('le filtre refuse aussi un type inconnu au lieu de tout renvoyer', async () => {
  const { status, body } = await call('/api/suppliers?kind=grossiste');
  assert.equal(status, 400);
  assert.match(body.error, /Type de partenaire invalide/);
});
