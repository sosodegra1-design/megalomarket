/*
 * État de la configuration exposé au tableau de bord (GET /api/config).
 *
 * Sans cette route, une variable oubliée ne se voyait qu'au moment du clic :
 * l'utilisateur lançait une génération IA et recevait une erreur sans jamais
 * apprendre que le fournisseur n'avait jamais été configuré. Ces tests
 * verrouillent trois choses : la liste des variables manquantes est déduite de
 * l'état réel, la base locale est distinguée d'une base distante, et AUCUNE
 * valeur secrète ne sort de l'API.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-config-')), 'config.db');
const ADMIN_KEY = 'cle-de-test-config-0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;

/* Ce fichier teste la configuration, pas la machine qui l'exécute : toute
   variable héritée du shell (ou d'un .env de développement) est neutralisée
   avant l'import, sinon un « rien de configuré » dépendrait de l'environnement. */
const AI_KEYS = ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'];
const OWN_SITE_KEYS = ['OWN_SITE_API_URL', 'OWN_SITE_API_KEY'];
const EBAY_KEYS = ['EBAY_ENV', 'EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_DEV_ID', 'EBAY_REFRESH_TOKEN', 'EBAY_MERCHANT_LOCATION_KEY'];

function resetEnv() {
  for (const key of [...AI_KEYS, ...OWN_SITE_KEYS, ...EBAY_KEYS]) delete process.env[key];
}

// La base doit rester locale : on ne teste jamais sur la production.
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
resetEnv();

const { app } = await import('../src/server.js');
const { initDatabase } = await import('../src/db/database.js');
const { describeDatabaseConfig } = await import('../src/routes/api.js');

let server;
let base;

async function getConfig(headers = { 'X-Admin-Key': ADMIN_KEY }) {
  const response = await fetch(base + '/api/config', { headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, text, body };
}

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  resetEnv();
  await new Promise((resolve) => server.close(resolve));
});

/* ===================== RIEN DE CONFIGURÉ ===================== */

test('sans aucune variable, chaque variable manquante est nommée', async () => {
  resetEnv();
  const { status, body } = await getConfig();

  assert.equal(status, 200);
  assert.deepEqual(body.database, { persistent: false, host: null }, 'la base de test est un fichier local');
  assert.equal(body.access.protected, true);
  assert.deepEqual(body.channels, {
    ebay: false,
    own_site: false,
    amazon: false,
    tiktok_shop: false,
    allegro: false,
  });

  assert.equal(body.ai.configured, false);
  assert.equal(body.ai.provider, null);
  assert.equal(body.ai.model, null);
  assert.match(body.ai.reason, /Aucun fournisseur IA/, 'la raison doit être affichable telle quelle');

  // La formulation exacte de l'alternative Anthropic / compatible OpenAI.
  assert.ok(body.missing.includes('ANTHROPIC_API_KEY (ou AI_BASE_URL + AI_API_KEY + AI_MODEL)'));
  assert.ok(
    body.missing.some((entry) => entry.includes('OWN_SITE_API_URL') && entry.includes('OWN_SITE_API_KEY')),
    'le canal site propre doit nommer ses deux variables',
  );
  // eBay est un canal optionnel : son absence ne doit PAS figurer parmi les
  // manques, sinon le bandeau d'état resterait orange à jamais, y compris quand
  // tout ce dont on a besoin est en place. Son état reste lisible dans
  // channels.ebay, qui est une information et non une alerte.
  assert.equal(body.channels.ebay, false, 'eBay non configuré reste visible comme information');
  assert.ok(
    !body.missing.some((entry) => /EBAY_/.test(entry)),
    'eBay ne doit pas compter parmi les manques bloquants',
  );
});

test('la route est derrière la clé, comme le reste du back-office', async () => {
  const anonymous = await getConfig({});
  assert.equal(anonymous.status, 401);
});

/* ===================== IA CONFIGURÉE ===================== */

test('fournisseur IA configuré : l’IA sort de la liste des manques', async () => {
  resetEnv();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-faux-jeton-de-test';
  try {
    const { body } = await getConfig();
    assert.equal(body.ai.configured, true);
    assert.equal(body.ai.provider, 'anthropic');
    assert.equal(body.ai.model, 'claude-sonnet-5', 'le modèle par défaut doit être annoncé');
    assert.equal(body.ai.reason, null);
    assert.ok(!body.missing.some((entry) => /ANTHROPIC_API_KEY|AI_BASE_URL|AI_MODEL/.test(entry)));

    // Les canaux sans rapport restent, eux, bien signalés.
    assert.ok(body.missing.some((entry) => entry.includes('OWN_SITE_API_URL')));
    assert.equal(body.channels.own_site, false);
  } finally {
    resetEnv();
  }
});

