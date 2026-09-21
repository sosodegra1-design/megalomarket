/*
 * Tableau de bord : le registre des partenaires et la liste de l'import.
 *
 * Ces tests exécutent le script réel dans un DOM minimal, comme
 * tests/dashboard.test.js. Ils verrouillent ce qui compte ici : une vue
 * « Fournisseurs » atteignable, une liste d'import pré-remplie qui envoie bien
 * `supplierId`, et l'échappement de tout ce qui vient de l'API — un nom de
 * partenaire est du HTML potentiel, exactement comme un nom de produit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

test('une vue Fournisseurs existe, avec sa table et son formulaire', () => {
  for (const id of ['view-fournisseurs', 'btnCreateSupplier', 'supKind', 'supName', 'supSite',
    'supMargin', 'supStatus', 'supNotes', 'suppliersKindFilter', 'suppliersFilter',
    'suppliers', 'suppliersHead', 'suppliersPager', 'kpiPartenaires']) {
    assert.ok(HTML.includes(`id="${id}"`), `le tableau de bord doit garder #${id}`);
  }
  assert.match(HTML, /data-view="fournisseurs"/, 'la barre latérale doit mener à la vue');
  assert.match(HTML, /#\/fournisseurs/, 'la route par ancre doit exister');
  assert.match(HTML, /Enregistrer le partenaire/);
});

test("l'import propose les partenaires choisis avant l'URL et envoie son identifiant", () => {
  assert.ok(HTML.includes('id="importSupplier"'), 'liste déroulante des partenaires');
  assert.ok(HTML.includes('id="importSupplierMargin"'), 'la marge appliquée doit être dite');
  assert.match(HTML, /— Aucun —/, 'le défaut reste « aucun partenaire »');
  // La sélection part réellement vers l'API : sans cela, choisir un partenaire
  // ne changerait rien au prix calculé.
  assert.match(HTML, /payload\.supplierId = Number\(supplierId\)/);
  assert.match(HTML, /method: 'POST', body: JSON\.stringify\(payload\)/);
  // Les deux types sont présentés séparément.
  assert.match(HTML, /optgroup label/);
});

test('un nom de partenaire ne peut jamais devenir du HTML', () => {
  const { sandbox } = loadDashboard();
  const row = sandbox.supplierEditRow({
    id: 7,
    name: '<img src=x onerror=alert(1)>',
    kind: 'fournisseur',
    status: 'actif',
    site_url: 'https://exemple.com',
    notes: '<script>alert(2)</script>',
    margin_coefficient: 2.5,
  });

  assert.ok(!row.includes('<img'), 'balise img injectée');
  assert.ok(!row.includes('<script>'), 'balise script injectée');
  assert.match(row, /&lt;img/);
  assert.match(row, /&lt;script&gt;/);
  assert.match(row, /data-action="save"/);
  assert.match(row, /data-action="cancel"/);
});

/* Depuis que les transporteurs existent, la vue Fournisseurs ne montre QUE le
   sourcing. Le filtre segmenté garde exactement les deux mêmes choix, et la
   rubrique logistique est atteignable depuis les deux écrans : c'est ce qui
   évite de chercher un transitaire dans la liste des fournisseurs. */
test('la vue Fournisseurs ne montre que le sourcing et renvoie vers les transporteurs', () => {
  assert.ok(HTML.includes('id="suppliersKindSeg"'), 'le filtre segmenté reste en place');
  // Les trois libellés d'origine du filtre sont intacts : Tous, Fournisseurs,
  // Distributeurs. Un quatrième segment « Transporteurs » les aurait dilués.
  const segStart = HTML.indexOf('id="suppliersKindSeg"');
  const seg = HTML.slice(segStart, HTML.indexOf('</div>', segStart));
  assert.match(seg, />Tous </);
  assert.match(seg, />Fournisseurs </);
  assert.match(seg, />Distributeurs </);
  assert.ok(!/data-kind="transporteur"/.test(seg), 'le filtre des partenaires ne propose pas les transporteurs');
  // Le <select> caché qui porte l'état du filtre reste, avec ses deux valeurs.
  const select = HTML.slice(HTML.indexOf('id="suppliersKindFilter"'), segStart);
  assert.match(select, /<option value="">Tous les types<\/option>/);
  assert.match(select, /<option value="fournisseur">/);
  assert.match(select, /<option value="distributeur">/);
  // Les deux rubriques se citent l'une l'autre.
  assert.match(HTML, /href="#\/transporteurs"/);
});
