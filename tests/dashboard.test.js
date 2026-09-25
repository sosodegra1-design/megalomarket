/*
 * Tableau de bord (src/public/index.html).
 *
 * C'est un fichier statique sans étape de build : une faute de syntaxe dans son
 * script ne se voit qu'au chargement, dans le navigateur — et l'échappement y
 * est une vraie question de sécurité, puisque noms de produits et messages
 * clients y sont injectés. Ces tests exécutent le script réel dans un DOM
 * minimal pour verrouiller le bandeau de configuration et `esc()`.
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

/* DOM minimal : le script n'a besoin que de quelques nœuds pour être évalué.
   `readyState = 'loading'` évite le démarrage automatique, donc tout appel
   réseau — on teste le rendu, pas l'API. */
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
  return { sandbox, banner: document.getElementById('configBanner'), node: (id) => document.getElementById(id) };
}

const BASELINE = {
  database: { persistent: true, host: 'megalomarket-production.turso.io' },
  access: { protected: true },
  ai: { configured: false, provider: null, model: null },
  channels: { ebay: false, own_site: false, amazon: false, tiktok_shop: false, allegro: false },
};

test('le tableau de bord est en français et garde ses points d’entrée', () => {
  assert.match(HTML, /<html lang="fr">/);
  // Chaque flux demandé doit rester présent : import en deux étapes, fiches,
  // produits, recommandations, support, synchronisations, journal, imports.
  for (const id of ['btnExtract', 'btnGenerate', 'btnCreateProduct', 'btnQualify',
    'btnSyncStock', 'btnSyncOrders', 'btnRefresh', 'importUrl', 'supportMsg',
    'products', 'recommendations', 'activity', 'imports', 'listings']) {
    assert.ok(HTML.includes(`id="${id}"`), `le tableau de bord doit garder #${id}`);
  }
  // Auto-contenu : le fichier ne doit RIEN charger sur le réseau, donc rien à
  // construire. Le contrôle porte sur les ressources DISTANTES, pas sur la
  // présence d'un `href` : le favicon et les polices sont encodés en `data:`,
  // donc internes au fichier. Interdire tout `href` interdisait de fait un
  // favicon embarqué — c'est la propriété visée qui est vérifiée ici.
  assert.ok(!/<script[^>]+src=/.test(HTML), 'aucun script externe');
  assert.ok(!/<link[^>]+href=["'](?!data:)/i.test(HTML), 'aucune ressource distante');
  // Et le favicon doit bel et bien être là (il manquait complètement).
  assert.match(HTML, /<link rel="icon"[^>]+href="data:image\/svg\+xml,/, 'le favicon doit être embarqué');
});

test('un réglage manquant est nommé, avec sa conséquence', () => {
  const { sandbox, banner } = loadDashboard();
  sandbox.renderBanner({
    ...BASELINE,
    missing: [
      'ANTHROPIC_API_KEY (ou AI_BASE_URL + AI_API_KEY + AI_MODEL)',
      'OWN_SITE_API_URL + OWN_SITE_API_KEY',
      'EBAY_APP_ID + EBAY_CERT_ID + EBAY_DEV_ID + EBAY_REFRESH_TOKEN',
    ],
  });

  assert.equal(banner.className, 'banner warn', 'l’état incomplet doit sauter aux yeux');
  for (const name of ['ANTHROPIC_API_KEY', 'OWN_SITE_API_URL', 'EBAY_APP_ID', 'Base distante']) {
    assert.match(banner.innerHTML, new RegExp(name));
  }
  assert.match(banner.innerHTML, /Fournisseur IA non configuré/);
});

test('tout configuré : le bandeau passe au vert', () => {
  const { sandbox, banner } = loadDashboard();
  sandbox.renderBanner({
    ...BASELINE,
    ai: { configured: true, provider: 'anthropic', model: 'claude-sonnet-5' },
    channels: { ebay: true, own_site: true, amazon: false, tiktok_shop: false, allegro: false },
    missing: [],
  });

  assert.equal(banner.className, 'banner ok');
  assert.match(banner.innerHTML, /Tout est configuré/);
  assert.match(banner.innerHTML, /anthropic \(claude-sonnet-5\)/);
});

test('une valeur de l’API ne peut jamais devenir du HTML', () => {
  const { sandbox, banner } = loadDashboard();
  sandbox.renderBanner({
    ...BASELINE,
    database: { persistent: true, host: '<img src=x onerror=alert(1)>' },
    missing: ['<script>alert(2)</script>'],
  });

  assert.ok(!banner.innerHTML.includes('<script>'), 'balise script injectée');
  assert.ok(!banner.innerHTML.includes('<img'), 'balise img injectée');
  assert.match(banner.innerHTML, /&lt;script&gt;/);
  assert.match(banner.innerHTML, /&lt;img/);

  // La fonction partagée par tous les rendus HTML.
  assert.equal(sandbox.esc(`<b>"x"&'y'</b>`), '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
});

test('une configuration illisible laisse les actions IA bloquées', () => {
  const { sandbox, banner, node } = loadDashboard();
  sandbox.renderBannerError('Clé d’accès absente ou invalide. (HTTP 401)');
  assert.equal(banner.className, 'banner err');
  assert.match(banner.innerHTML, /Configuration illisible/);

  // Sans configuration connue, le bouton de génération IA reste désactivé
  // plutôt que d'échouer au clic.
  sandbox.applyAiState();
  assert.equal(node('btnGenerate').disabled, true);
});

/* Régression signalée en production : le bouton « Chercher chez un
   fournisseur » du Dénicheur pointait TOUJOURS vers Alibaba (Chine), même
   quand la piste de sourcing suggérée par l'IA était européenne (ex.
   « fabricant textile en Autriche ») — le lien contredisait alors le texte
   affiché juste à côté. La recherche doit maintenant reprendre la piste
   réellement suggérée, quelle qu'elle soit. */
test('la recherche fournisseur du Dénicheur respecte la piste de sourcing affichée, pas un site fixe', () => {
  const { sandbox } = loadDashboard();
  const url = sandbox.nicheSupplierSearchUrl('Gourde isotherme 750ml', 'fabricant textile en Autriche');
  assert.ok(!/alibaba/i.test(url), 'ne doit plus renvoyer vers un site fixe sans rapport avec la piste affichée');
  assert.match(url, /Autriche/, 'la région suggérée par l’IA doit se retrouver dans la recherche');
  assert.match(url, /Gourde%20isotherme/i);

  // Sans piste de sourcing (l'IA ne l'a pas remplie), un repli générique
  // reste utilisable plutôt qu'une recherche vide ou une erreur.
  const fallback = sandbox.nicheSupplierSearchUrl('Gourde isotherme 750ml', '');
  assert.match(fallback, /fournisseur/);
});

/* ===================== MOUVEMENT =====================
   L'animation ne fait pas partie du contrat fonctionnel, mais deux de ses
   propriétés en font partie : elle ne doit JAMAIS retarder une action, et elle
   ne doit JAMAIS porter seule une information. Ces tests verrouillent les deux
   garde-fous qui rendent ces promesses vérifiables sans navigateur :
   `prefers-reduced-motion` neutralise tout, et aucune règle d'animation ne
   touche le défilement ou la mise en page au chargement. */

test('le mouvement réduit neutralise les animations, sans faire disparaître l’état', () => {
  const reduced = HTML.slice(HTML.indexOf('prefers-reduced-motion'));
  // La règle globale : durée quasi nulle, une seule itération.
  assert.match(reduced, /animation-duration:\s*\.001ms\s*!important/);
  assert.match(reduced, /transition-duration:\s*\.001ms\s*!important/);
  // Un contenu révélé par une animation part d'une opacité nulle : sans cette
  // ligne, le mode « mouvement réduit » le laisserait invisible pour toujours.
  assert.match(reduced, /\.reveal-in\s*\{[^}]*opacity:\s*1\s*!important/);
  assert.match(reduced, /\.row-in\s*\{[^}]*opacity:\s*1\s*!important/);
  // Le rond d'occupation perd sa rotation mais reste visible : l'information
  // « une requête est en vol » ne doit pas disparaître avec l'animation.
  assert.match(reduced, /\.spinner\s*\{[^}]*animation:\s*none\s*!important/);
});

test('chaque transition de vue est orientée et laisse l’action immédiate', () => {
  for (const name of ['viewInFromRight', 'viewInFromLeft']) {
    assert.match(HTML, new RegExp('@keyframes\\s+' + name), `l’animation ${name} doit exister`);
  }
  // Les durées restent courtes : au-delà, le mouvement deviendrait une attente.
  assert.ok(HTML.includes('viewInFromRight .34s'), 'entrée par la droite bornée');
  assert.ok(HTML.includes('viewInFromLeft .34s'), 'entrée par la gauche bornée');
  // La vue sortante ne s'anime pas : animer les deux obligerait à la sortir du
  // flux, donc à produire un décalage de mise en page à chaque clic. Une seule
  // animation suffit à donner le sens, et elle ne coûte rien à l'action.
  assert.ok(!/@keyframes\s+viewOut/.test(HTML), 'aucune animation de sortie de vue');
  // Aucune transition globale ne doit toucher `all` sur le contenu : c'est le
  // raccourci qui produit des décalages de mise en page au chargement.
  assert.ok(!/\.content\s*\{[^}]*transition:\s*all/.test(HTML), 'pas de transition « all » sur le contenu');
});

test('l’entrée échelonnée ne consomme rien dans une vue cachée', () => {
  // Les lignes et les cartes sont en pause tant que leur vue n'est pas active :
  // une table rendue en arrière-plan ne peut donc pas rester transparente.
  assert.match(HTML, /animation-play-state:\s*paused/);
  assert.match(HTML, /\.view\.active\s+\.row-in[^{]*\{\s*animation-play-state:\s*running/);
  assert.match(HTML, /\.view\.active\s+\.reveal-in[^{]*\{\s*animation-play-state:\s*running/);
});