test('fournisseur compatible OpenAI : seule la variable réellement absente est nommée', async () => {
  resetEnv();
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_BASE_URL = 'https://api.groq.com/openai/v1';
  process.env.AI_API_KEY = 'cle-fournisseur-de-test';
  try {
    const { body } = await getConfig();
    assert.equal(body.ai.configured, false);
    assert.equal(body.ai.provider, 'openai');
    // AI_MODEL n'a volontairement aucun défaut : c'est donc LUI qui manque.
    assert.ok(body.missing.includes('AI_MODEL'), body.missing.join(' | '));
    assert.ok(!body.missing.some((entry) => entry.includes('AI_BASE_URL')));
  } finally {
    resetEnv();
  }
});

/* ===================== SITE PROPRE CONFIGURÉ ===================== */

test('site propre configuré : le canal passe à vrai et sa variable quitte la liste', async () => {
  resetEnv();
  process.env.OWN_SITE_API_URL = 'https://boutique.example.com';
  process.env.OWN_SITE_API_KEY = 'jeton-site-de-test';
  try {
    const { body } = await getConfig();
    assert.equal(body.channels.own_site, true);
    assert.equal(body.channels.ebay, false);
    assert.ok(!body.missing.some((entry) => entry.includes('OWN_SITE_')), 'plus rien à signaler pour le site');
    // eBay est optionnel : il n'apparaît pas dans les manques, seulement comme
    // canal non configuré.
    assert.equal(body.channels.ebay, false);
    assert.ok(!body.missing.some((entry) => entry.includes('EBAY_')), 'eBay est un canal optionnel');
  } finally {
    resetEnv();
  }
});

/* ===================== BASE LOCALE OU DISTANTE ===================== */

test('base locale et base distante sont distinguées, sans jamais montrer le jeton', () => {
  // Locale : les données sont perdues à chaque redéploiement.
  assert.deepEqual(describeDatabaseConfig('file:./data/megalomarket.db'), { persistent: false, host: null });
  assert.deepEqual(describeDatabaseConfig('file:/tmp/megalomarket.db'), { persistent: false, host: null });

  // Distante : on ne garde que l'hôte, jamais l'adresse complète.
  assert.deepEqual(describeDatabaseConfig('libsql://megalomarket-abc123.turso.io'), {
    persistent: true,
    host: 'megalomarket-abc123.turso.io',
  });
  assert.deepEqual(describeDatabaseConfig('https://megalomarket-abc123.turso.io'), {
    persistent: true,
    host: 'megalomarket-abc123.turso.io',
  });

  // Un jeton glissé dans la requête ne doit pas ressortir par l'hôte.
  const withToken = describeDatabaseConfig('libsql://megalomarket-abc123.turso.io?authToken=jeton-interdit');
  assert.equal(withToken.host, 'megalomarket-abc123.turso.io');
  assert.ok(!JSON.stringify(withToken).includes('jeton-interdit'));

  // Adresse illisible : on ne plante pas et on ne devine pas l'hôte.
  assert.deepEqual(describeDatabaseConfig('pas-une-adresse'), { persistent: true, host: null });
});

/* ===================== AUCUN SECRET NE SORT ===================== */

test('aucune valeur secrète n’apparaît, même quand tout est configuré', async () => {
  resetEnv();
  const secrets = {
    ANTHROPIC_API_KEY: 'sk-ant-secret-aaaaaaaaaaaaaaaa',
    OWN_SITE_API_URL: 'https://boutique.example.com',
    OWN_SITE_API_KEY: 'site-secret-bbbbbbbbbbbbbb',
    EBAY_APP_ID: 'ebay-app-cccccccc',
    EBAY_CERT_ID: 'ebay-cert-secret-dddddddd',
    EBAY_DEV_ID: 'ebay-dev-eeeeeeee',
    EBAY_REFRESH_TOKEN: 'ebay-refresh-secret-ffffffff',
  };
  Object.assign(process.env, secrets);
  try {
    const { body, text } = await getConfig();

    assert.equal(body.missing.length, 0, 'tout est configuré : la liste des manques doit être vide');
    assert.equal(body.ai.configured, true);
    assert.equal(body.channels.own_site, true);
    assert.equal(body.channels.ebay, true);

    for (const [key, value] of Object.entries(secrets)) {
      assert.ok(!text.includes(value), `la valeur de ${key} ne doit jamais apparaître dans la réponse`);
    }
    assert.ok(!text.includes(ADMIN_KEY), "la clé d'administration ne doit jamais apparaître");
    assert.ok(!/secret-/.test(text), 'aucun fragment de secret ne doit subsister');
  } finally {
    resetEnv();
  }
});
