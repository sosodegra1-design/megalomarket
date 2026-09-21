/*
 * Tableau de bord : rendre le prix d'achat visible et corrigeable.
 *
 * Un import dont le prix d'achat n'a pas été lu générait des fiches à 0 € sans
 * que rien ne l'explique, et sans moyen de corriger l'import. Ces tests
 * verrouillent les contrôles ajoutés et — surtout — l'identité du message entre
 * l'API et le tableau de bord : deux textes divergents reproduiraient le
 * problème d'origine (l'utilisateur ne comprend pas pourquoi publier échoue).
 *
 * Le script réel est exécuté dans un DOM minimal, comme tests/dashboard.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-price-ui-')), 'ui.db');

const { MISSING_PURCHASE_PRICE_WARNING } = await import('../src/importer/listingGenerator.js');

const HTML = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');

function element(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    title: '',
    value: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
    append() {},
    addEventListener() {},
    querySelectorAll() { return []; },
  };
}

function loadDashboard() {
  const nodes = new Map();
  const document = {
    readyState: 'loading',
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, element(id));
      return nodes.get(id);
    },
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: (tag) => element(tag),
    createTextNode: (text) => ({ text }),
  };
  const sandbox = {
    document,
    window: { confirm: () => true, prompt: () => null },
    fetch: () => { throw new Error('aucun appel réseau ne doit partir pendant ce test'); },
    console,
    URL,
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, sandbox, { filename: 'index.html' });
  return { sandbox, node: (id) => document.getElementById(id) };
}

test('l’import expose un prix d’achat et une devise modifiables', () => {
  for (const id of ['importPriceBlock', 'importPriceWarning', 'importPrice', 'importCurrency', 'btnSavePurchasePrice']) {
    assert.ok(HTML.includes(`id="${id}"`), `le tableau de bord doit garder #${id}`);
  }
  assert.match(HTML, /Enregistrer le prix d'achat/);
  // Le bouton corrige l'import lui-même, pas seulement une fiche.
  assert.match(HTML, /method: 'PATCH'/);
  assert.match(HTML, /\/api\/imports\/' \+ encodeURIComponent\(state\.importId\)/);
});

test('le message du tableau de bord est mot pour mot celui de l’API', () => {
  assert.ok(
    HTML.includes(MISSING_PURCHASE_PRICE_WARNING),
    'le tableau de bord doit reprendre exactement MISSING_PURCHASE_PRICE_WARNING',
  );
});

test('un prix à 0 affiche l’avertissement ; un prix réel le fait disparaître', () => {
  const { sandbox, node } = loadDashboard();

  sandbox.renderImportPrice({ purchase_price: 0, currency: 'USD' });
  assert.equal(node('importPriceBlock').style.display, 'block');
  assert.equal(node('importPriceWarning').hidden, false);
  assert.match(node('importPriceWarning').innerHTML, /PATCH \/api\/imports\/:id/);
  assert.equal(node('importPrice').value, '', 'un prix nul ne doit pas être présenté comme une valeur');
  assert.equal(node('importCurrency').value, 'USD');

  sandbox.renderImportPrice({ purchase_price: 12.5, currency: 'eur' });
  assert.equal(node('importPriceWarning').hidden, true, 'pas d’avertissement quand le prix est renseigné');
  assert.equal(node('importPriceWarning').innerHTML, '');
  assert.equal(node('importPrice').value, '12.5');
  assert.equal(node('importCurrency').value, 'eur');
});

test('la réponse camelCase de l’extraction est rendue comme la réponse SQL', () => {
  const { sandbox, node } = loadDashboard();
  // POST /api/imports renvoie purchasePrice ; GET /api/imports/:id renvoie
  // purchase_price. Le rendu doit accepter les deux, sinon le prix n'apparaît
  // qu'après un rechargement.
  sandbox.renderImportPrice({ purchasePrice: 4.9, currency: 'USD' });
  assert.equal(node('importPrice').value, '4.9');
  assert.equal(node('importPriceWarning').hidden, true);
});
