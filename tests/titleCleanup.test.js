/*
 * Nettoyage du titre produit.
 *
 * Constaté en épuisant une vraie fiche Alibaba : le titre importé finissait par
 * « - Buy  Product on Alibaba.com ». Ce n'est pas le nom du produit, c'est du
 * remplissage SEO — et il partait tel quel dans l'annonce publiée sur Amazon,
 * TikTok ou le site propre.
 *
 * Deux conséquences concrètes : le titre annonce à tout le monde d'où vient la
 * marchandise, et il mange des caractères utiles dans une limite de 80.
 *
 * Ce qui est verrouillé ici :
 *  - les suffixes de plateforme connus sont retirés ;
 *  - un titre légitime qui CONTIENT « on Alibaba.com » au milieu est intact ;
 *  - un nettoyage qui viderait le titre est annulé (mieux vaut l'original).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { cleanProductTitle } = await import('../src/importer/scraper.js');

test('retire le suffixe « Buy … on Alibaba.com »', () => {
  const brut = 'Jouets Pour Enfants Pas Chers Ept 2023,Pistolet À Bulles - Buy  Product on Alibaba.com';
  assert.equal(cleanProductTitle(brut), 'Jouets Pour Enfants Pas Chers Ept 2023,Pistolet À Bulles');
});

test('retire le suffixe « | AliExpress »', () => {
  assert.equal(cleanProductTitle('Affiche murale pop art | AliExpress'), 'Affiche murale pop art');
});

test('retire le suffixe « - Alibaba.com »', () => {
  assert.equal(cleanProductTitle('Lampe LED - Alibaba.com'), 'Lampe LED');
});

test('retire le suffixe « - Made-in-China.com »', () => {
  assert.equal(cleanProductTitle('Brosse bambou - Made-in-China.com'), 'Brosse bambou');
});

test('un titre déjà propre n’est pas touché', () => {
  assert.equal(cleanProductTitle('Peluche renard'), 'Peluche renard');
});

test('un titre qui PARLE d’Alibaba au milieu reste intact', () => {
  // Le nettoyage ne doit viser que les suffixes, pas le contenu.
  const titre = 'Coffret de thés commandé on Alibaba.com pour Noël';
  assert.equal(cleanProductTitle(titre), titre);
});

test('un nettoyage qui viderait le titre est annulé', () => {
  // Mieux vaut un titre imparfait qu'un titre vide : un import sans titre est
  // inutilisable pour générer une annonce.
  // La fonction retire les espaces de bord : c'est « - Alibaba.com » qui revient.
  assert.equal(cleanProductTitle(' - Alibaba.com'), '- Alibaba.com');
});

test('un titre vide reste vide, sans lever', () => {
  assert.equal(cleanProductTitle(''), '');
  assert.equal(cleanProductTitle(null), '');
});
