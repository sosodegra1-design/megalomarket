/*
 * Identité visuelle : emblème, favicon et contraste des boutons.
 *
 * Ces tests ne vérifient pas « que ça a l'air joli » — seul un œil en juge, et
 * le rendu a été contrôlé à la taille réelle dans un navigateur. Ils
 * verrouillent ce qui est VÉRIFIABLE et ce qui peut se casser en silence :
 *
 *  - l'emblème doit porter les trois accents de la maquette en hexadécimal :
 *    un SVG réutilisé comme favicon n'a aucune feuille de style, donc des
 *    `var(--…)` n'y seraient pas résolus et l'icône sortirait noire ;
 *  - le contraste du bouton principal est CALCULÉ : c'est ce qui empêche de
 *    réintroduire du blanc sur le cyan (1,53:1, illisible) sans que personne ne
 *    s'en aperçoive ;
 *  - le fichier doit rester auto-contenu malgré le favicon ajouté.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');

/* Le CSS est commenté en français, et ces commentaires CITENT les propriétés
   qu'ils expliquent (« un `color: transparent` non conditionné… »). Analyser le
   texte brut ferait donc passer un commentaire pour une règle — l'erreur a été
   commise pour de vrai en écrivant ces tests, d'où ce nettoyage. */
const CSS = HTML.replace(/\/\*[\s\S]*?\*\//g, '');

/** Extrait un jeton CSS de la forme `--nom: #abcdef;`. */
function token(name) {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  assert.ok(match, `le jeton --${name} doit exister`);
  return match[1].trim();
}

/* Contraste WCAG 2.1, calculé et non estimé. */
function luminance(hex) {
  const clean = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const canal = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

function contraste(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const SEUIL_TEXTE_NORMAL = 4.5;

/* ===================== L'EMBLÈME ===================== */

test('l’emblème porte les trois accents de la maquette, en hexadécimal', () => {
  const debut = CSS.indexOf('id="mmLogoGrad"');
  const fin = CSS.indexOf('id="mmLogoGlow"');
  assert.ok(debut > 0 && fin > debut, 'le dégradé de l’emblème doit être présent');
  const degrade = CSS.slice(debut, fin);
  for (const accent of ['#2ee6f5', '#ec3fbf', '#8a4dff']) {
    assert.ok(
      degrade.toLowerCase().includes(accent),
      `l’emblème doit utiliser l’accent ${accent} de la maquette`,
    );
  }
  // Un favicon n'a pas de CSS : `var(--…)` ne s'y résout pas et l'icône
  // sortirait noire. Les couleurs de l'emblème doivent donc être littérales.
  assert.ok(!/stop-color="var\(/.test(degrade), 'aucune variable CSS dans les arrêts du dégradé');
});

test('l’emblème a un halo et une lueur (l’aspect néon de la maquette)', () => {
  assert.match(HTML, /id="mmLogoHalo"/, 'le halo doit exister');
  assert.match(HTML, /id="mmLogoGlow"/, 'le filtre de lueur doit exister');
  assert.match(HTML, /feGaussianBlur/, 'la lueur repose sur un flou gaussien');
});

test('le disque opaque qui écrasait l’emblème a disparu', () => {
  // L'ancien fond empilait une sphère « verre » et un anneau incrusté : à 32 px
  // il ne restait qu'une pastille sombre, alors que l'emblème dessine déjà son
  // propre anneau. Le fond ne doit plus être qu'un halo.
  const debut = CSS.indexOf('.brand-mark {');
  const fin = CSS.indexOf('.brand-mark svg');
  assert.ok(debut > 0 && fin > debut);
  const bloc = CSS.slice(debut, fin);
  assert.ok(!/inset 0 0 0 1px/.test(bloc), 'plus d’anneau incrusté qui double celui de l’emblème');
  assert.ok(!/rgba\(9,\s*11,\s*20,\s*\.94\)/.test(bloc), 'plus de disque opaque sous l’emblème');
  assert.match(bloc, /radial-gradient/, 'un halo subsiste pour détacher l’emblème du fond');
});

/* ===================== LE FAVICON ===================== */

test('le favicon est embarqué en data URI, sans ressource distante', () => {
  assert.match(HTML, /<link rel="icon"[^>]+href="data:image\/svg\+xml,/);
  // Le favicon était totalement absent : l'onglet restait vierge.
  assert.ok(!/<link[^>]+href=["'](?!data:)/i.test(HTML), 'aucune ressource distante');
  assert.ok(!/<script[^>]+src=/.test(HTML), 'aucun script externe');
});

/* ===================== CONTRASTE DES BOUTONS ===================== */

test('le bouton principal est lisible : contraste calculé au-dessus du seuil', () => {
  const cyan = token('cyan');
  const encre = token('btn-primary-ink');
  const ratio = contraste(encre, cyan);
  assert.ok(
    ratio >= SEUIL_TEXTE_NORMAL,
    `le texte du bouton principal doit atteindre ${SEUIL_TEXTE_NORMAL}:1 sur le cyan, obtenu ${ratio.toFixed(2)}:1`,
  );
  // Et la raison d'être du changement : le blanc échouait lamentablement.
  const avecBlanc = contraste('#ffffff', cyan);
  assert.ok(
    avecBlanc < SEUIL_TEXTE_NORMAL,
    'le blanc sur le cyan doit bien être sous le seuil — c’est le défaut corrigé',
  );
  const base = CSS.slice(CSS.indexOf('.btn {'), CSS.indexOf('.btn:hover'));
  assert.ok(!/color:\s*#fff/i.test(base), 'le bouton principal ne doit plus forcer un texte blanc sur le cyan');
});

test('le bouton de destruction garde un texte clair (pas de régression par héritage)', () => {
  // Le bouton principal impose une encre sombre ; si le bouton rouge ne la
  // rebasculait pas, il hériterait du sombre sur un fond rouge sombre.
  const rouge = token('bad-btn');
  const ratio = contraste('#ffffff', rouge);
  assert.ok(ratio >= SEUIL_TEXTE_NORMAL, `le blanc sur ${rouge} doit rester lisible (${ratio.toFixed(2)}:1)`);
  const parHeritage = contraste(token('btn-primary-ink'), rouge);
  assert.ok(parHeritage < SEUIL_TEXTE_NORMAL, 'sans rebascule, le contraste serait insuffisant — d’où la règle');
  assert.match(CSS, /\.btn\.danger[^{]*\{[^}]*color:\s*#fff/, 'le bouton rouge doit rebasculer son texte en blanc');
});

test('le bouton principal est un dégradé cyan, comme la maquette', () => {
  const bloc = CSS.slice(CSS.indexOf('.btn {'), CSS.indexOf('.btn:hover'));
  assert.match(bloc, /linear-gradient\(135deg,\s*var\(--cyan\),\s*var\(--cyan-2\)\)/);
  // Les variantes non cyan neutralisent la lueur : sous un bouton rouge, une
  // lueur cyan serait franchement fausse.
  assert.match(CSS, /\.btn\.danger[^{]*\{[^}]*box-shadow:\s*none/);
  assert.match(CSS, /\.btn\.ghost[^{]*\{[^}]*box-shadow:\s*none/);
});

/* ===================== LE NOM ===================== */

test('le nom est en dégradé, mais seulement si le navigateur sait découper le fond', () => {
  const debutCondition = CSS.indexOf('@supports ((background-clip: text)');
  assert.ok(debutCondition > 0, 'la découpe doit être conditionnée par @supports');
  // Fenêtre bornée : `.brand-sub` apparaît AUSSI plus haut dans la feuille de
  // style (règle groupée), donc le prendre comme borne donnerait une tranche
  // vide — le piège est réel, il a fait échouer la première version du test.
  const bloc = CSS.slice(debutCondition, debutCondition + 420);
  assert.match(bloc, /background-clip: text/);
  assert.match(bloc, /text-fill-color: transparent/, 'WebKit a besoin de cette propriété');
  // Hors @supports, le nom garde une couleur pleine : sans cette précaution, un
  // `color: transparent` non conditionné rendrait le nom invisible.
  const base = CSS.slice(CSS.indexOf('.brand-name {'), debutCondition);
  assert.match(base, /color:\s*var\(--ink\)/, 'couleur pleine de repli');
  assert.ok(!/color:\s*transparent/.test(base), 'pas de transparence hors @supports');
});
