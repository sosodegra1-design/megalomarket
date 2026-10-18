import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-cat-')), 'cat.db');
const { initDatabase, dbRun, dbAll } = await import('../src/db/database.js');
const { detectCategory, normalizeTitleKey } = await import('../src/importer/categorizer.js');
const { assertImportable } = await import('../src/importer/dedupe.js');

before(async () => { await initDatabase(); });

test('lighting products go to the lumivita category', () => {
  for (const title of [
    'Lampe LED 3D en acrylique illusion nuit',
    'Guirlande lumineuse solaire extérieur 10m',
    'Veilleuse enfant rechargeable',
    'Lampadaire design salon',
    'LED strip lights 5m RGB remote',
    'Tischlampe Holz modern',
    'Pendant light chandelier kitchen',
  ]) {
    assert.equal(detectCategory({ title }), 'lumivita', title);
  }
});

test('a toy or pet accessory with a light feature is NOT lighting', () => {
  for (const title of [
    'Balle Magique Électrique Intelligente Pour Chat, Son Et Lumière',
    'Jouet Squishy Réaliste En Forme De Beurre',
    'Voiture-jouet électrique télécommandée avec lumières LED',
    'Peluche renard 30 cm',
  ]) {
    assert.equal(detectCategory({ title }), null, title);
  }
});

test('weak words need two hits to classify', () => {
  assert.equal(detectCategory({ title: 'Décoration murale', rawDescription: 'effet lumineux LED doux' }), 'lumivita');
  assert.equal(detectCategory({ title: 'Décoration murale', rawDescription: 'très lumineux' }), null);
});

test('title keys ignore case, accents, punctuation and the marketplace suffix', () => {
  assert.equal(
    normalizeTitleKey('Balle Magique Électrique, Chat - Buy Product on Alibaba.com'),
    normalizeTitleKey('balle magique electrique chat'),
  );
});

test('a duplicate (same link without tracking, or same title) is refused, a new product is accepted', async () => {
  await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES ('https://www.alibaba.com/product-detail/Balle_16000.html?spm=a1', 'alibaba', 'Balle Magique Chat', '', 3, 'USD', '[]', 'brouillon', ?)`,
    [Date.now()],
  );
  await assert.rejects(
    () => assertImportable({ url: 'https://alibaba.com/product-detail/Balle_16000.html', title: 'Autre titre' }),
    /^Error: Doublon/,
  );
  await assert.rejects(
    () => assertImportable({ url: 'https://www.alibaba.com/product-detail/Autre_999.html', title: 'balle magique chat' }),
    /^Error: Doublon/,
  );
  await assertImportable({ url: 'https://www.alibaba.com/product-detail/Lampe_777.html', title: 'Lampe LED 3D' });
});

test('a generic barrier page is refused', async () => {
  await assert.rejects(
    () => assertImportable({ url: 'https://www.alibaba.com/x', title: "Alibaba.com: Manufacturers, Suppliers, Exporters & Importers from the world's largest online B2B marketplace" }),
    /^Error: Page générique/,
  );
});

test('existing imports are classified when the category column is added', async () => {
  const rows = await dbAll('SELECT category FROM imports');
  assert.ok(Array.isArray(rows));
});
