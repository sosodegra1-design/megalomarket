/*
 * API du tableau des devises.
 *
 * Le taux de change n'est pas une vérité technique : c'est une donnée
 * commerciale qui vieillit, et que le propriétaire doit pouvoir corriger sans
 * redéployer. Ces tests verrouillent les deux propriétés qui comptent : le taux
 * se corrige, et un taux absurde est refusé (un taux nul ou négatif rendrait
 * tous les prix incalculables, ou négatifs).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-devises-')), 'devises.db');
const ADMIN_KEY = 'cle-de-test-devises';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase, dbGet } = await import('../src/db/database.js');

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

/* ===================== LECTURE ===================== */

test('le tableau des devises est installé avec le schéma, et nomme les pays', async () => {
  const { status, body } = await call('/api/currencies');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 30, 'au moins une trentaine de devises');

  const chine = body.find((c) => c.code === 'CNY');
  assert.ok(chine, 'le yuan doit être présent');
  // Le pays et le nom en clair : « Chine — Yuan chinois » se reconnaît, « CNY » non.
  assert.equal(chine.country, 'Chine');
  assert.equal(chine.name, 'Yuan chinois');
  assert.ok(chine.rate_to_eur > 0);

  const euro = body.find((c) => c.code === 'EUR');
  assert.equal(euro.rate_to_eur, 1, "l'euro vaut 1 euro, par définition");
});

test('le tri suit le PAYS, pas le code', async () => {
  const { body } = await call('/api/currencies');
  const pays = body.map((c) => c.country);
  // Comparaison par unités de code, comme le `COLLATE NOCASE` de SQLite : celui-ci
  // ne replie que l'ASCII A-Z, donc « Émirats » passe APRÈS « Zone euro ». Un tri
  // français avec `localeCompare` placerait « Émirats » en tête et ferait échouer
  // ce test à tort.
  const commeSqlite = [...pays].sort((a, b) => {
    const x = a.toUpperCase(); const y = b.toUpperCase();
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  });
  assert.deepEqual(pays, commeSqlite, 'trier par code obligerait à connaître les sigles');
  assert.equal(pays[0], 'Afrique du Sud', 'le premier pays est bien le premier alphabétiquement');
});

/* ===================== CORRECTION DU TAUX ===================== */

test('corriger un taux le persiste et le journalise', async () => {
  const avant = (await call('/api/currencies')).body.find((c) => c.code === 'USD');
  const nouveau = avant.rate_to_eur === 0.95 ? 0.93 : 0.95;

  const { status, body } = await call('/api/currencies/USD', {
    method: 'PATCH',
    body: { rateToEur: nouveau },
  });
  assert.equal(status, 200);
  assert.equal(body.rate_to_eur, nouveau);

  const enBase = await dbGet('SELECT rate_to_eur FROM currencies WHERE code = ?', ['USD']);
  assert.equal(enBase.rate_to_eur, nouveau, 'le taux est bien écrit en base');

  const journal = await dbGet("SELECT message FROM activity_log WHERE kind = 'DEVISE' ORDER BY id DESC LIMIT 1");
  assert.match(journal.message, /USD/);
  assert.match(journal.message, new RegExp(String(nouveau)));
});

test('la casse du code est indifférente', async () => {
  const { status, body } = await call('/api/currencies/usd', { method: 'PATCH', body: { rateToEur: 0.92 } });
  assert.equal(status, 200);
  assert.equal(body.code, 'USD');
});

test('un taux nul, négatif ou absurde est refusé', async () => {
  for (const mauvais of [0, -1, null]) {
    const { status, body } = await call('/api/currencies/USD', { method: 'PATCH', body: { rateToEur: mauvais } });
    assert.equal(status, 400, `taux « ${mauvais} » doit être refusé`);
    assert.match(String(body.error), /Taux invalide/);
  }
  // Une chaîne part par un autre refus, plus précis : c'est le corps entier qui
  // est mal formé, pas seulement la valeur.
  const texte = await call('/api/currencies/USD', { method: 'PATCH', body: { rateToEur: 'abc' } });
  assert.equal(texte.status, 400);
  assert.match(String(texte.body.error), /pas une chaîne/);
});

test('une chaîne numérique est refusée : le corps doit porter un nombre', async () => {
  // « 0.95 » est une chaîne : l'accepter ouvrirait la porte à « 1 234,56 » ou à
  // une valeur vidée par un champ mal lu.
  const { status, body } = await call('/api/currencies/USD', { method: 'PATCH', body: { rateToEur: '0.95' } });
  assert.equal(status, 400);
  assert.match(String(body.error), /nombre, pas une chaîne/);
});

test('une devise inconnue est signalée clairement', async () => {
  const { status, body } = await call('/api/currencies/ZZZ', { method: 'PATCH', body: { rateToEur: 1 } });
  assert.equal(status, 400);
  assert.match(String(body.error), /inconnue/i);
});

/* ===================== AJOUT ===================== */

test('une devise absente du catalogue peut être ajoutée', async () => {
  const { status, body } = await call('/api/currencies', {
    method: 'POST',
    body: { code: 'ISK', country: 'Islande', name: 'Couronne islandaise', rateToEur: 0.0066 },
  });
  assert.equal(status, 201);
  assert.equal(body.code, 'ISK');
  assert.equal(body.country, 'Islande');

  // Elle est désormais utilisable pour convertir un prix.
  const relu = await call('/api/currencies');
  assert.ok(relu.body.some((c) => c.code === 'ISK'));
});

test('recréer une devise existante est refusé, sans l’écraser', async () => {
  const avant = await dbGet('SELECT rate_to_eur FROM currencies WHERE code = ?', ['EUR']);
  const { status, body } = await call('/api/currencies', {
    method: 'POST',
    body: { code: 'EUR', country: 'Ailleurs', name: 'Faux euro', rateToEur: 2 },
  });
  assert.equal(status, 400);
  assert.match(String(body.error), /existe déjà/);

  const apres = await dbGet('SELECT rate_to_eur FROM currencies WHERE code = ?', ['EUR']);
  assert.equal(apres.rate_to_eur, avant.rate_to_eur, 'la devise existante est intacte');
});

test('un code mal formé est refusé', async () => {
  for (const mauvais of ['EU', 'EURO', '', '12A']) {
    const { status } = await call('/api/currencies', {
      method: 'POST',
      body: { code: mauvais, country: 'X', name: 'Y', rateToEur: 1 },
    });
    assert.equal(status, 400, `le code « ${mauvais} » doit être refusé`);
  }
});

/* ===================== SÉCURITÉ ===================== */

test('le tableau des devises est derrière la clé, comme le reste du back-office', async () => {
  const response = await fetch(base + '/api/currencies');
  assert.equal(response.status, 401);
});
