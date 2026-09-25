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
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
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
  assert.equal(noms.length, 14, 'les quatorze vues du hub');
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

test('la grille de la vue large compte bien huit indicateurs', () => {
  const grille = HTML.slice(HTML.indexOf('<div class="kpi-grid">'));
  const fin = grille.indexOf('</div>\n      </div>');
  const bloc = grille.slice(0, fin === -1 ? 12000 : fin);
  const n = (bloc.match(/class="kpi"/g) || []).length;
  assert.equal(n, 8, 'huit indicateurs sur le tableau de bord : 4 × 2 tombe juste');
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
