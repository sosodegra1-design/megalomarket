/*
 * Superviseur qualité périodique (src/services/qualitySupervisor.js),
 * planifié toutes les 30 min — relit les photos des fiches déjà PUBLIÉES et
 * ne les relit jamais deux fois (quality_checked_at). Répond au bug réel
 * d'une photo sans rapport (câble USB) publiée sans aucun contrôle.
 *
 * ANTHROPIC_API_KEY volontairement vide : mêmes raisons que
 * importInspectImages.test.js — inspectImages() n'utilise le SDK Anthropic
 * (node-fetch interne, pas global.fetch) que pour l'appel modèle final,
 * jamais atteint ici. Le chemin "clé absente" est un échec de contrôle
 * comme un autre (overallOk:false, message explicite), pas un plantage —
 * exactement ce que ce superviseur doit journaliser sans jamais s'arrêter.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-quality-supervisor-')), 'quality.db');
process.env.ADMIN_API_KEY = 'cle-de-test-quality-supervisor';
process.env.ANTHROPIC_API_KEY = '';

const { initDatabase, dbRun, dbGet, dbAll } = await import('../src/db/database.js');
const { runQualitySupervision } = await import('../src/services/qualitySupervisor.js');

let importCounter = 0;

async function createPublishedListing({ imageUrls = ['https://supplier.example/a.jpg'], checked = false } = {}) {
  importCounter += 1;
  const now = Date.now();
  const importInfo = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'brouillon', ?)`,
    ['https://supplier.example/item.html', 'aliexpress', `Produit ${importCounter}`, 'desc', 9.9, 'USD', JSON.stringify(imageUrls), now],
  );
  const listingInfo = await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, published_external_id, created_at, updated_at, quality_checked_at, quality_ok, quality_issue)
     VALUES (?, 'own_site', ?, 'desc', 19.9, 'publie', 'ext-id', ?, ?, ?, ?, ?)`,
    [importInfo.lastInsertRowid, `Produit ${importCounter}`, now, now, checked ? now : null, checked ? 1 : null, checked ? null : null],
  );
  return listingInfo.lastInsertRowid;
}

async function createUnpublishedListing() {
  importCounter += 1;
  const now = Date.now();
  const importInfo = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'brouillon', ?)`,
    ['https://supplier.example/item.html', 'aliexpress', `Brouillon ${importCounter}`, 'desc', 9.9, 'USD', '[]', now],
  );
  const listingInfo = await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, created_at, updated_at)
     VALUES (?, 'own_site', ?, 'desc', 19.9, 'a_valider', ?, ?)`,
    [importInfo.lastInsertRowid, `Brouillon ${importCounter}`, now, now],
  );
  return listingInfo.lastInsertRowid;
}

before(async () => {
  await initDatabase();
});

beforeEach(async () => {
  await dbRun('DELETE FROM import_listings');
  await dbRun('DELETE FROM imports');
  await dbRun('DELETE FROM activity_log');
});

test('aucune fiche publiée à relire : ne fait rien', async () => {
  await createUnpublishedListing();
  const result = await runQualitySupervision();
  assert.deepEqual(result, { checked: 0, flagged: 0 });
});

test('une fiche publiée jamais relue est contrôlée une fois et marquée', async () => {
  const id = await createPublishedListing({ imageUrls: [] });
  const result = await runQualitySupervision();
  assert.deepEqual(result, { checked: 1, flagged: 1 });

  const row = await dbGet('SELECT quality_checked_at, quality_ok, quality_issue FROM import_listings WHERE id = ?', [id]);
  assert.ok(row.quality_checked_at, 'quality_checked_at doit être renseigné après le passage');
  assert.equal(row.quality_ok, 0);
  assert.match(row.quality_issue, /Aucune image fournie/);

  const logs = await dbAll("SELECT * FROM activity_log WHERE kind = 'CONTROLE_QUALITE_ALERTE'");
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /Aucune image fournie|Produit 1/);
});

test('une fiche déjà relue (quality_checked_at renseigné) est ignorée au tour suivant', async () => {
  await createPublishedListing({ checked: true });
  const result = await runQualitySupervision();
  assert.deepEqual(result, { checked: 0, flagged: 0 });
});

test('une fiche non publiée (a_valider) n\'est jamais contrôlée', async () => {
  await createUnpublishedListing();
  const result = await runQualitySupervision();
  assert.deepEqual(result, { checked: 0, flagged: 0 });
});

test('le lot est borné (BATCH_LIMIT = 5) même avec davantage de fiches à relire', async () => {
  for (let i = 0; i < 8; i += 1) {
    await createPublishedListing({ imageUrls: [] });
  }
  const result = await runQualitySupervision();
  assert.equal(result.checked, 5, 'un seul cycle ne doit pas tout traiter d\'un coup');

  const remaining = await dbAll('SELECT id FROM import_listings WHERE quality_checked_at IS NULL');
  assert.equal(remaining.length, 3, 'les fiches restantes attendent le prochain cycle');
});

test('des photos valides sans ANTHROPIC_API_KEY sont signalées avec le message explicite (pas de faux positif silencieux)', async () => {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://supplier.example/')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
    return original(url, options);
  };
  let result;
  try {
    await createPublishedListing({ imageUrls: ['https://supplier.example/photo.jpg'] });
    result = await runQualitySupervision();
  } finally {
    global.fetch = original;
  }
  assert.equal(result.checked, 1);
  assert.equal(result.flagged, 1);
  const row = await dbGet('SELECT quality_issue FROM import_listings LIMIT 1');
  assert.match(row.quality_issue, /ANTHROPIC_API_KEY/);
});

after(async () => {
  await dbRun('DELETE FROM import_listings');
  await dbRun('DELETE FROM imports');
});
