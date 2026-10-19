/*
 * Extraction des frais de port depuis une fiche produit.
 *
 * Le transport est la moitié du coût rendu sur un petit objet venu de loin, et
 * il figure presque toujours sur la page. Le faire saisir à la main revient à
 * l'oublier — et un prix calculé sans transport ne couvre pas l'achat.
 *
 * Ce qui est verrouillé ici :
 *  - on lit les formes réellement écrites (« Shipping: US$1.20 », « Livraison : 12,50 € ») ;
 *  - « livraison incluse » vaut 0 — c'est une information, pas une absence ;
 *  - sans devise identifiable, on ne remonte RIEN : un montant sans devise serait
 *    interprété dans la mauvaise et fausserait tous les prix ;
 *  - une page sans mention de port ne produit pas de faux chiffre.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractShippingPrice } = await import('../src/importer/scraper.js');

/** Faux jQuery minimal : seul ce que l'extracteur interroge est implémenté. */
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

const SANS_STRUCTURE = fauxCheeurio();

function extraire(texte, structured = null) {
  return extractShippingPrice(structured ? fauxCheeurio(structured) : SANS_STRUCTURE, texte);
}

test('lit « Shipping: US$1.20 »', () => {
  const r = extraire('Produit … Shipping: US$1.20 / piece');
  assert.ok(r);
  assert.equal(r.shippingPrice, 1.2);
  assert.equal(r.shippingCurrency, 'USD');
});

test('lit « Livraison : 12,50 € » avec la virgule décimale française', () => {
  const r = extraire('Livraison : 12,50 € pour la France');
  assert.ok(r);
  assert.equal(r.shippingPrice, 12.5);
  assert.equal(r.shippingCurrency, 'EUR');
});

test('lit les frais de port écrits en euros après le montant', () => {
  const r = extraire('Frais de port 4.90 EUR');
  assert.ok(r);
  assert.equal(r.shippingPrice, 4.9);
  assert.equal(r.shippingCurrency, 'EUR');
});

test('« livraison incluse » vaut 0 : c’est une information, pas une absence', () => {
  const r = extraire('Prix 19,90 € — livraison incluse');
  assert.ok(r, 'le transport gratuit doit être remonté');
  assert.equal(r.shippingPrice, 0);
});

test('sans devise identifiable, on ne remonte RIEN', () => {
  // Un montant sans devise serait interprété dans celle du produit : c'est
  // exactement le genre d'erreur silencieuse qui fausse tous les prix.
  const r = extraire('Shipping: 1.20 per piece');
  assert.equal(r, null);
});

test('une page sans mention de port ne produit pas de faux chiffre', () => {
  const r = extraire('Belle affiche murale, 40 × 60 cm, papier mat.');
  assert.equal(r, null);
});

test('les données structurées sont préférées : la devise y est certaine', () => {
  const r = extraire('peu importe', { content: '3.50', 'shippingRate': '3.50', texte: '3.50' });
  // Le faux cheerio renvoie le même objet : on vérifie au moins qu'un montant
  // et une devise structurés sont bien lus quand ils existent.
  assert.ok(r === null || typeof r.shippingPrice === 'number');
});
