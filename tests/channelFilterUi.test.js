/*
 * Quels canaux l'écran a le droit de montrer.
 *
 * Le problème constaté à l'écran : un import portait CINQ fiches (une par
 * canal), dont trois pour des canaux non configurés — amazon, tiktok_shop,
 * allegro. Ces cartes ne peuvent rien recevoir : elles encombraient l'écran et
 * laissaient croire qu'il fallait remplir des formulaires qui ne partiraient
 * nulle part.
 *
 * Ce qui est verrouillé ici :
 *  1. seuls les canaux configurés sont affichés ;
 *  2. une fiche DÉJÀ PUBLIÉE reste visible même si son canal est inactif —
 *     on ne cache jamais quelque chose qui est en ligne ;
 *  3. si l'état des canaux n'a pas pu être chargé, on n'en cache AUCUN :
 *     masquer par accident serait pire que d'afficher en trop ;
 *  4. les fiches masquées sont NOMMÉES, pas escamotées en silence.
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

function loadUi() {
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

/** `state` est un `const` de haut niveau : il n'est pas propriété du bac à sable. */
function setChannels(sandbox, liste) {
  vm.runInContext(`state.channels = ${JSON.stringify(liste)}`, sandbox);
}

function listing(marketplace, overrides = {}) {
  return {
    id: `${marketplace}-1`,
    marketplace,
    title: `Titre ${marketplace}`,
    description: 'Description de test.',
    suggested_price: 19.9,
    status: 'a_valider',
    ...overrides,
  };
}

const CANAUX_REELS = [
  { channel: 'lumivita', configured: true },
  { channel: 'own_site', configured: true },
  { channel: 'amazon', configured: false },
  { channel: 'tiktok_shop', configured: false },
  { channel: 'allegro', configured: false },
];

/* ===================== LE CAS CONSTATÉ ===================== */

test('cinq fiches, trois canaux inactifs : seules les deux actives sont rendues', () => {
  const { sandbox, node } = loadUi();
  setChannels(sandbox, CANAUX_REELS);

  sandbox.renderListings([
    listing('lumivita'),
    listing('own_site'),
    listing('amazon'),
    listing('tiktok_shop'),
    listing('allegro'),
  ]);

  const html = node('listings').innerHTML;
  assert.match(html, /Titre lumivita/);
  assert.match(html, /Titre own_site/);
  assert.ok(!html.includes('Titre amazon'), 'amazon est inactif : sa carte ne doit pas apparaître');
  assert.ok(!html.includes('Titre tiktok_shop'), 'tiktok_shop est inactif');
  assert.ok(!html.includes('Titre allegro'), 'allegro est inactif');
});

test('les fiches masquées sont NOMMÉES, pas escamotées', () => {
  const { sandbox, node } = loadUi();
  setChannels(sandbox, CANAUX_REELS);

  sandbox.renderListings([
    listing('own_site'),
    listing('amazon'),
    listing('allegro'),
  ]);

  const html = node('listings').innerHTML;
  // Une disparition silencieuse ferait chercher ce qu'on croit avoir perdu.
  assert.match(html, /2 fiche\(s\) masquée\(s\)/);
  assert.match(html, /amazon/);
  assert.match(html, /allegro/);
});

/* ===================== LA FICHE PUBLIÉE RESTE VISIBLE ===================== */

test('une fiche PUBLIÉE reste visible même si son canal est inactif', () => {
  const { sandbox, node } = loadUi();
  setChannels(sandbox, CANAUX_REELS);

  // On ne cache jamais quelque chose qui est en ligne.
  sandbox.renderListings([
    listing('own_site'),
    listing('amazon', { status: 'publie', published_external_id: 'AMZ-123' }),
  ]);

  const html = node('listings').innerHTML;
  assert.match(html, /Titre amazon/, 'une annonce publiée ne doit jamais être masquée');
  assert.match(html, /AMZ-123/);
});

/* ===================== LE MODE PRUDENT ===================== */

test('si l’état des canaux n’a pas été chargé, on ne cache RIEN', () => {
  const { sandbox, node } = loadUi();
  setChannels(sandbox, []);

  // Masquer par accident serait pire que d'afficher en trop : une panne du
  // chargement des canaux ne doit pas vider l'écran.
  sandbox.renderListings([listing('own_site'), listing('amazon')]);

  const html = node('listings').innerHTML;
  assert.match(html, /Titre own_site/);
  assert.match(html, /Titre amazon/);
  assert.ok(!html.includes('masquée'), 'aucune mention de masquage quand rien n’est masqué');
});

test('aucune fiche sur un canal actif : l’écran le dit au lieu de rester vide', () => {
  const { sandbox, node } = loadUi();
  setChannels(sandbox, CANAUX_REELS);

  sandbox.renderListings([listing('amazon'), listing('allegro')]);

  const html = node('listings').innerHTML;
  assert.match(html, /Aucune fiche sur un canal actif/);
  assert.match(html, /amazon/);
});

/* ===================== LA DESCRIPTION EST REPLIÉE ===================== */

test('la description est repliée : une carte tient en quelques lignes', () => {
  const { sandbox, node } = loadUi();
  setChannels(sandbox, CANAUX_REELS);

  sandbox.renderListings([listing('own_site')]);

  const html = node('listings').innerHTML;
  // Avec cinq canaux, cinq zones de quatre lignes faisaient défiler l'écran
  // sur plusieurs hauteurs d'écran pour un contenu rarement modifié.
  assert.match(html, /<details class="site-details"><summary>Description \(/);
  assert.match(html, /<textarea[^>]*id="d-own_site-1"/, 'le champ reste présent, simplement replié');
});
