/*
 * Interface : une fiche lue par un agent web doit se voir.
 *
 * Quand Alibaba refuse le scraping, la fiche est désormais LUE par l'agent
 * Perplexity (voir importer/aiReader.js). Une lecture par agent peut se tromper
 * de variante ou de devise, et cette erreur se propagerait dans le prix de vente
 * conseillé puis dans les annonces publiées.
 *
 * Le serveur stocke donc `extraction_method = 'agent'` et la preuve de lecture.
 * Ces tests verrouillent le fait que l'interface l'AFFICHE — un marqueur stocké
 * mais jamais montré ne protégerait personne — et qu'elle continue de traiter
 * une fiche scrapée normalement.
 *
 * Le script réel est exécuté dans un DOM minimal, comme tests/importManualUi.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-agent-ui-')), 'ui.db');

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

/* ===================== PRÉSENCE DANS LE MARKUP ===================== */

test('le bloc d’avertissement existe et précède le prix', () => {
  assert.ok(HTML.includes('id="importExtractionWarning"'), 'le conteneur doit exister');
  // L'ordre compte : la cause (lecture par agent) doit être lue AVANT le prix
  // qu'elle rend douteux, sinon l'avertissement arrive trop tard.
  const warning = HTML.indexOf('id="importExtractionWarning"');
  const price = HTML.indexOf('id="importPriceWarning"');
  assert.ok(warning > 0 && warning < price, 'l’avertissement de lecture doit précéder celui du prix');
});

test('la liste des imports marque les fiches lues par IA', () => {
  // Marqueur visible sans ouvrir la fiche : `extraction_method` est renvoyé par
  // SELECT * sur GET /api/imports.
  assert.match(HTML, /extraction_method === 'agent'/);
  assert.match(HTML, /lue par IA/);
});

test('renderImportPrice déclenche l’avertissement : les deux chemins d’affichage sont couverts', () => {
  // renderImportPrice est appelé après extraction ET après rechargement depuis
  // /api/imports/:id ; le brancher ici évite d'oublier l'un des deux.
  const render = HTML.slice(HTML.indexOf('function renderImportPrice'));
  const body = render.slice(0, render.indexOf('\n}'));
  assert.match(body, /renderExtractionWarning\(data\)/);
});

/* ===================== COMPORTEMENT ===================== */

test('une fiche lue par un agent affiche l’avertissement et la preuve de lecture', () => {
  const { sandbox, node } = loadDashboard();
  // Forme renvoyée par POST /api/imports (camelCase).
  sandbox.renderExtractionWarning({
    extractionMethod: 'agent',
    agentNotes: 'Prix tel qu’affiché : « US$3.85 / piece, min. order 100 pieces ».',
  });

  const el = node('importExtractionWarning');
  assert.equal(el.hidden, false, 'l’avertissement doit être visible');
  assert.match(el.innerHTML, /lue par un agent web/);
  assert.match(el.innerHTML, /avant de publier/);
  assert.match(el.innerHTML, /US\$3\.85/, 'la preuve de lecture doit être affichée');
});

test('une fiche rechargée depuis la base (colonnes SQL) affiche le même avertissement', () => {
  const { sandbox, node } = loadDashboard();
  // Forme renvoyée par GET /api/imports/:id : colonnes SQL, pas camelCase.
  sandbox.renderExtractionWarning({
    extraction_method: 'agent',
    extraction_notes: 'Type de page vu par l’agent : fiche produit.',
  });

  const el = node('importExtractionWarning');
  assert.equal(el.hidden, false);
  assert.match(el.innerHTML, /fiche produit/);
});

test('une fiche scrapée n’affiche AUCUN avertissement', () => {
  const { sandbox, node } = loadDashboard();
  const el = node('importExtractionWarning');

  sandbox.renderExtractionWarning({ extractionMethod: 'scrape', agentNotes: 'peu importe' });
  assert.equal(el.hidden, true);
  assert.equal(el.innerHTML, '');

  // Absence de marqueur = fiche historique, donc scrapée : pas d'alerte à tort.
  sandbox.renderExtractionWarning({ extraction_method: undefined, extraction_notes: null });
  assert.equal(el.hidden, true);
});

test('les notes de l’agent ne peuvent jamais devenir du HTML', () => {
  const { sandbox, node } = loadDashboard();
  sandbox.renderExtractionWarning({
    extractionMethod: 'agent',
    agentNotes: '<img src=x onerror="alert(1)">Prix : 3.85',
  });
  const html = node('importExtractionWarning').innerHTML;
  assert.ok(!html.includes('<img'), 'la balise ne doit pas être injectée telle quelle');
  assert.match(html, /&lt;img/);
  assert.match(html, /Prix : 3\.85/, 'le texte utile reste lisible');
});

test('le rendu du prix utilise le marqueur pour décider d’avertir', () => {
  const { sandbox, node } = loadDashboard();
  sandbox.renderImportPrice({
    extractionMethod: 'agent',
    purchasePrice: 3.85,
    currency: 'USD',
    agentNotes: 'Prix tel qu’affiché : « US$3.85 ».',
  });
  assert.equal(node('importExtractionWarning').hidden, false);
  assert.equal(node('importPrice').value, '3.85');

  sandbox.renderImportPrice({ extractionMethod: 'scrape', purchasePrice: 9.9, currency: 'EUR' });
  assert.equal(node('importExtractionWarning').hidden, true, 'un scrape ne doit pas alerter');
});
