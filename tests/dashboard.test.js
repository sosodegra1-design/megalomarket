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
  // Auto-contenu : aucune dépendance externe, donc rien à construire.
  assert.ok(!/<script[^>]+src=/.test(HTML), 'aucun script externe');
  assert.ok(!/<link[^>]+href=/.test(HTML), 'aucune feuille de style externe');
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
