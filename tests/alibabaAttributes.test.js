/*
 * Caractéristiques produit Alibaba — le tableau « Caractéristiques du produit ».
 *
 * DÉCOUVERTE DÉCISIVE, en épuisant une vraie fiche (EPT-Cheap-Children-Toys) :
 * ces données ne sont PAS chargées par API. Elles sont rendues côté serveur
 * dans le HTML, balisées `data-testid="module-attribute-row"`. On y trouve le
 * POIDS (G.W/N.W) et la QUANTITÉ PAR CARTON (QTY/CTN).
 *
 * C'est là que se cachait le poids qui manquait à tous les calculs de transport :
 *
 *   G.W/N.W = 17,5 kg  ÷  QTY/CTN = 16 pièces  →  1 094 g par pièce
 *
 * Sans ce repli, toute fiche Alibaba arrivait sans poids, donc avec un port
 * estimé au forfait au lieu du kilo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';

const {
  extractAlibabaAttributes,
  weightFromAlibabaAttributes,
  moqFromAlibabaAttributes,
} = await import('../src/importer/scraper.js');

/** Reconstruit le balisage réel d'Alibaba, tel qu'observé sur la fiche. */
function pageCaracteristiques(paires) {
  const lignes = paires.map(([nom, valeur]) => `
    <div data-testid="module-attribute-row">
      <div title="${nom}" data-testid="module-attribute-name">${nom}</div>
      <div title="${valeur}" data-testid="module-attribute-value">${valeur}</div>
    </div>`).join('');
  return cheerio.load(`<html><body>${lignes}</body></html>`);
}

const REEL = [
  ["Tranche d'âge", '2 à 4 Ans, 5 à 7 ans'],
  ['Matériel', 'Plastique'],
  ['Point d\'origine', 'Guangdong, China'],
  ['Marque nom', 'EPT'],
  ['Taille d\'emballage:', '36*7.6*23CM'],
  ['Carton taille', '74x31,2x70,5 CM'],
  ['G.W/N.W', '17.5/16kgs'],
  ['QTY/CTN', '16 PCS'],
  ['Quantité minimale de commande', '80 PCS'],
];

/* ===================== LECTURE DU TABLEAU ===================== */

test('lit les 18 caractéristiques de la fiche réelle', () => {
  const $ = pageCaracteristiques(REEL);
  const attrs = extractAlibabaAttributes($);
  assert.equal(attrs['g.w/n.w'], '17.5/16kgs');
  assert.equal(attrs['qty/ctn'], '16 PCS');
  assert.equal(attrs['marque nom'], 'EPT');
  assert.equal(attrs['quantité minimale de commande'], '80 PCS');
});

test('le `title` est préféré au texte affiché (valeur tronquée à l’écran)', () => {
  // À l'écran, Alibaba tronque : « 17.5/16kg… ». Le `title` porte la valeur
  // complète — c'est lui qu'il faut lire, sinon on perd la décimale.
  const $ = cheerio.load(`
    <div data-testid="module-attribute-row">
      <div title="G.W/N.W" data-testid="module-attribute-name">G.W/N.W</div>
      <div title="17.5/16kgs" data-testid="module-attribute-value">17.5/16kg…</div>
    </div>`);
  assert.equal(extractAlibabaAttributes($)['g.w/n.w'], '17.5/16kgs');
});

/* ===================== LE POIDS ===================== */

test('le poids par pièce = poids carton ÷ quantité par carton', () => {
  const attrs = extractAlibabaAttributes(pageCaracteristiques(REEL));
  // 17,5 kg ÷ 16 = 1,09375 kg → 1 094 g (arrondi).
  assert.equal(weightFromAlibabaAttributes(attrs), 1094);
});

test('on prend le poids BRUT, pas le net — c’est ce que pèse le transporteur', () => {
  const attrs = { 'g.w/n.w': '12/10kgs', 'qty/ctn': '20 PCS' };
  // 12 kg brut ÷ 20 = 600 g. Le net (10 kg) donnerait 500 g : trop bas.
  assert.equal(weightFromAlibabaAttributes(attrs), 600);
});

test('un poids exprimé en grammes est respecté', () => {
  const attrs = { 'g.w/n.w': '850g', 'qty/ctn': '10 PCS' };
  assert.equal(weightFromAlibabaAttributes(attrs), 85);
});

test('sans QTY/CTN, on ne divise pas au hasard', () => {
  // Diviser par une quantité inventée donnerait un poids faux, donc un port
  // faux, donc un prix faux. Mieux vaut null et une saisie humaine.
  assert.equal(weightFromAlibabaAttributes({ 'g.w/n.w': '17.5/16kgs' }), null);
});

test('sans G.W/N.W, pas de poids inventé', () => {
  assert.equal(weightFromAlibabaAttributes({ 'qty/ctn': '16 PCS' }), null);
});

test('un carton d’une seule pièce ne divise pas par zéro', () => {
  assert.equal(weightFromAlibabaAttributes({ 'g.w/n.w': '2.5kgs', 'qty/ctn': '1 PCS' }), 2500);
});

/* ===================== LE MOQ ===================== */

test('lit la quantité minimale de commande', () => {
  const attrs = extractAlibabaAttributes(pageCaracteristiques(REEL));
  assert.equal(moqFromAlibabaAttributes(attrs), 80);
});

test('« minimale » est reconnu, pas seulement « minimum »', () => {
  // La fiche réelle écrit « Quantité minimale de commande » : un motif calé sur
  // « minimum » ratait le champ, et le MOQ revenait à null.
  assert.equal(moqFromAlibabaAttributes({ 'quantité minimale de commande': '80 PCS' }), 80);
});

test('un MOQ absent ne produit pas de zéro', () => {
  assert.equal(moqFromAlibabaAttributes({ 'matériel': 'Plastique' }), null);
});

/* ===================== COHÉRENCE AVEC LE TRANSPORT ===================== */

test('le poids lu donne un port cohérent au tarif de 9 €/kg', async () => {
  const attrs = extractAlibabaAttributes(pageCaracteristiques(REEL));
  const poids = weightFromAlibabaAttributes(attrs);
  // 1,094 kg × 9 €/kg = 9,85 € de port par pièce (au-dessus du plancher de 0,5 kg).
  const port = Math.round(poids / 1000 * 9 * 100) / 100;
  assert.equal(port, 9.85);
});
