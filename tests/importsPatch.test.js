/*
 * PATCH /api/imports/:id — correction d'un import après extraction.
 *
 * Un import dont le prix d'achat n'a pas été lu (page fournisseur sans données
 * structurées) partait avec `purchase_price = 0`, et RIEN ne permettait de le
 * corriger : les fiches générées restaient à 0 € pour toujours. Ces tests
 * verrouillent la route qui répare la donnée source, ainsi que ses refus — le
 * plus important étant le refus de 0, puisque c'est le symptôme à corriger.
 *
 * Aucun réseau : le serveur Express est écouté sur un port éphémère, et les
 * imports sont insérés directement en base.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-imports-patch-')), 'imports.db');
const ADMIN_KEY = 'cle-de-test-imports-patch';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbGet } = await import('../src/db/database.js');

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

/** Import « cassé » de référence : prix d'achat à 0, exactement le bug à réparer. */
async function createImport({ purchasePrice = 0, currency = 'USD' } = {}) {
  const info = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'brouillon', ?)`,
    [
      'https://supplier.example/item/1.html',
      'aliexpress',
      'Peluche renard 30cm',
      'Une douce peluche pour enfants',
      purchasePrice,
      currency,
      JSON.stringify(['https://supplier.example/img1.jpg', 'https://supplier.example/img2.jpg']),
      Date.now(),
    ],
  );
  return info.lastInsertRowid;
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

/* ===================== CAS NOMINAL ===================== */

test('a valid purchase price is persisted and the full import detail is returned', async () => {
  const id = await createImport();

  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { purchasePrice: 12.5, currency: 'eur' },
  });

  assert.equal(status, 200);
  // Même forme que GET /api/imports/:id : la ligne, les images parsées et les
  // fiches — le tableau de bord traite les deux réponses sans distinction.
  assert.equal(body.id, id);
  assert.equal(body.purchase_price, 12.5);
  assert.equal(body.currency, 'EUR', 'la devise est normalisée en majuscules');
  assert.deepEqual(body.imageUrls, [
    'https://supplier.example/img1.jpg',
    'https://supplier.example/img2.jpg',
  ]);
  assert.ok(Array.isArray(body.listings));

  const stored = await dbGet('SELECT purchase_price, currency FROM imports WHERE id = ?', [id]);
  assert.equal(stored.purchase_price, 12.5, 'la correction doit survivre à la requête');
  assert.equal(stored.currency, 'EUR');
});

test('the price is rounded-trip corrected without touching the untouched fields', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { purchasePrice: 7.25 },
  });
  assert.equal(status, 200);
  assert.equal(body.purchase_price, 7.25);
  assert.equal(body.title, 'Peluche renard 30cm', 'un PATCH partiel ne doit rien effacer');
  assert.equal(body.raw_description, 'Une douce peluche pour enfants');
  assert.equal(body.currency, 'USD');
});

test('title and rawDescription accept non-empty strings', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { title: 'Peluche renard corrigée', rawDescription: 'Description corrigée' },
  });
  assert.equal(status, 200);
  assert.equal(body.title, 'Peluche renard corrigée');
  assert.equal(body.raw_description, 'Description corrigée');
});

/* ===================== REFUS DU PRIX D'ACHAT ===================== */

test('price 0 is refused: it is the very symptom being fixed', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { purchasePrice: 0 },
  });
  assert.equal(status, 400);
  assert.match(body.error, /Prix d'achat invalide/);
  assert.match(body.error, /supérieur à 0/);

  // La base reste intacte : un refus ne doit rien écrire à moitié.
  const stored = await dbGet('SELECT purchase_price FROM imports WHERE id = ?', [id]);
  assert.equal(stored.purchase_price, 0);
});

test('a negative price is refused', async () => {
  const id = await createImport();
  for (const purchasePrice of [-1, -0.01]) {
    const { status, body } = await call(`/api/imports/${id}`, {
      method: 'PATCH',
      body: { purchasePrice },
    });
    assert.equal(status, 400, `prix ${purchasePrice}`);
    assert.match(body.error, /Prix d'achat invalide/);
  }
});

test('a non-number (or non-finite) price is refused rather than coerced', async () => {
  const id = await createImport();
  for (const purchasePrice of ['12.5', null, true, 'abc', Infinity, NaN]) {
    const { status } = await call(`/api/imports/${id}`, {
      method: 'PATCH',
      // JSON.stringify transforme Infinity/NaN en null : les deux cas restent
      // donc refusés, ce que le test vérifie.
      body: { purchasePrice },
    });
    assert.equal(status, 400, `prix ${String(purchasePrice)}`);
  }
});

/* ===================== REFUS DE LA DEVISE ===================== */

test('a currency that is not a 3-letter code is refused', async () => {
  const id = await createImport();
  for (const currency of ['DOLLARS', 'US', '12', '', '   ', 'US$', 'eu ro']) {
    const { status, body } = await call(`/api/imports/${id}`, {
      method: 'PATCH',
      body: { currency },
    });
    assert.equal(status, 400, `devise « ${currency} »`);
    assert.match(body.error, /Devise invalide/);
  }
});

test('a valid currency is uppercased', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { currency: 'gbp' },
  });
  assert.equal(status, 200);
  assert.equal(body.currency, 'GBP');
});

/* ===================== CORPS SANS CHAMP EXPLOITABLE ===================== */

test('an empty body is refused with a clear message', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, { method: 'PATCH', body: {} });
  assert.equal(status, 400);
  assert.match(body.error, /Aucune modification fournie/);
});

test('unknown fields alone are ignored, which leaves nothing to update', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { status: 'pret', source_url: 'https://evil.example', randomField: 123 },
  });
  assert.equal(status, 400);
  assert.match(body.error, /Aucune modification fournie/);
});

test('unknown fields are ignored when a valid field is present', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { purchasePrice: 9, status: 'pret', source_url: 'https://evil.example' },
  });
  assert.equal(status, 200);
  assert.equal(body.purchase_price, 9);
  assert.equal(body.status, 'brouillon', 'un champ inconnu ne doit jamais être appliqué');
  assert.equal(body.source_url, 'https://supplier.example/item/1.html');
});

/* ===================== IMPORT INEXISTANT ===================== */

test('an unknown import is reported clearly, not silently created', async () => {
  const { status, body } = await call('/api/imports/999999', {
    method: 'PATCH',
    body: { purchasePrice: 10 },
  });
  assert.equal(status, 400);
  assert.match(body.error, /introuvable/i);
});

/* ===================== PHOTOS (imageUrls) ===================== */

test('imageUrls replaces the extracted photo list, in the order given', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { imageUrls: ['https://supplier.example/img2.jpg', 'https://manual.example/added.jpg'] },
  });
  assert.equal(status, 200);
  assert.deepEqual(body.imageUrls, [
    'https://supplier.example/img2.jpg',
    'https://manual.example/added.jpg',
  ]);
});

test('imageUrls can be emptied entirely (every photo removed)', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, { method: 'PATCH', body: { imageUrls: [] } });
  assert.equal(status, 200);
  assert.deepEqual(body.imageUrls, []);
});

test('a non-array imageUrls is refused', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, { method: 'PATCH', body: { imageUrls: 'not-an-array' } });
  assert.equal(status, 400);
  assert.match(body.error, /tableau/);
});

test('a malformed image URL is refused before anything is saved', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { imageUrls: ['https://ok.example/a.jpg', 'pas-une-url'] },
  });
  assert.equal(status, 400);
  assert.match(body.error, /imageUrls\[1\]/);

  const stored = await dbGet('SELECT image_urls FROM imports WHERE id = ?', [id]);
  assert.deepEqual(
    JSON.parse(stored.image_urls),
    ['https://supplier.example/img1.jpg', 'https://supplier.example/img2.jpg'],
    'refused write must not partially apply',
  );
});

test('a non-http(s) image URL is refused', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { imageUrls: ['ftp://supplier.example/a.jpg'] },
  });
  assert.equal(status, 400);
  assert.match(body.error, /http et https/);
});

test('more than 30 images is refused', async () => {
  const id = await createImport();
  const imageUrls = Array.from({ length: 31 }, (_, i) => `https://supplier.example/img${i}.jpg`);
  const { status, body } = await call(`/api/imports/${id}`, { method: 'PATCH', body: { imageUrls } });
  assert.equal(status, 400);
  assert.match(body.error, /30 photos maximum/);
});

