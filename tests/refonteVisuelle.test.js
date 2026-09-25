/*
 * Refonte visuelle : les garanties qui peuvent se perdre en silence.
 *
 * Le rendu lui-même a été contrôlé à l'écran, vue par vue, dans un navigateur —
 * ça, aucun test ne le remplace. Ce qui est verrouillé ici, ce sont les
 * propriétés qui ont motivé la refonte et qu'une retouche distraite annulerait
 * sans que personne ne s'en aperçoive :
 *
 *  1. chaque vue porte un sous-titre QUI LUI EST PROPRE (il était identique sur
 *     les quatorze écrans, donc ne renseignait sur aucun) ;
 *  2. la grille d'indicateurs n'est plus automatique — avec huit cartes, elle
 *     en plaçait six par ligne et laissait un trou de quatre cases ;
 *  3. la colonne d'actions ne casse plus ses boutons sur trois lignes, ce qui
 *     faisait des lignes de table de ~75 px ;
 *  4. le bandeau « tout est configuré » reste compact, puisqu'il s'affiche
 *     partout, mais le bandeau d'alerte reste complet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-refonte-')), 'ui.db');

const HTML = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const CSS = HTML.replace(/\/\*[\s\S]*?\*\//g, '');

function element(id) {
  return {
    id, innerHTML: '', textContent: '', className: '', hidden: false, disabled: false,
    title: '', value: '', dataset: {}, style: {},
    // `classList` SUIT réellement les classes : un stub vide ne permettrait pas
    // de vérifier un repli de menu, qui n'est rien d'autre qu'un changement de
    // classe. `className` et `classList` sont donc tenus cohérents entre eux.
    classList: (() => {
      const classes = new Set();
      return {
        add: (c) => { classes.add(c); },
        remove: (c) => { classes.delete(c); },
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          const ajouter = force === undefined ? !classes.has(c) : Boolean(force);
          if (ajouter) classes.add(c); else classes.delete(c);
          return ajouter;
        },
        _all: () => [...classes],
      };
    })(),
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    hasAttribute(name) { return this[name] !== undefined; },
    append() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
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
    addEventListener() {}, createElement: (tag) => element(tag), createTextNode: (text) => ({ text }),
  };
  const sandbox = {
    document,
    window: { confirm: () => true, prompt: () => null, addEventListener() {} },
    fetch: () => { throw new Error('aucun appel réseau pendant ce test'); },
    console, URL, setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HTML.match(/<script>([\s\S]*?)<\/script>/)[1], sandbox, { filename: 'index.html' });
  return { sandbox, node: (id) => document.getElementById(id) };
}

/** Récupère la table VIEWS depuis le contexte de la page. */
function vues(sandbox) {
  return vm.runInContext('VIEWS', sandbox);
}

/* ===================== SOUS-TITRES PAR VUE ===================== */

test('chaque vue a un sous-titre, un groupe et un titre', () => {
  const { sandbox } = loadDashboard();
  const V = vues(sandbox);
  const noms = Object.keys(V);
  // Quinze depuis l'ajout de Paramètres (tableau des devises).
  assert.equal(noms.length, 15, 'les quinze vues du hub');
  for (const nom of noms) {
    const v = V[nom];
    assert.ok(v.title && v.title.trim(), `titre manquant pour ${nom}`);
    assert.ok(v.group && v.group.trim(), `groupe manquant pour ${nom} (le fil d’Ariane en dépend)`);
    assert.ok(v.sub && v.sub.trim(), `sous-titre manquant pour ${nom}`);
  }
});

test('les sous-titres ne sont PAS tous identiques (c’était le défaut)', () => {
  const { sandbox } = loadDashboard();
  const V = vues(sandbox);
  const subs = Object.values(V).map((v) => v.sub);
  assert.equal(new Set(subs).size, subs.length, 'aucun sous-titre ne doit être répété');
  // Le texte générique qui servait partout ne doit plus apparaître comme
  // sous-titre : il ne disait rien de l'écran affiché.
  assert.ok(
    !subs.includes('Hub de synchronisation omnicanale et de décision IA'),
    'l’ancien sous-titre générique ne doit plus servir de sous-titre de vue',
  );
});

