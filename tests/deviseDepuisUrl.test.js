/*
 * LA DEVISE SE DÉDUIT DU LIEN.
 *
 * Le défaut constaté : un produit Alibaba saisi à la main partait en EUR. Le
 * fournisseur affichait 9,99 USD, l'écran lisait 9,99 € — environ 7,7 fois le
 * vrai coût. Toute la chaîne de prix (coût rendu, coefficient, prix conseillé)
 * héritait de l'erreur sans que rien ne la signale.
 *
 * La valeur déduite est une ESTIMATION : `source` dit d'où elle vient, pour que
 * l'écran puisse l'expliquer au lieu de l'imposer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { devisePourUrl } = await import('../src/importer/currencyHint.js');

test('Alibaba publie en USD pour l’export, pas en euros', () => {
  const r = devisePourUrl('https://www.alibaba.com/product-detail/EPT-Cheap-Children-Toys_1600981629488.html');
  assert.equal(r.devise, 'USD');
  assert.equal(r.source, 'domaine');
  assert.match(r.pourquoi, /USD/);
});

test('le marché intérieur chinois est en yuans', () => {
  assert.equal(devisePourUrl('https://detail.1688.com/offer/123.html').devise, 'CNY');
  assert.equal(devisePourUrl('https://item.taobao.com/item.htm?id=1').devise, 'CNY');
});

test('une boutique française est en euros, par son extension', () => {
  const r = devisePourUrl('https://monkeymum.fr/collections/barrieres-de-lit');
  assert.equal(r.devise, 'EUR');
  assert.equal(r.source, 'pays');
});

test('Amazon change de devise selon le pays', () => {
  assert.equal(devisePourUrl('https://www.amazon.fr/dp/B08XYZ').devise, 'EUR');
  assert.equal(devisePourUrl('https://www.amazon.com/dp/B08XYZ').devise, 'USD');
  assert.equal(devisePourUrl('https://www.amazon.co.uk/dp/B08XYZ').devise, 'GBP');
});

test('AliExpress facture dans la devise de l’acheteur : EUR par défaut', () => {
  assert.equal(devisePourUrl('https://www.aliexpress.com/item/1005001234567.html').devise, 'EUR');
});

test('un domaine inconnu retombe sur USD, et le dit', () => {
  const r = devisePourUrl('https://boutique-inconnue.xyz/produit');
  assert.equal(r.devise, 'USD');
  assert.equal(r.source, 'defaut');
  assert.match(r.pourquoi, /international/);
});

test('une URL absente ne fabrique aucune devise', () => {
  assert.equal(devisePourUrl('').devise, null);
  assert.equal(devisePourUrl(null).devise, null);
  assert.equal(devisePourUrl(undefined).devise, null);
});

test('une URL illisible ne fait pas planter', () => {
  const r = devisePourUrl('pas une url du tout :::');
  assert.equal(r.devise, null);
  assert.equal(r.source, 'aucune');
});

test('une URL sans schéma est traitée comme une URL', () => {
  assert.equal(devisePourUrl('www.alibaba.com/product-detail/x_1.html').devise, 'USD');
});

test('le sous-domaine national d’Amazon n’est pas confondu avec .com', () => {
  // amazon.fr et amazon.com partagent la racine : le test du domaine doit être
  // ancré, sinon amazon.fr tomberait dans la règle .com.
  assert.equal(devisePourUrl('https://amazon.fr/dp/X').devise, 'EUR');
  assert.equal(devisePourUrl('https://www.amazon.fr/dp/X').devise, 'EUR');
});
