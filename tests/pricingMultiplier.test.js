/*
 * Multiplicateur de marge et transport dans le coût rendu.
 *
 * CE QUI EST VERROUILLÉ ICI.
 *
 * 1. Le multiplicateur est un CHOIX COURT (×1,5 à ×5), pas un décimal libre.
 *    Un « coefficient 6.6333 » ne se lit pas ; « ×3 » se comprend.
 *
 * 2. Le transport entre dans le coût rendu — c'est la moitié du prix sur un
 *    petit objet venu de loin, et l'oublier fait vendre à perte.
 *
 * 3. Les deux formes de transport (par pièce / forfait de lot) ne se cumulent
 *    JAMAIS : les additionner compterait le transport deux fois.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-mult-')), 'mult.db');
const ADMIN_KEY = 'cle-de-test-multiplicateur';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { app } = await import('../src/server.js');
const { initDatabase } = await import('../src/db/database.js');
const { computeLandedCost, computePriceFromSupplier } = await import('../src/importer/pricing.js');
const { MULTIPLICATEURS } = await import('../src/services/pricingSettings.js');

const RATES = { EUR: 1, USD: 0.92, CNY: 0.13 };

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

/* ===================== LE TRANSPORT DANS LE CALCUL ===================== */

test('le transport par pièce entre dans le coût rendu', () => {
  // 2,00 € d'achat + 1,20 € de port = 3,20 € de coût rendu.
  const rendu = computeLandedCost({
    purchasePrice: 2,
    currency: 'EUR',
    shippingPrice: 1.2,
    rates: RATES,
  });
  assert.equal(rendu, 3.2);
});

test('le multiplicateur s’applique au coût RENDU, transport compris', () => {
  const { suggestedPrice } = computePriceFromSupplier({
    purchasePrice: 2,
    currency: 'EUR',
    shippingPrice: 1.2,
    rates: RATES,
    marginCoefficient: 3,
    fixedFee: 0,
  });
  // (2,00 + 1,20) × 3 = 9,60 € — et non 2,00 × 3 = 6,00 €.
  assert.equal(suggestedPrice, 9.6);
});

test('le transport est converti dans la devise du prix d’achat', () => {
  const rendu = computeLandedCost({
    purchasePrice: 10,
    currency: 'CNY',
    shippingPrice: 5,
    rates: RATES,
  });
  // (10 + 5) CNY × 0,13 = 1,95 €
  assert.equal(rendu, 1.95);
});

test('transport par pièce et forfait de lot ne se CUMULENT pas', () => {
  // Le piège coûteux : additionner les deux compterait le port deux fois.
  const avecLesDeux = computeLandedCost({
    purchasePrice: 2,
    currency: 'EUR',
    shippingPrice: 1.2,
    lotQuantity: 100,
    lotFees: 500,
    rates: RATES,
  });
  assert.equal(avecLesDeux, 3.2, 'seul le transport par pièce compte quand il est renseigné');
});

test('sans transport par pièce, le forfait de lot reprend la main', () => {
  const rendu = computeLandedCost({
    purchasePrice: 2,
    currency: 'EUR',
    shippingPrice: 0,
    lotQuantity: 100,
    lotFees: 500,
    rates: RATES,
  });
  assert.equal(rendu, 7, '2,00 € + 500/100 = 7,00 €');
});

/* ===================== LE RÉGLAGE ===================== */

test('la liste des multiplicateurs reste courte et lisible', () => {
  // Au-delà de six choix, on ne choisit plus, on hésite.
  assert.ok(MULTIPLICATEURS.length <= 6);
  assert.deepEqual(MULTIPLICATEURS, [1.5, 2, 2.5, 3, 4, 5]);
  for (const m of MULTIPLICATEURS) assert.ok(m > 1, 'un multiplicateur ≤ 1 vendrait à perte');
});

test('GET /api/pricing expose la valeur et les options', async () => {
  const { status, body } = await call('/api/pricing');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.options));
  assert.ok(Number.isFinite(body.multiplicateur));
});

test('PUT /api/pricing enregistre un multiplicateur de la liste', async () => {
  const { status, body } = await call('/api/pricing', { method: 'PUT', body: { multiplicateur: 4 } });
  assert.equal(status, 200);
  assert.equal(body.multiplicateur, 4);

  const relu = await call('/api/pricing');
  assert.equal(relu.body.multiplicateur, 4, 'la valeur doit être persistée');
});

test('PUT /api/pricing REFUSE un décimal hors liste', async () => {
  // C'est le « coefficient 6.6333 » hérité : illisible, et hors du choix proposé.
  const { status, body } = await call('/api/pricing', { method: 'PUT', body: { multiplicateur: 6.6333 } });
  assert.equal(status, 400);
  assert.match(body.error, /invalide/);
  assert.match(body.error, /×1\.5|×2/);
});

test('PUT /api/pricing refuse un multiplicateur ≤ 1 (vente à perte)', async () => {
  const { status } = await call('/api/pricing', { method: 'PUT', body: { multiplicateur: 1 } });
  assert.equal(status, 400);
});
