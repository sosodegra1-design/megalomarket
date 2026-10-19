/*
 * « Si la page ne donne pas le port, c'est à nous de le calculer avec nos
 * transporteurs. »
 *
 * L'ORDRE EST LA RÈGLE, et il est verrouillé ici :
 *   1. ce que dit la FICHE fournisseur ;
 *   2. sinon le TRANSPORTEUR du hub (son forfait divisé par la quantité du lot) ;
 *   3. sinon le FORFAIT DE LOT des imports plus anciens ;
 *   4. sinon 0 — et l'absence est SIGNALÉE, jamais silencieuse.
 *
 * Deux erreurs coûteraient cher et sont testées :
 *  - cumuler deux origines (le port serait compté deux fois) ;
 *  - laisser un 0 silencieux, qui fait croire à une livraison gratuite.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-transport-')), 'transport.db');

const { initDatabase, dbRun } = await import('../src/db/database.js');
const { resolveTransport, computePriceFromSupplier } = await import('../src/importer/pricing.js');
const { carrierCostForImport } = await import('../src/services/transport.js');

const RATES = { EUR: 1, USD: 0.92, CNY: 0.13 };

before(async () => {
  await initDatabase();
  // Deux transporteurs : un sans tarif, un tarifé.
  await dbRun(
    "INSERT INTO suppliers (kind, name, shipping_cost, shipping_days, status, created_at, updated_at) VALUES ('transporteur', 'Sans tarif', NULL, NULL, 'actif', ?, ?)",
    [new Date().toISOString(), new Date().toISOString()],
  );
  await dbRun(
    "INSERT INTO suppliers (kind, name, shipping_cost, shipping_days, status, created_at, updated_at) VALUES ('transporteur', 'Colissimo', 12, 3, 'actif', ?, ?)",
    [new Date().toISOString(), new Date().toISOString()],
  );
});

/* ===================== L'ORDRE DES ORIGINES ===================== */

test('la fiche fournisseur passe avant tout le reste', () => {
  const t = resolveTransport({
    currency: 'EUR',
    shippingPrice: 1.2,
    carrierCostEur: 8,
    lotFees: 500,
    lotQuantity: 100,
    rates: RATES,
  });
  assert.equal(t.source, 'fiche');
  assert.equal(t.perPieceEur, 1.2);
});

test('sans indication sur la fiche, le transporteur prend le relais', () => {
  const t = resolveTransport({
    currency: 'EUR',
    shippingPrice: 0,
    carrierCostEur: 8,
    lotFees: 500,
    lotQuantity: 100,
    rates: RATES,
  });
  assert.equal(t.source, 'transporteur');
  assert.equal(t.perPieceEur, 8);
});

test('sans transporteur tarifé, le forfait de lot reprend la main', () => {
  const t = resolveTransport({
    currency: 'EUR',
    shippingPrice: 0,
    carrierCostEur: 0,
    lotFees: 500,
    lotQuantity: 100,
    rates: RATES,
  });
  assert.equal(t.source, 'lot');
  assert.equal(t.perPieceEur, 5);
});

test('sans rien du tout, la source est « aucun » — jamais un silence', () => {
  const t = resolveTransport({ currency: 'EUR', rates: RATES });
  assert.equal(t.source, 'aucun');
  assert.equal(t.perPieceEur, 0);
});

test('les origines ne se CUMULENT jamais', () => {
  // 1,20 + 8 + 5 ferait 14,20 : le port serait compté trois fois.
  const t = resolveTransport({
    currency: 'EUR',
    shippingPrice: 1.2,
    carrierCostEur: 8,
    lotFees: 500,
    lotQuantity: 100,
    rates: RATES,
  });
  assert.equal(t.perPieceEur, 1.2, 'une seule origine est retenue');
});

test('le port de la fiche est converti dans la devise du produit', () => {
  const t = resolveTransport({ currency: 'CNY', shippingPrice: 10, rates: RATES });
  assert.equal(t.perPieceEur, 1.3, '10 CNY × 0,13');
});

/* ===================== LE TRANSPORTEUR DU HUB ===================== */

test('le forfait du transporteur est réparti sur la quantité du lot', async () => {
  // Colissimo : 12 € l'envoi. Un lot de 100 pièces → 0,12 € par pièce.
  const r = await carrierCostForImport({ carrier_id: null, lot_quantity: 100 });
  assert.equal(r.carrierCostEur, 0.12);
  assert.equal(r.carrierName, 'Colissimo');
  assert.equal(r.implicite, true, 'choisi par défaut, pas par l’utilisateur');
});

test('un lot de 1 pièce supporte le forfait entier', async () => {
  const r = await carrierCostForImport({ carrier_id: null, lot_quantity: 1 });
  assert.equal(r.carrierCostEur, 12);
});

test('un transporteur explicitement choisi est préféré au défaut', async () => {
  const choisi = await import('../src/db/database.js').then(({ dbGet }) => dbGet(
    "SELECT id FROM suppliers WHERE name = 'Sans tarif'",
  ));
  const r = await carrierCostForImport({ carrier_id: choisi.id, lot_quantity: 10 });
  // Ce transporteur n'a pas de tarif : on le dit, au lieu de retomber en silence
  // sur un autre transporteur et de faire croire à un choix respecté.
  assert.equal(r.carrierCostEur, 0);
  assert.match(r.raison, /Sans tarif/);
});

test('aucun transporteur tarifé : la raison est explicite', async () => {
  // On vide les tarifs pour éprouver le cas où l'utilisateur n'a rien saisi.
  await dbRun("UPDATE suppliers SET shipping_cost = NULL WHERE kind = 'transporteur'");
  const r = await carrierCostForImport({ carrier_id: null, lot_quantity: 1 });
  assert.equal(r.carrierCostEur, 0);
  assert.match(r.raison, /Aucun transporteur ne porte de tarif/);
  assert.match(r.raison, /Transporteurs/, 'la raison doit dire où corriger');
});

/* ===================== BOUT EN BOUT ===================== */

test('sans port sur la fiche, le prix inclut le transporteur', () => {
  // 5 EUR d'achat + 12 EUR de transporteur (lot de 1) = 17 EUR de coût rendu.
  const { landedCost, suggestedPrice } = computePriceFromSupplier({
    purchasePrice: 5,
    currency: 'EUR',
    shippingPrice: 0,
    carrierCostEur: 12,
    rates: RATES,
    marginCoefficient: 3,
    fixedFee: 0,
  });
  assert.equal(landedCost, 17);
  assert.equal(suggestedPrice, 51, '×3 sur le coût rendu, transport compris');
});

test('le détail dit d’où vient le transport, pour pouvoir le justifier', () => {
  const { detail } = computePriceFromSupplier({
    purchasePrice: 5,
    currency: 'EUR',
    carrierCostEur: 12,
    rates: RATES,
    marginCoefficient: 3,
  });
  assert.equal(detail.transportSource, 'transporteur');
  assert.equal(detail.transportEur, 12);
});
