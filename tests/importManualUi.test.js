/*
 * Tableau de bord : la saisie manuelle d'un import, promesse tenue.
 *
 * L'ancien message d'échec disait « remplis la fiche manuellement » alors que
 * l'interface n'offrait aucun moyen de créer un import sans scraper. Ces tests
 * verrouillent les points d'entrée ajoutés (bouton permanent, formulaire,
 * endpoint), l'action proposée DANS l'erreur, et la construction du corps
 * envoyé à POST /api/imports/manual.
 *
 * Le script réel est exécuté dans un DOM minimal, comme tests/importPriceUi.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-manual-ui-')), 'ui.db');

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
    querySelector() { return null; },
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

/* ===================== POINTS D'ENTRÉE ===================== */

test('la saisie manuelle est une option PERMANENTE, pas seulement après un échec', () => {
  for (const id of [
    'btnManualImport', 'manualImportBlock', 'manualImportUrl', 'manualImportTitle',
    'manualImportPrice', 'manualImportCurrency', 'manualImportDescription',
    'manualImportImages', 'btnCreateManualImport', 'btnCancelManualImport',
  ]) {
    assert.ok(HTML.includes(`id="${id}"`), `le tableau de bord doit garder #${id}`);
  }
  assert.match(HTML, /Saisir la fiche à la main/);
  // Le endpoint dédié, sans extraction.
  assert.match(HTML, /\/api\/imports\/manual/);
  // Le bouton permanent vit HORS du bloc caché : il est visible avant tout échec.
  const buttonIndex = HTML.indexOf('id="btnManualImport"');
  const blockIndex = HTML.indexOf('id="manualImportBlock"');
  assert.ok(buttonIndex > 0 && buttonIndex < blockIndex, 'le bouton doit précéder le formulaire caché');
});

test('l’échec d’extraction offre l’action « Saisir la fiche à la main », pré-remplie avec l’URL', () => {
  // Le message de l'API est mis en avant et l'action est proposée juste en
  // dessous : c'est ce que l'ancien message promettait sans pouvoir le tenir.
  assert.match(HTML, /offerInlineErrorAction\('Saisir la fiche à la main', \(\) => openManualImportForm\(url\)\)/);
});

/* ===================== FORMULAIRE ===================== */

test('ouvrir le formulaire pré-remplit l’URL déjà tapée et affiche le bloc', () => {
  const { sandbox, node } = loadDashboard();
  node('manualImportBlock').style.display = 'none';

  sandbox.openManualImportForm('https://www.alibaba.com/product/123.html');

  assert.equal(node('manualImportBlock').style.display, 'block');
  assert.equal(node('manualImportUrl').value, 'https://www.alibaba.com/product/123.html');
  assert.equal(node('manualImportCurrency').value, 'USD', 'une devise par défaut évite un refus pour un oubli');

  sandbox.closeManualImportForm();
  assert.equal(node('manualImportBlock').style.display, 'none');
});

test('l’erreur inline rend l’action fournie par offerInlineErrorAction', () => {
  const { sandbox, node } = loadDashboard();
  let clicked = false;
  sandbox.offerInlineErrorAction('Saisir la fiche à la main', () => { clicked = true; });
  sandbox.say('Extraction impossible', 'err');

  assert.match(node('status').innerHTML, /Extraction impossible/);
  assert.match(node('status').innerHTML, /Saisir la fiche à la main/);
  assert.match(node('status').innerHTML, /data-inline-action/);
  // L'action reste consommable côté DOM réel (ici le stub ne rend pas le bouton,
  // on vérifie seulement que la mémorisation ne fuit pas d'un appel à l'autre).
  sandbox.say('Deuxième erreur', 'err');
  assert.ok(!node('status').innerHTML.includes('Saisir la fiche à la main'), 'l’action ne doit pas réapparaître seule');
  void clicked;
});

/* ===================== CORPS ENVOYÉ ===================== */

test('manualImportPayload construit le corps attendu par l’API', () => {
  const { sandbox, node } = loadDashboard();
  node('manualImportTitle').value = 'Blendeur extracteur de jus';
  node('manualImportPrice').value = '9.90';
  node('manualImportCurrency').value = 'eur';
  node('manualImportUrl').value = 'https://www.alibaba.com/product/123.html';
  node('manualImportDescription').value = 'Un blendeur puissant.';
  node('manualImportImages').value = 'https://cdn.example/1.jpg\n\n  https://cdn.example/2.jpg  \n';
  node('importSupplier').value = '';

  // L'objet vient d'un autre realm (vm) : on le normalise avant comparaison.
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.manualImportPayload())), {
    title: 'Blendeur extracteur de jus',
    purchasePrice: 9.9,
    currency: 'eur',
    url: 'https://www.alibaba.com/product/123.html',
    rawDescription: 'Un blendeur puissant.',
    imageUrls: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
  });
});

test('manualImportPayload omet l’URL vide et refuse titre, prix et devise invalides', () => {
  const { sandbox, node } = loadDashboard();
  node('manualImportTitle').value = 'Produit';
  node('manualImportPrice').value = '5';
  node('manualImportCurrency').value = 'EUR';
  node('manualImportUrl').value = '   ';
  assert.ok(!('url' in sandbox.manualImportPayload()), 'une URL vide ne doit pas partir');

  node('manualImportTitle').value = '';
  assert.throws(() => sandbox.manualImportPayload(), /titre/i);
  node('manualImportTitle').value = 'Produit';

  for (const price of ['0', '-1', '', 'abc']) {
    node('manualImportPrice').value = price;
    assert.throws(() => sandbox.manualImportPayload(), /Prix d'achat invalide/, `prix « ${price} »`);
  }
  node('manualImportPrice').value = '5';

  node('manualImportCurrency').value = 'DOLLARS';
  assert.throws(() => sandbox.manualImportPayload(), /Devise invalide/);
});
