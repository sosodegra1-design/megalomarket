/*
 * LE DÉNICHEUR NE PROPOSE QUE DU CHINOIS BON MARCHÉ.
 *
 * Le prompt demandait l'INVERSE : « privilégie des pistes européennes plutôt
 * qu'asiatiques ». Les lots produits partaient donc chez des fabricants
 * portugais ou polonais, sans rapport avec la façon dont l'utilisateur
 * s'approvisionne — Alibaba, 1688, AliExpress.
 *
 * Deux garde-fous : la consigne, et un CONTRÔLE qui marque à revoir toute piste
 * sourcée ailleurs. Un prompt n'est pas une garantie — les modèles dérivent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ai/nicheHunter.js', import.meta.url), 'utf8');
const { sourcingChinois } = await import('../src/ai/nicheHunter.js');

test('la consigne impose une plateforme chinoise', () => {
  assert.match(source, /OBLIGATOIREMENT une plateforme chinoise/);
  assert.match(source, /Alibaba/);
  assert.match(source, /1688/);
  assert.match(source, /AliExpress/);
});

test('la consigne européenne a disparu', () => {
  // C'était la règle précédente, exactement à l'opposé de la demande.
  assert.ok(
    !/Privilégie des pistes européennes/.test(source),
    'l’ancienne consigne ne doit plus guider la chasse',
  );
});

test('le bon marché à l’achat est un critère explicite', () => {
  assert.match(source, /BON MARCH[EÉ] À L'ACHAT/);
  assert.match(source, /inférieur à 5 €/);
});

test('le contrôle reconnaît les plateformes chinoises', () => {
  assert.equal(sourcingChinois('Alibaba — fabricant de gadgets'), true);
  assert.equal(sourcingChinois('1688 — usine de textiles'), true);
  assert.equal(sourcingChinois('AliExpress — accessoires'), true);
  assert.equal(sourcingChinois('Taobao'), true);
  assert.equal(sourcingChinois('Made-in-China'), true);
});

test('le contrôle rejette les autres origines', () => {
  assert.equal(sourcingChinois('fabricant textile au Portugal'), false);
  assert.equal(sourcingChinois('grossiste déco en Pologne'), false);
  assert.equal(sourcingChinois('fabricant français'), false);
  assert.equal(sourcingChinois(''), false);
  assert.equal(sourcingChinois(null), false);
  assert.equal(sourcingChinois(undefined), false);
});

test('une piste non chinoise est enregistrée mais marquée à revoir', () => {
  // Elle n'est pas supprimée : l'utilisateur doit pouvoir la voir et comprendre
  // pourquoi elle est écartée. Elle n'est simplement pas « validée ».
  assert.match(source, /review_issue/);
  assert.match(source, /sourcing non chinois/);
});