/* ===================== COÛT RENDU : LOT ET FRAIS ===================== */

test('la quantité du lot et les frais totaux se saisissent sur l’import', async () => {
  const id = await createImport({ purchasePrice: 0.75 });
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { lotQuantity: 500, lotFees: 375 },
  });
  assert.equal(status, 200);
  assert.equal(body.lot_quantity, 500);
  assert.equal(body.lot_fees, 375);

  // Les deux valeurs sont bien persistées : ce sont elles qui alimentent le
  // calcul du coût rendu, donc une valeur perdue fausserait tous les prix.
  const enBase = await dbGet('SELECT lot_quantity, lot_fees FROM imports WHERE id = ?', [id]);
  assert.equal(enBase.lot_quantity, 500);
  assert.equal(enBase.lot_fees, 375);
});

test('une quantité de lot absurde est refusée', async () => {
  const id = await createImport();
  for (const mauvaise of [0, -3, 2.5, 'beaucoup']) {
    const { status, body } = await call(`/api/imports/${id}`, {
      method: 'PATCH',
      body: { lotQuantity: mauvaise },
    });
    assert.equal(status, 400, `quantité « ${mauvaise} » doit être refusée`);
    assert.match(body.error, /Quantité du lot invalide/);
  }
});

test('des frais de lot négatifs sont refusés', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, {
    method: 'PATCH',
    body: { lotFees: -10 },
  });
  assert.equal(status, 400);
  assert.match(body.error, /Frais du lot invalides/);
});