test('le fil d’Ariane et le sous-titre sont mis à jour au changement de vue', () => {
  const { sandbox, node } = loadDashboard();
  sandbox.showView('imports', { animate: false });
  assert.equal(node('viewTitle').textContent, 'Imports');
  assert.equal(node('viewCrumb').textContent, 'AI Core / Pilotage');
  assert.match(node('viewSub').textContent, /Extraire une fiche fournisseur/);

  sandbox.showView('canaux', { animate: false });
  assert.equal(node('viewTitle').textContent, 'Canaux');
  assert.equal(node('viewCrumb').textContent, 'AI Core / Exploitation');
  assert.match(node('viewSub').textContent, /Places de marché/);
});

test('les deux repères existent dans l’en-tête', () => {
  assert.ok(HTML.includes('id="viewCrumb"'), '#viewCrumb doit exister');
  assert.ok(HTML.includes('id="viewSub"'), '#viewSub doit exister');
  assert.match(CSS, /\.crumb::before/, 'le tiret dégradé du fil d’Ariane');
});

/* ===================== GRILLE D'INDICATEURS ===================== */

test('la grille d’indicateurs n’est plus automatique (elle laissait un trou)', () => {
  const base = CSS.slice(CSS.indexOf('.kpi-grid {'), CSS.indexOf('.kpi {'));
  assert.match(base, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.ok(
    !/auto-fit/.test(base),
    'auto-fit plaçait six cartes par ligne, donc 6 + 2 et un trou de quatre cases avec huit indicateurs',
  );
  // Le palier étroit doit garder un compte qui tombe juste avec huit cartes.
  assert.match(CSS, /@media \(max-width: 1080px\) \{ \.kpi-grid \{ grid-template-columns: repeat\(2,/, 'palier à deux colonnes');
});

test('la grille de la vue large compte douze indicateurs (3 rangées de 4)', () => {
  const grille = HTML.slice(HTML.indexOf('<div class="kpi-grid">'));
  const fin = grille.indexOf('</div>\n      </div>');
  const bloc = grille.slice(0, fin === -1 ? 12000 : fin);
  const n = (bloc.match(/class="kpi"/g) || []).length;
  // 4 indicateurs de SANTÉ (maquette PDF : coût moyen, marge moyenne, imports
  // réussis, à vérifier) + 8 compteurs de volume. Douze tombe juste sur une
  // grille à quatre colonnes — c'est ce qui évite le trou qu'on avait avec huit.
  assert.equal(n, 12, 'douze indicateurs : 4 × 3 rangées pleines');
});

test('les quatre indicateurs de santé de la maquette sont présents, et en tête', () => {
  for (const id of ['kpiCoutMoyen', 'kpiMargeMoyenne', 'kpiReussite', 'kpiAVerifier']) {
    assert.ok(HTML.includes(`id="${id}"`), `l’indicateur #${id} doit exister`);
  }
  // La santé d'abord, les volumes ensuite — l'ordre de la maquette.
  const sante = HTML.indexOf('id="kpiCoutMoyen"');
  const volume = HTML.indexOf('id="kpiProduits"');
  assert.ok(sante > 0 && sante < volume, 'la rangée de santé précède les compteurs de volume');
});

test('les indicateurs de santé sont réellement calculés, pas décoratifs', () => {
  const { sandbox, node } = loadDashboard();
  // `state` est un `const` de haut niveau : il n'est pas exposé comme propriété
  // du contexte, contrairement aux déclarations de fonction. On le récupère donc
  // par évaluation dans le contexte, comme la table VIEWS plus haut.
  const state = vm.runInContext('state', sandbox);
  state.imports = [
    { id: 1, status: 'pret', purchase_price: 10, currency: 'EUR', supplier_id: 7 },
    { id: 2, status: 'brouillon', purchase_price: 20, currency: 'EUR', supplier_id: null },
    { id: 3, status: 'brouillon', purchase_price: 0, currency: 'EUR', supplier_id: null },
  ];
  state.suppliers = [{ id: 7, kind: 'fournisseur', name: 'Test', margin_coefficient: 2 }];
  state.products = [];
  state.channels = [];
  state.activity = [];
  state.config = { pricing: { marginCoefficient: 1.5 } };
  sandbox.renderDashboard();

  // Coût moyen : (10 + 20) / 2. La fiche à 0 est EXCLUE : elle ne dit rien du
  // prix, et la compter tirerait la moyenne vers le bas.
  assert.equal(node('kpiCoutMoyen').textContent, '15.00 EUR');
  // Marge moyenne : le partenaire applique 2.00, les deux autres le coefficient
  // global 1.5 → (2 + 1.5 + 1.5) / 3. Un partenaire sans coefficient propre ne
  // compte pas pour zéro.
  assert.equal(node('kpiMargeMoyenne').textContent, '×1.67');
  // Réussite : deux prix lus sur trois imports.
  assert.match(node('kpiReussite').textContent, /^66[.,]7 %$/);
  // À vérifier : les deux brouillons. Ce compteur passe par animateCount, qui
  // anime sur 560 ms : la valeur affichée n'est donc pas posée de façon
  // synchrone. C'est la CIBLE enregistrée qui porte le résultat du calcul.
  assert.equal(node('kpiAVerifier').dataset.count, '2');
});

/* ===================== DENSITÉ DES TABLEAUX ===================== */

test('la colonne d’actions aligne ses boutons au lieu de les empiler', () => {
  const debut = CSS.indexOf('.cell-actions {');
  const bloc = CSS.slice(debut, debut + 220);
  assert.match(bloc, /min-width:\s*29[0-9]px/, 'la colonne doit être assez large pour ses trois boutons');
  assert.match(bloc, /\.cell-actions \.actions \{[^}]*flex-wrap:\s*nowrap/, 'les boutons restent sur une ligne');
  // Sur écran étroit, la table devient une liste de cartes : le nowrap ferait
  // déborder les boutons hors de la carte, donc on y repasse à la ligne.
  const mobile = CSS.slice(CSS.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /\.cell-actions \.actions \{[^}]*flex-wrap:\s*wrap/, 'retour à la ligne sur mobile');
});

/* ===================== BANDEAU ===================== */

test('le bandeau « tout est configuré » est compact, celui d’alerte reste complet', () => {
  const ok = CSS.slice(CSS.indexOf('.banner.compact'), CSS.indexOf('.banner.compact') + 400);
  assert.match(ok, /display:\s*flex/, 'la version compacte tient sur une ligne');
  // L'alerte, elle, garde sa mise en forme pleine : c'est là qu'il y a quelque
  // chose à faire, donc elle doit rester visible.
  assert.ok(!/\.banner\.warn\.compact|\.banner\.err\.compact/.test(CSS), 'aucune alerte n’est compactée');
});

/* ===================== CARTE « ERREURS D'IMPORT » (maquette PDF) ===================== */

test('la carte « Erreurs d’import » existe, avec un état vide soigné', () => {
  assert.ok(HTML.includes('id="dashImportErrors"'), 'le conteneur de la carte doit exister');
  assert.ok(HTML.includes('id="dashErrorCount"'), 'la pastille de comptage doit exister');
  assert.match(CSS, /\.empty-state-icon/, 'l’état vide a un cercle, pas un simple texte gris');
  assert.match(HTML, /Aucune erreur à signaler/);
});

test('la carte liste les imports sans prix des dernières 24 h et passe au rouge', () => {
  const { sandbox, node } = loadDashboard();
  const state = vm.runInContext('state', sandbox);
  const maintenant = Date.now();
  state.imports = [
    // Échec récent : aucun prix lu → doit apparaître
    { id: 1, title: 'Fiche sans prix', source_site: 'alibaba.com', purchase_price: 0, created_at: maintenant - 3600000, status: 'brouillon' },
    // Réussi → ne doit PAS apparaître
    { id: 2, title: 'Fiche correcte', source_site: 'bigbuy.eu', purchase_price: 12, created_at: maintenant - 3600000, status: 'pret' },
    // Échec mais trop ancien (48 h) → hors de la fenêtre de 24 h
    { id: 3, title: 'Vieil échec', source_site: 'aliexpress.com', purchase_price: 0, created_at: maintenant - 48 * 3600000, status: 'brouillon' },
  ];
  state.products = []; state.channels = []; state.activity = []; state.suppliers = [];
  state.config = { pricing: { marginCoefficient: 1.8 } };
  sandbox.renderDashboard();

  const html = node('dashImportErrors').innerHTML;
  assert.match(html, /Fiche sans prix/, 'l’échec récent doit être listé');
  assert.ok(!html.includes('Fiche correcte'), 'un import réussi ne doit pas être listé');
  assert.ok(!html.includes('Vieil échec'), 'au-delà de 24 h, l’échec sort de la carte');
  assert.equal(node('dashErrorCount').textContent, '1 erreur');
  assert.match(node('dashErrorCount').className, /pill bad/);
});

test('sans erreur, la carte affiche l’état vide et une pastille verte', () => {
  const { sandbox, node } = loadDashboard();
  const state = vm.runInContext('state', sandbox);
  state.imports = [{ id: 1, title: 'Ok', source_site: 'x.eu', purchase_price: 5, created_at: Date.now(), status: 'pret' }];
  state.products = []; state.channels = []; state.activity = []; state.suppliers = [];
  state.config = { pricing: { marginCoefficient: 1.8 } };
  sandbox.renderDashboard();

  assert.match(node('dashImportErrors').innerHTML, /Aucune erreur à signaler/);
  assert.equal(node('dashErrorCount').textContent, 'Aucune');
  assert.match(node('dashErrorCount').className, /pill ok/);
});

/* ===================== REPLI DE LA BARRE LATÉRALE ===================== */

test('le bouton « Réduire le menu » existe et mémorise le choix', () => {
  assert.ok(HTML.includes('id="btnCollapseNav"'), 'le bouton doit exister');
  assert.match(HTML, /Réduire le menu/);
  // Le repli est mémorisé : ce n'est pas une donnée de service, donc le
  // navigateur suffit — inutile d'ajouter une colonne en base.
  assert.match(HTML, /mm_nav_collapsed_v1/);

  const { sandbox, node } = loadDashboard();
  sandbox.setNavCollapsed(true);
  assert.ok(node('app').classList.contains('nav-collapsed'), 'la classe de repli doit être posée');
  assert.equal(node('btnCollapseNav').getAttribute?.('aria-expanded') ?? node('btnCollapseNav')['aria-expanded'], 'false');
  sandbox.setNavCollapsed(false);
  assert.ok(!node('app').classList.contains('nav-collapsed'), 'le dépli doit retirer la classe');
});

test('le repli ne s’applique QUE hors mobile (sinon il écrase le tiroir)', () => {
  // `.app.nav-collapsed .main` a une spécificité plus forte que la règle mobile
  // `.main { margin-left: 0 }` : sans la garde, la barre resterait décalée sur
  // téléphone alors qu'elle est censée être un tiroir hors écran.
  const debut = CSS.indexOf('.app.nav-collapsed .sidebar');
  assert.ok(debut > 0, 'les règles de repli doivent exister');
  const avant = CSS.slice(0, debut);
  const derniereMedia = avant.lastIndexOf('@media');
  assert.match(
    avant.slice(derniereMedia, debut),
    /@media \(min-width: 701px\)/,
    'les règles de repli doivent être enfermées dans un media query de largeur minimale',
  );
});
