/* La fiche destinée au site propre est la seule dont le format est contraint
 * par des listes fermées appartenant à la boutique. C'est ici qu'est garantie
 * la règle « une catégorie ou une icône inventée par l'IA casse les filtres du
 * site » — sans dépendre d'un appel réseau ni d'une clé API.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateSitePayload } = await import('../src/importer/listingGenerator.js');

const taxonomy = {
  categories: ['jouets', 'vetements', 'bijoux'],
  universes: ['bebe', 'educatif', 'enfant'],
  iconKeys: ['camion', 'puzzle', 'collier'],
};

const valid = {
  category: 'jouets',
  universe: 'educatif',
  age: '3-5',
  ageLabel: '3-5 ans',
  ageLabel_en: '3-5 years',
  name: 'Puzzle en bois',
  name_en: 'Wooden puzzle',
  description: 'Un puzzle en bois massif.',
  description_en: 'A solid wood puzzle.',
  iconKey: 'puzzle',
};

test('a complete, in-taxonomy sheet is accepted', () => {
  const cleaned = validateSitePayload(valid, taxonomy);
  assert.equal(cleaned.category, 'jouets');
  assert.equal(cleaned.iconKey, 'puzzle');
  assert.equal(cleaned.name_en, 'Wooden puzzle');
  assert.equal(cleaned.universe, 'educatif');
});

test('a category the site filters could never reach is rejected', () => {
  assert.throws(
    () => validateSitePayload({ ...valid, category: 'drones' }, taxonomy),
    /Catégorie "drones" inconnue du site/,
  );
});

test('an icon key outside the site library is rejected', () => {
  // The icon is injected through innerHTML on the storefront: anything not in
  // the library is either a blank illustration or a stored-XSS attempt.
  assert.throws(
    () => validateSitePayload({ ...valid, iconKey: 'licorne' }, taxonomy),
    /absente de la bibliothèque du site/,
  );
  assert.throws(
    () => validateSitePayload({ ...valid, iconKey: '<svg onload="alert(1)">' }, taxonomy),
    /absente de la bibliothèque du site/,
  );
});

test('an universe outside the closed list is rejected', () => {
  assert.throws(
    () => validateSitePayload({ ...valid, universe: 'cosmos' }, taxonomy),
    /Univers "cosmos" inconnu/,
  );
});

test('a null universe is allowed, matching the existing catalog', () => {
  // Some of the 58 existing products have universe: null.
  assert.equal(validateSitePayload({ ...valid, universe: null }, taxonomy).universe, null);
  assert.equal(validateSitePayload({ ...valid, universe: undefined }, taxonomy).universe, null);
});

test('any missing required field is reported by name', () => {
  for (const field of ['category', 'age', 'ageLabel', 'ageLabel_en', 'name', 'name_en', 'iconKey']) {
    const payload = { ...valid };
    delete payload[field];
    assert.throws(() => validateSitePayload(payload, taxonomy), new RegExp(`"${field}" manquant`), `champ ${field}`);
  }
});

test('a blank required field is treated as missing', () => {
  assert.throws(() => validateSitePayload({ ...valid, name: '   ' }, taxonomy), /"name" manquant/);
});

test('the storefront defaults are supplied when optional fields are absent', () => {
  const cleaned = validateSitePayload(valid, taxonomy);
  // js/script.js reads rows[0] of sizeGuide and colors[0] for the swatch, so
  // neither may be left empty.
  assert.deepEqual(cleaned.sizeGuide[0], ['Caractéristique', 'Valeur']);
  assert.deepEqual(cleaned.sizeGuide_en[0], ['Feature', 'Value']);
  assert.deepEqual(cleaned.colors, ['#ffffff']);
  assert.equal(cleaned.ecoDetails, '');
  assert.equal(cleaned.safety_en, '');
});

test('an empty or malformed size guide falls back instead of reaching the site', () => {
  assert.deepEqual(validateSitePayload({ ...valid, sizeGuide: [] }, taxonomy).sizeGuide[0], ['Caractéristique', 'Valeur']);
  assert.deepEqual(validateSitePayload({ ...valid, sizeGuide: 'nope' }, taxonomy).sizeGuide[0], ['Caractéristique', 'Valeur']);
  assert.deepEqual(validateSitePayload({ ...valid, sizeGuide: ['not-a-row'] }, taxonomy).sizeGuide[0], ['Caractéristique', 'Valeur']);
});

test('an invalid colour is dropped rather than sent to the site', () => {
  const cleaned = validateSitePayload({ ...valid, colors: ['#a8e6cf', 'red', 'javascript:alert(1)'] }, taxonomy);
  assert.deepEqual(cleaned.colors, ['#a8e6cf']);
  assert.deepEqual(validateSitePayload({ ...valid, colors: ['red'] }, taxonomy).colors, ['#ffffff']);
});

test('text is trimmed and unknown keys are dropped', () => {
  const cleaned = validateSitePayload({ ...valid, name: '  Puzzle  ', id: 'p99', price: 1, evil: 'x' }, taxonomy);
  assert.equal(cleaned.name, 'Puzzle');
  assert.equal(cleaned.id, undefined, 'the site assigns ids itself');
  assert.equal(cleaned.price, undefined, 'the price comes from the validated listing');
  assert.equal(cleaned.evil, undefined);
});
