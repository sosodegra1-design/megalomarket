/*
 * Tableau de bord : la rubrique « Transporteurs » et la frontière avec l'import.
 *
 * Depuis que le registre accepte un troisième type (`transporteur`), l'écran
 * peut mentir de deux façons, et ce sont les deux que ces tests verrouillent :
 *
 *   1. présenter un coefficient de marge pour un transporteur. Un transporteur
 *      vend un service : `margin_coefficient` n'a AUCUN sens métier, le serveur
 *      n'y met qu'un remplissage technique. Afficher « ×1,50 » ou « défaut
 *      global » ferait croire à une marge négociée — c'est pire qu'une case vide.
 *   2. laisser un transporteur entrer dans le sélecteur de l'import. L'import
 *      choisit ce qu'on ACHÈTE ; un transporteur n'est pas de la marchandise.
 *
 * Un troisième point est verrouillé ici : le regroupement par famille. La
 * famille n'existe pas dans l'API, elle est déduite par l'écran (préfixe des
 * notes, puis table par nom) — il faut donc qu'elle soit STABLE pour le
 * catalogue de démarrage, sinon la liste de 23 lignes redevient un vrac.
 *
 * Le script réel est exécuté dans un DOM minimal, comme tests/dashboard.test.js.
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
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((n) => this._set.add(n)); },
      remove(...names) { names.forEach((n) => this._set.delete(n)); },
      toggle(name, on) {
        if (on === undefined) { this._set.has(name) ? this._set.delete(name) : this._set.add(name); }
        else if (on) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) { return this._set.has(name); },
    },
    setAttribute(key, value) { this[key] = value; },
    getAttribute(key) { return this[key] ?? null; },
    removeAttribute(key) { delete this[key]; },
    hasAttribute(key) { return key in this; },
    append() {},
    addEventListener() {},
    querySelectorAll() { return []; },
  };
}

/* Le script est évalué, mais PAS démarré (`readyState = 'loading'`) : aucun appel
   réseau ne part. On interroge ensuite ses fonctions via `run()`, car `state` et
   les tables sont des déclarations lexicales, donc invisibles comme propriétés
   du bac à sable. */
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
    window: { confirm: () => true, prompt: () => null, addEventListener() {} },
    fetch: () => { throw new Error('aucun appel réseau ne doit partir pendant ce test'); },
    console,
    URL,
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, sandbox, { filename: 'index.html' });
  return {
    sandbox,
    run: (expression) => vm.runInContext(expression, sandbox),
    node: (id) => document.getElementById(id),
  };
}

/* Jeu d'essai : les deux registres mélangés, comme l'API les renvoie (une seule
   liste, triée par nom, tous types confondus). */
const PARTNERS = [
  { id: 1, kind: 'fournisseur', name: 'Grossiste Shenzhen', status: 'actif', site_url: 'https://a.example', margin_coefficient: 2.4, import_count: 3, notes: 'plateforme de gros' },
  { id: 2, kind: 'distributeur', name: 'Revendeur local', status: 'actif', site_url: null, margin_coefficient: null, import_count: 0, notes: null },
  { id: 3, kind: 'transporteur', name: 'DHL Express', status: 'actif', site_url: 'https://www.dhl.com', margin_coefficient: 1.5, import_count: 0, notes: 'Express international, dédouanement inclus.' },
  { id: 4, kind: 'transporteur', name: 'Superbuy', status: 'inactif', site_url: 'https://www.superbuy.com', margin_coefficient: 1.5, import_count: 0, notes: "Agent d'achat chinois : achète sur 1688 et Taobao." },
];

function withPartners(run) {
  run(`state.suppliers = ${JSON.stringify(PARTNERS)}`);
}

/* ===================== STRUCTURE DE LA RUBRIQUE ===================== */