test('omettre la quantité laisse la valeur en base intacte', async () => {
  // Un PATCH partiel ne doit jamais remettre un champ à zéro par omission :
  // corriger la devise ne doit pas effacer la quantité du lot.
  const id = await createImport({ purchasePrice: 0.75 });
  await call(`/api/imports/${id}`, { method: 'PATCH', body: { lotQuantity: 500, lotFees: 375 } });
  await call(`/api/imports/${id}`, { method: 'PATCH', body: { currency: 'EUR' } });

  const enBase = await dbGet('SELECT lot_quantity, lot_fees FROM imports WHERE id = ?', [id]);
  assert.equal(enBase.lot_quantity, 500, 'la quantité est conservée');
  assert.equal(enBase.lot_fees, 375, 'les frais sont conservés');
});

/* ===================== LE PRIX SE PROPAGE AUX FICHES ===================== */

test('corriger le prix d’achat recalcule le prix des fiches DÉJÀ générées', async () => {
  // Le défaut signalé : on corrigeait le prix, les fiches gardaient l'ancien —
  // et on publiait l'ancien sans que rien ne le dise.
  const id = await createImport({ purchasePrice: 2 });
  await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, created_at, updated_at)
     VALUES (?, 'amazon', 'Fiche déjà générée', 'Texte inchangé', 0.01, 'a_valider', ?, ?)`,
    [id, Date.now(), Date.now()],
  );

  const { status } = await call(`/api/imports/${id}`, { method: 'PATCH', body: { purchasePrice: 4 } });
  assert.equal(status, 200);

  const apres = await dbGet('SELECT suggested_price FROM import_listings WHERE import_id = ?', [id]);
  assert.ok(apres.suggested_price > 0.01, 'le prix obsolète a bien été remplacé');
});

test('doubler le prix d’achat double le prix conseillé des fiches', async () => {
  // Propriété indépendante du taux et du coefficient : elle prouve que le
  // recalcul a eu lieu, sans dépendre de valeurs qui changent avec la config.
  const id = await createImport({ purchasePrice: 2 });
  await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, created_at, updated_at)
     VALUES (?, 'amazon', 'Fiche', 'Texte', 0, 'a_valider', ?, ?)`,
    [id, Date.now(), Date.now()],
  );

  await call(`/api/imports/${id}`, { method: 'PATCH', body: { purchasePrice: 4 } });
  const premier = (await dbGet('SELECT suggested_price FROM import_listings WHERE import_id = ?', [id])).suggested_price;

  await call(`/api/imports/${id}`, { method: 'PATCH', body: { purchasePrice: 8 } });
  const second = (await dbGet('SELECT suggested_price FROM import_listings WHERE import_id = ?', [id])).suggested_price;

  /* Tolérance d'un centime : le coût rendu est arrondi au centime À CHAQUE
     étape, donc 4 x 0,92 x 1,8 et 8 x 0,92 x 1,8 ne sont pas exactement dans un
     rapport de 2 (6,62 contre 13,25). Exiger l'égalité au centime testerait
     l'arrondi, pas la propagation du prix. */
  assert.ok(
    Math.abs(second - premier * 2) <= 0.02,
    `le prix doit doubler : ${premier} -> ${second}`,
  );
});

test('le texte des fiches n’est PAS touché par un simple changement de prix', async () => {
  // Recalculer n'est pas régénérer : aucune IA n'est appelée, les descriptions
  // écrites restent valables.
  const id = await createImport({ purchasePrice: 2 });
  await dbRun(
    `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, created_at, updated_at)
     VALUES (?, 'amazon', 'Titre écrit par l’IA', 'Description écrite par l’IA', 1, 'a_valider', ?, ?)`,
    [id, Date.now(), Date.now()],
  );

  await call(`/api/imports/${id}`, { method: 'PATCH', body: { purchasePrice: 5 } });

  const fiche = await dbGet('SELECT title, description FROM import_listings WHERE import_id = ?', [id]);
  assert.equal(fiche.title, 'Titre écrit par l’IA');
  assert.equal(fiche.description, 'Description écrite par l’IA');
});

/* ===================== DEVISE : LA FAUTE DE FRAPPE ===================== */

test('une devise absente du tableau est refusée, avec la bonne suggestion', async () => {
  // « YCN » au lieu de « CNY » : trois lettres valides, mais aucun taux — donc
  // un prix incalculable. Le refus doit nommer la faute probable.
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, { method: 'PATCH', body: { currency: 'YCN' } });
  assert.equal(status, 400);
  assert.match(body.error, /inconnue/);
  assert.match(body.error, /CNY/, 'la suggestion doit apparaître');
});

test('une devise réellement inconnue est refusée SANS suggestion inventée', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, { method: 'PATCH', body: { currency: 'XYZ' } });
  assert.equal(status, 400);
  assert.match(body.error, /inconnue/);
  assert.ok(!/Voulais-tu dire/.test(body.error), 'aucune suggestion quand aucune ne s’impose');
});

test('une devise du tableau est acceptée, en minuscules comme en majuscules', async () => {
  const id = await createImport();
  const { status, body } = await call(`/api/imports/${id}`, { method: 'PATCH', body: { currency: 'cny' } });
  assert.equal(status, 200);
  assert.equal(body.currency, 'CNY');
});
