/*
 * Extraction du POIDS depuis une fiche produit.
 *
 * Le transport se calcule au kilo : sans poids, le hub retombe sur un forfait
 * qui suppose un colis type. Une affiche de 150 g et un meuble de 12 kg n'ont
 * ni le même port, ni le même prix de vente.
 *
 * Ce qui est verrouillé ici :
 *  - les formes réellement écrites (« Poids : 150 g », « Poids net : 0,5 kg ») ;
 *  - les données structurées, où l'unité est certaine (KGM / GRM) ;
 *  - le refus de convertir livres et onces — une conversion approximative
 *    introduirait une erreur qu'aucun test ne verrait venir ;
 *  - le refus d'un « poids » de 500 kg, qui est presque toujours une dimension
 *    ou un prix confondus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractWeightGrams } = await import('../src/importer/scraper.js');

/** Faux jQuery minimal : seul `[itemprop="weight"]` nous intéresse. */
function fauxCheeurio(structured = null) {
  return () => {
    const objet = {
      first: () => objet,
      attr: (nom) => (structured && structured[nom] !== undefined ? structured[nom] : undefined),
      text: () => (structured && structured.texte !== undefined ? structured.texte : ''),
      length: structured ? 1 : 0,
    };
    return objet;
  };
}

const VIDE = fauxCheeurio();

function extraire(texte, structured = null, jsonLd = null) {
  return extractWeightGrams(structured ? fauxCheeurio(structured) : VIDE, texte, jsonLd);
}

/* ===================== LE TEXTE DE LA PAGE ===================== */

test('lit « Poids : 150 g »', () => {
  assert.equal(extraire('Affiche murale. Poids : 150 g'), 150);
});

test('lit « Poids net : 0,5 kg » avec la virgule décimale', () => {
  assert.equal(extraire('Poids net : 0,5 kg'), 500);
});

test('lit « Weight: 1.2kg »', () => {
  assert.equal(extraire('Weight: 1.2kg'), 1200);
});

test('lit « Poids brut 2 kilos »', () => {
  assert.equal(extraire('Poids brut 2 kilos'), 2000);
});

/* ===================== LES DONNÉES STRUCTURÉES ===================== */

test('lit le poids structuré en kilogrammes (KGM)', () => {
  assert.equal(extraire('', null, { weight: { value: 0.5, unitCode: 'KGM' } }), 500);
});

test('lit le poids structuré en grammes (GRM)', () => {
  assert.equal(extraire('', null, { weight: { value: 300, unitCode: 'GRM' } }), 300);
});

test('les données structurées passent avant le texte', () => {
  // Le texte dit 999 g, la structure dit 0,5 kg : la structure est certaine.
  assert.equal(extraire('Poids : 999 g', null, { weight: { value: 0.5, unitCode: 'KGM' } }), 500);
});

/* ===================== LES REFUS ===================== */

test('aucune mention de poids : on ne devine pas', () => {
  assert.equal(extraire('Belle affiche 40 × 60 cm, papier mat.'), null);
});

test('un nombre sans unité ne devient pas un poids', () => {
  // « Poids : 150 » sans unité peut être des grammes, des kilos ou une taille.
  assert.equal(extraire('Poids : 150'), null);
});

test('les livres et les onces ne sont PAS converties', () => {
  // Une conversion approximative serait invisible et fausserait le port.
  assert.equal(extraire('Weight: 1.2 lbs'), null);
  assert.equal(extraire('Poids : 8 oz'), null);
});

test('un « poids » de 500 kg est refusé : c’est une erreur de lecture', () => {
  // Sur une fiche produit, 500 kg est presque toujours une dimension, un prix
  // ou un poids de palette — pas le poids d'un article vendu à l'unité.
  assert.equal(extraire('Poids : 500 kg'), null);
});

test('un poids nul ou négatif est refusé', () => {
  assert.equal(extraire('Poids : 0 g'), null);
});

/* ===================== COHÉRENCE AVEC LE TRANSPORT ===================== */

test('le poids extrait sert directement au calcul du port', async () => {
  // 150 g à 9 €/kg, avec le plancher de 0,5 kg appliqué au colis d'une pièce.
  const { resolveTransport } = await import('../src/importer/pricing.js');
  const poids = extraire('Poids : 150 g');
  assert.equal(poids, 150);

  const t = resolveTransport({
    currency: 'EUR',
    carrierCostEur: (9 * Math.max(poids / 1000, 0.5)),
    rates: { EUR: 1 },
  });
  assert.equal(t.perPieceEur, 4.5, '9 €/kg sur un colis plancher de 0,5 kg');
});
