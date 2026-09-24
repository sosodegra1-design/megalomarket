/* Bug production : un lien produit "bijoux.html?product=p2" renvoyait
 * "Cannot GET /bijoux.html" — la page réelle est "bijoux-accessoires.html".
 * categoryPageFile() est la seule source de vérité pour ce rapprochement,
 * utilisée par routes/orders.js et routes/site.js pour construire un lien
 * produit vers le site.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryPageFile } from '../src/utils/siteCategoryPages.js';

test('bijoux maps to the real bijoux-accessoires.html page', () => {
  assert.equal(categoryPageFile('bijoux'), 'bijoux-accessoires.html');
});

test('a category whose value already matches its filename passes through unchanged', () => {
  for (const category of ['jouets', 'vetements', 'destockage', 'electronique', 'maison', 'beaute', 'sport', 'box']) {
    assert.equal(categoryPageFile(category), `${category}.html`);
  }
});
