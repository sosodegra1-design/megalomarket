/*
 * L'AGENT QUI COMPLÈTE UNE FICHE INCOMPLÈTE.
 *
 * Constat en production : la veste de pluie est entrée avec son prix mais SANS
 * photo ni poids. Sans photo le site refuse de publier ; sans poids le port est
 * facturé au forfait de 28 €, ce qui triple le prix.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-healer-')), 'healer.db');

const { initDatabase, dbRun, dbGet } = await import('../src/db/database.js');
const { manquesImport, repairImport } = await import('../src/services/importHealer.js');

before(async () => {
  await initDatabase();
});

test('ce qui manque est nommé, dans l’ordre où ça bloque', () => {
  assert.deepEqual(manquesImport({}, []), ['photos', 'poids', 'MOQ']);
  assert.deepEqual(manquesImport({ weight_g: 100 }, []), ['photos', 'MOQ']);
  assert.deepEqual(manquesImport({}, ['a.jpg']), ['poids', 'MOQ']);
  assert.deepEqual(manquesImport({ weight_g: 100, moq: 10 }, ['a.jpg']), []);
});

test('une fiche complète n’est pas retouchée', async () => {
  await dbRun(
    "INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, weight_g, moq, status, created_at) VALUES ('https://x.test/complet', 'alibaba', 'Complet', '', 5, 'EUR', ?, 100, 10, 'pret', ?)",
    [JSON.stringify(['https://exemple.test/a.jpg']), Date.now()],
  );
  const imp = await dbGet("SELECT id FROM imports WHERE title = 'Complet'");
  const r = await repairImport(imp.id);
  assert.equal(r.complet, true);
  assert.deepEqual(r.remplis, [], 'on ne réécrit pas une donnée déjà là');
});

test('sans lien fournisseur, l’agent le dit au lieu de deviner', async () => {
  await dbRun(
    "INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at) VALUES ('', 'manuel', 'Sans lien', '', 5, 'EUR', '[]', 'pret', ?)",
    [Date.now()],
  );
  const imp = await dbGet("SELECT id FROM imports WHERE title = 'Sans lien'");
  const r = await repairImport(imp.id);
  assert.equal(r.complet, false);
  assert.match(r.raison, /aucun lien fournisseur/);
  assert.deepEqual(r.restants, ['photos', 'poids', 'MOQ']);
});

test('un import introuvable lève, plutôt que de renvoyer un faux rapport', async () => {
  await assert.rejects(() => repairImport(999999), /introuvable/);
});
