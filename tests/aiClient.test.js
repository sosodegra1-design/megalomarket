import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonFromModel } from '../src/ai/client.js';

test('clean JSON is parsed as-is', () => {
  assert.deepEqual(parseJsonFromModel('{"suggestions": []}'), { suggestions: [] });
});

test('a ```json markdown fence is unwrapped', () => {
  const raw = '```json\n{"description": "Un jouet robuste."}\n```';
  assert.deepEqual(parseJsonFromModel(raw), { description: 'Un jouet robuste.' });
});

test('a bare ``` fence is unwrapped too', () => {
  const raw = '```\n{"category": "retard_livraison", "urgency": "haute"}\n```';
  assert.deepEqual(parseJsonFromModel(raw), { category: 'retard_livraison', urgency: 'haute' });
});

test('prose before and after the JSON is ignored', () => {
  const raw = 'Bien sûr ! Voici l\'objet demandé :\n{"amazon": {"title": "Puzzle"}}\nJ\'espère que cela convient.';
  assert.deepEqual(parseJsonFromModel(raw), { amazon: { title: 'Puzzle' } });
});

test('nested objects are extracted whole', () => {
  const raw = '```json\n{"a": {"b": {"c": [1, 2, {"d": true}]}}, "e": "fin"}\n```';
  assert.deepEqual(parseJsonFromModel(raw), { a: { b: { c: [1, 2, { d: true }] } }, e: 'fin' });
});

test('a brace inside a quoted string does not close the object early', () => {
  const raw = '{"rationale": "Le prix {promo} reste au-dessus du coût", "suggestedPrice": 19.9}';
  assert.deepEqual(parseJsonFromModel(raw), {
    rationale: 'Le prix {promo} reste au-dessus du coût',
    suggestedPrice: 19.9,
  });
});

test('an escaped quote inside a string is handled', () => {
  // La prose force le passage par l'extraction équilibrée : le `\"` ne doit pas
  // être pris pour la fin de la chaîne, ni le `{` interne pour une accolade.
  const raw = 'Voici : {"description": "Il a dit \\"super\\" en voyant {ça}", "ok": true} — voilà.';
  assert.deepEqual(parseJsonFromModel(raw), { description: 'Il a dit "super" en voyant {ça}', ok: true });
});

test('a top-level array is extracted', () => {
  const raw = 'Voici la liste :\n[{"channel": "ebay"}, {"channel": "amazon"}]\nVoilà.';
  assert.deepEqual(parseJsonFromModel(raw), [{ channel: 'ebay' }, { channel: 'amazon' }]);
});

test('garbage input throws a clear French error mentioning JSON', () => {
  assert.throws(() => parseJsonFromModel('Désolé, je ne peux pas répondre à cette demande.'), /JSON/);
});

test('a balanced but invalid candidate is rejected rather than parsed loosely', () => {
  assert.throws(() => parseJsonFromModel('Voici {ceci n\'est pas du JSON}.'), /non exploitable/);
});

test('an empty response throws instead of returning undefined', () => {
  assert.throws(() => parseJsonFromModel('   '), /JSON/);
});