test('une rubrique Transporteurs existe, avec sa table, son formulaire et sa route', () => {
  for (const id of ['view-transporteurs', 'btnCreateCarrier', 'carName', 'carSite',
    'carStatus', 'carNotes', 'carriers', 'carriersHead', 'carriersPager',
    'carriersFilter', 'carriersKindFilter', 'carriersKindSeg', 'kpiTransporteurs']) {
    assert.ok(HTML.includes(`id="${id}"`), `la rubrique doit garder #${id}`);
  }
  assert.match(HTML, /data-view="transporteurs"/, 'la barre latérale doit mener à la rubrique');
  assert.match(HTML, /#\/transporteurs/, "la route par ancre doit exister");
  assert.match(HTML, /Enregistrer le transporteur/);
});

test("l'état vide de la rubrique explique 1688, l'agent d'achat puis le transitaire", () => {
  // Le vrai problème de l'utilisateur n'est pas « comment remplir un
  // formulaire » mais « pourquoi 1688 ne m'envoie rien ». La réponse doit être
  // dans la page, pas dans la tête de quelqu'un d'autre.
  assert.match(HTML, /1688 et Taobao ne livrent pas en Europe/);
  assert.match(HTML, /agent d'achat/i);
  assert.match(HTML, /transitaire/i);
});

test('la rubrique Transporteurs ne promet jamais une marge', () => {
  // Ni colonne « Marge » dans l'en-tête de la table…
  const head = HTML.slice(HTML.indexOf('id="carriersHead"'), HTML.indexOf('id="carriers"'));
  assert.ok(!/Marge/.test(head), 'aucune colonne Marge dans la table des transporteurs');
  // …ni aperçu de coefficient dans le formulaire (le vocabulaire de la marge
  // reste dans la rubrique Fournisseurs, qui est le seul endroit où il vaut).
  const form = HTML.slice(HTML.indexOf('id="view-transporteurs"'), HTML.indexOf('id="carriersEmptyCard"'));
  assert.ok(!/Coefficient de marge/.test(form), 'aucun champ de coefficient dans le formulaire transporteur');
  assert.match(form, /Aucune marge n'est demandée/);
});

/* ===================== SÉPARATION DES DEUX REGISTRES ===================== */

test('la table des transporteurs ne contient que des transporteurs', () => {
  const { run, node } = loadDashboard();
  withPartners(run);

  run('applyCarrierFilter()');
  assert.equal(run('carriersTable.rows.length'), 2);
  assert.ok(run('carriersTable.rows.every((c) => c.kind === "transporteur")'));

  run('applySupplierFilter()');
  assert.equal(run('suppliersTable.rows.length'), 2);
  assert.ok(run('suppliersTable.rows.every((s) => s.kind !== "transporteur")'),
    "la vue Fournisseurs ne montre que le sourcing");

  // Le rendu des transporteurs ne doit contenir AUCUNE trace du vocabulaire de
  // la marge : ni coefficient, ni marqueur de défaut global.
  const rendered = node('carriers').innerHTML;
  assert.ok(!/défaut global/.test(rendered), 'jamais de marqueur « défaut global » pour un transporteur');
  assert.ok(!/×1\.50|×1,50/.test(rendered), 'jamais de coefficient affiché pour un transporteur');
  assert.ok(!/Marge/.test(rendered), 'jamais le mot marge sur une ligne de transporteur');
  assert.match(rendered, /DHL Express/);
  assert.match(rendered, /Express porte-à-porte/, 'la famille est visible sur la ligne');

  // Un transporteur n'a pas d'imports : le compteur est masqué, pas affiché à 0.
  assert.ok(!/cell-sub/.test(rendered), "aucun compteur d'import nul affiché");
});

test('la ligne d’édition d’un transporteur n’a ni marge ni type', () => {
  const { run } = loadDashboard();
  const carrier = run(`carrierEditRow({ id: 3, name: 'DHL Express', kind: 'transporteur',
    status: 'actif', site_url: null, notes: null, margin_coefficient: 1.5, import_count: 0 })`);

  assert.ok(!/sup-edit-margin-/.test(carrier), 'aucun champ de marge');
  assert.ok(!/sup-edit-kind-/.test(carrier), 'aucun sélecteur de type : on ne transforme pas un transporteur en fournisseur depuis cette rubrique');
  assert.ok(!/défaut global/.test(carrier), 'aucune allusion au coefficient global');
  assert.match(carrier, /data-action="save"/);
  assert.match(carrier, /data-action="cancel"/);

  // La ligne d'édition d'un partenaire de sourcing, elle, garde les deux champs :
  // la séparation ne doit pas appauvrir la rubrique Fournisseurs.
  const supplier = run(`supplierEditRow({ id: 1, name: 'Grossiste', kind: 'fournisseur',
    status: 'actif', site_url: null, notes: null, margin_coefficient: 2.4 }, true)`);
  assert.match(supplier, /sup-edit-margin-/);
  assert.match(supplier, /sup-edit-kind-/);
});

/* ===================== LE SÉLECTEUR DE L'IMPORT ===================== */

test("le sélecteur de l'import exclut les transporteurs et garde les deux groupes", () => {
  const { run, node } = loadDashboard();
  withPartners(run);
  run('populateImportSuppliers()');

  const select = node('importSupplier').innerHTML;
  // Ce qui doit rester : les partenaires de sourcing, groupés comme avant.
  assert.match(select, /— Aucun —/);
  assert.match(select, /Grossiste Shenzhen/);
  assert.match(select, /Revendeur local/);
  assert.match(select, /<optgroup label="Fournisseurs">/);
  assert.match(select, /<optgroup label="Distributeurs">/);
  // Ce qui ne doit JAMAIS y entrer : un transporteur, même avec une marge
  // technique en base — c'est justement le piège que ce test surveille.
  assert.ok(!/DHL Express/.test(select), 'un transporteur ne doit pas être proposé à l’import');
  assert.ok(!/Superbuy/.test(select), "un agent d'achat ne vend pas la marchandise : il ne doit pas être proposé à l'import");

  // La liste déroulante de recherche (le combobox) suit exactement la même
  // règle : un transporteur ne doit pas non plus y apparaître.
  run('openImportPicker()');
  const list = node('importSupplierList').innerHTML;
  assert.ok(!/DHL Express/.test(list), 'absent aussi du combobox de recherche');
  assert.match(list, /Grossiste Shenzhen/);
});

test('le <select> de l’import reste la source de valeur, avec son identifiant', () => {
  const { run, node } = loadDashboard();
  withPartners(run);
  run('populateImportSuppliers()');
  // Choix d'un partenaire de sourcing : la valeur doit atterrir dans le <select>.
  run("chooseImportSupplier('1')");
  assert.equal(node('importSupplier').value, '1');
  // Choix d'un transporteur : refusé, la valeur retombe sur « aucun ».
  run("chooseImportSupplier('3')");
  assert.equal(node('importSupplier').value, '',
    'un identifiant de transporteur ne doit jamais s’installer dans le sélecteur');
});

/* ===================== FAMILLES ===================== */

test('les familles sont déduites des notes, puis du nom, sans invention', () => {
  const { run } = loadDashboard();

  // 1. Le préfixe des notes suffit — c'est ce que l'aide du formulaire demande
  //    d'écrire, donc la règle reste vraie pour les fiches ajoutées à la main.
  assert.equal(run("carrierFamily({ name: 'X', notes: 'Express international.' })"), 'express');
  assert.equal(run("carrierFamily({ name: 'X', notes: \"Agent d'achat chinois.\" })"), 'agent');
  assert.equal(run("carrierFamily({ name: 'X', notes: 'Transitaire numérique.' })"), 'fret');
  assert.equal(run("carrierFamily({ name: 'X', notes: 'Armateur. Conteneurs.' })"), 'fret');
  assert.equal(run("carrierFamily({ name: 'X', notes: 'Comparateur de fret.' })"), 'fret');
  assert.equal(run("carrierFamily({ name: 'X', notes: 'Plateforme multi-transporteurs.' })"), 'plateforme');

  // 2. Une fiche sans notes reconnaissable n'est PAS rangée de force : elle va
  //    dans la famille d'accueil. C'est le point qui évite les faux classements.
  assert.equal(run("carrierFamily({ name: 'Inconnu SARL', notes: null })"), 'autre');
  assert.equal(run("carrierFamily({ name: 'Inconnu SARL', notes: 'Rapide et cher.' })"), 'autre');
  assert.equal(run("carrierFamily(null)"), 'autre');
});

test('le catalogue de démarrage se répartit dans les quatre familles attendues', () => {
  const { run } = loadDashboard();
  const catalogue = [
    ['DHL Express', 'Express international. Rapide et cher.'],
    ['FedEx', 'Express international. Bon pour les envois lourds.'],
    ['UPS', 'Express international. Réseau large.'],
    ['Chronopost', "Express français, intégré à La Poste."],
    ['DPD', 'Réseau européen de colis.'],
    ['GLS', "Réseau européen, très présent en Allemagne."],
    ['Colissimo', 'Colis international de La Poste.'],
    ['Freightos', 'Comparateur de fret international.'],
    ['Flexport', 'Transitaire numérique.'],
    ['Kuehne+Nagel', 'Gros transitaire mondial.'],
    ['DSV', 'Transitaire mondial.'],
    ['Maersk', 'Armateur. Conteneurs complets.'],
    ['CMA CGM', 'Armateur français.'],
    ['Bolloré Logistics', 'Transitaire français.'],
    ['Superbuy', "Agent d'achat chinois. Achète sur 1688."],
    ['Sugargoo', "Agent d'achat chinois. Consolidation."],
    ['CNFans', "Agent d'achat chinois. Petites commandes."],
    ['Yoybuy', "Agent d'achat chinois. Ancien et fiable."],
    ['Basetao', "Agent d'achat chinois. Contrôle qualité."],
    ['Sendcloud', "Plateforme d'expédition multi-transporteurs."],
    ['Shippo', "Plateforme d'expédition multi-transporteurs."],
    ['Easyship', 'Expédition internationale multi-transporteurs.'],
    ['Boxtal', 'Expédition française multi-transporteurs.'],
  ];
  const counts = {};
  for (const [name, notes] of catalogue) {
    const family = run(`carrierFamily(${JSON.stringify({ name, notes })})`);
    counts[family] = (counts[family] || 0) + 1;
    assert.notEqual(family, 'autre', `${name} doit tomber dans une famille connue`);
  }
  assert.deepEqual(counts, { express: 7, fret: 7, agent: 5, plateforme: 4 });
});

test('un nom de transporteur ne peut jamais devenir du HTML', () => {
  const { run } = loadDashboard();
  const row = run(`carrierEditRow({ id: 9, name: '<img src=x onerror=alert(1)>',
    kind: 'transporteur', status: 'actif', site_url: 'javascript:alert(1)',
    notes: '<script>alert(2)</script>', margin_coefficient: 1.5 })`);

  assert.ok(!row.includes('<img'), 'balise img injectée');
  assert.ok(!row.includes('<script>'), 'balise script injectée');
  assert.match(row, /&lt;img/);
  assert.match(row, /&lt;script&gt;/);
});

/* ===================== COMPTEURS ===================== */

test('les compteurs séparent le sourcing de la logistique', () => {
  const { run, node } = loadDashboard();
  withPartners(run);
  run('updateSupplierCounts(); updateCarrierCounts(); renderDashboard();');

  // Côté sourcing : deux partenaires, et pas quatre.
  assert.equal(node('supKindCountAll').textContent, '2');
  assert.equal(node('kpiPartenaires').dataset.count, '2');
  // Côté logistique : ses propres compteurs.
  assert.equal(node('carKindCountAll').textContent, '2');
  assert.equal(node('carKindCountInactif').textContent, '1');
  assert.equal(node('kpiTransporteurs').dataset.count, '2');
  // Le détail annoncé nomme les familles réellement peuplées, pas un total nu.
  assert.match(node('carriersCount').textContent, /express/i);
  assert.match(node('carriersCount').textContent, /agents d'achat/);
});
