import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSuggestedPrice,
  convertToEur,
  computeLandedCost,
  computePriceFromSupplier,
} from '../src/importer/pricing.js';

/* Taux de référence pour les tests : les vrais vivent en base (table `currencies`),
   mais ce module est pur — il les reçoit, donc les tests n'ont rien à monter. */
const TAUX = { EUR: 1, USD: 0.92, CNY: 0.13, GBP: 1.17 };

/* La conversion reste volontairement NON arrondie : arrondir un montant
   intermédiaire propagerait l'erreur au coût rendu. C'est donc au test de
   comparer la valeur utile, pas le bit près (10 x 0,92 = 9.200000000000001). */
const arrondi = (v) => Math.round(v * 100) / 100;

/* ===================== DERNIÈRE ÉTAPE (contrat historique) ===================== */

test('applies the margin coefficient and fixed fee', () => {
  const price = computeSuggestedPrice(10, { marginCoefficient: 2, fixedFee: 1 });
  assert.equal(price, 21); // 10*2 + 1
});

test('never goes below landed cost + fixed fee, even with a coefficient near 1', () => {
  const price = computeSuggestedPrice(10, { marginCoefficient: 1.01, fixedFee: 5 });
  assert.equal(price, 15.1);
});

test('rejects a negative landed cost', () => {
  assert.throws(() => computeSuggestedPrice(-5, { marginCoefficient: 1.8 }));
});

test('rejects a margin coefficient of 1 or less', () => {
  assert.throws(() => computeSuggestedPrice(10, { marginCoefficient: 1 }));
});

/* ===================== CONVERSION DE DEVISE ===================== */

test('convertit un prix en dollars vers l’euro', () => {
  // 10 USD x 0,92 = 9,20 EUR
  assert.equal(arrondi(convertToEur(10, 'USD', TAUX)), 9.2);
});

test('l’euro est neutre, et la casse n’a pas d’importance', () => {
  assert.equal(convertToEur(12.5, 'EUR', TAUX), 12.5);
  assert.equal(arrondi(convertToEur(10, 'usd', TAUX)), 9.2);
});

test('REFUSE une devise sans taux au lieu de supposer 1:1', () => {
  // Le défaut corrigé : multiplier des yuans par un coefficient et appeler le
  // résultat des euros. Un prix absent se voit ; un prix faux se vend.
  assert.throws(
    () => convertToEur(100, 'XYZ', TAUX),
    /inconnue/,
  );
  assert.throws(() => convertToEur(100, 'CNY', {}), /inconnue/);
});

test('refuse une devise vide ou un montant non numérique', () => {
  assert.throws(() => convertToEur(10, '', TAUX), /Devise manquante/);
  assert.throws(() => convertToEur(NaN, 'EUR', TAUX), /invalide/);
});

/* ===================== COÛT RENDU ===================== */

test('le coût rendu répartit les frais du lot sur chaque pièce', () => {
  // 500 pièces, 375 EUR de transport et de douane pour le lot
  // -> 10 USD = 9,20 EUR, + 0,75 EUR de frais = 9,95 EUR l'unité
  const cout = computeLandedCost({
    purchasePrice: 10, currency: 'USD', lotQuantity: 500, lotFees: 375, rates: TAUX,
  });
  assert.equal(cout, 9.95);
});

test('sans frais ni devise étrangère, le coût rendu est le prix d’achat', () => {
  assert.equal(computeLandedCost({ purchasePrice: 18.4, currency: 'EUR', rates: TAUX }), 18.4);
});

test('refuse une quantité de lot absurde', () => {
  assert.throws(() => computeLandedCost({ purchasePrice: 10, currency: 'EUR', lotQuantity: 0, rates: TAUX }), /Quantité/);
  assert.throws(() => computeLandedCost({ purchasePrice: 10, currency: 'EUR', lotQuantity: 2.5, rates: TAUX }), /Quantité/);
});

test('refuse des frais négatifs', () => {
  assert.throws(() => computeLandedCost({ purchasePrice: 10, currency: 'EUR', lotFees: -1, rates: TAUX }), /Frais/);
});

/* ===================== CHAÎNE COMPLÈTE ===================== */

test('le cas réel : 3 EUR d’achat, coefficient 6,63 -> 19,90 EUR', () => {
  const { landedCost, suggestedPrice } = computePriceFromSupplier({
    purchasePrice: 3, currency: 'EUR', rates: TAUX, marginCoefficient: 6.6333, fixedFee: 0,
  });
  assert.equal(landedCost, 3);
  assert.equal(suggestedPrice, 19.9);
});

test('le cas Alibaba : 0,75 USD transport compris, marge 1,8', () => {
  // 0,75 USD = 0,69 EUR, + 375/500 = 0,75 EUR de frais -> 1,44 EUR de coût rendu
  const { landedCost, suggestedPrice } = computePriceFromSupplier({
    purchasePrice: 0.75,
    currency: 'USD',
    lotQuantity: 500,
    lotFees: 375,
    rates: TAUX,
    marginCoefficient: 1.8,
    fixedFee: 0,
  });
  assert.equal(landedCost, 1.44);
  assert.equal(suggestedPrice, 2.59);
});

test('le détail du calcul est renvoyé, pour pouvoir justifier le prix plus tard', () => {
  const { detail } = computePriceFromSupplier({
    purchasePrice: 10, currency: 'USD', lotQuantity: 100, lotFees: 50, rates: TAUX,
    marginCoefficient: 2, fixedFee: 0,
  });
  assert.equal(detail.currency, 'USD');
  assert.equal(detail.rate, 0.92, 'le taux employé est conservé');
  assert.equal(detail.priceInEur, 9.2);
  assert.equal(detail.feesPerUnit, 0.5);
  assert.equal(detail.lotQuantity, 100);
});

test('une devise inconnue remonte l’erreur au lieu de rendre un prix', () => {
  assert.throws(
    () => computePriceFromSupplier({
      purchasePrice: 10, currency: 'XYZ', rates: TAUX, marginCoefficient: 1.8,
    }),
    /inconnue/,
  );
});
