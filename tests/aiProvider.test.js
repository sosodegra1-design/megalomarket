/* Le fournisseur IA était figé sur Anthropic. Ces tests verrouillent la
 * résolution automatique (Anthropic si sa clé existe, sinon compatible OpenAI),
 * la priorité d'un AI_PROVIDER explicite, et la requête réellement envoyée au
 * chemin compatible OpenAI — celui qui permet de tourner sur un palier gratuit
 * (Groq, Cerebras, OpenRouter, Gemini, Ollama local).
 *
 * Aucun réseau : global.fetch est remplacé, comme dans tests/ownSite.test.js.
 * Les cas de résolution tournent dans un processus neuf, car config/env.js lit
 * process.env au moment de l'import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ce fichier teste le chemin compatible OpenAI : on l'installe avant d'importer
// quoi que ce soit, et on retire ANTHROPIC_API_KEY pour qu'une variable d'un
// développeur ne fasse pas basculer la résolution sur Anthropic.
process.env.AI_BASE_URL = 'https://api.groq.com/openai/v1';
process.env.AI_API_KEY = 'cle-de-test';
process.env.AI_MODEL = 'llama-3.3-70b-versatile';
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;

const client = await import('../src/ai/client.js');
const { config } = await import('../src/config/env.js');

const AI_ENV_KEYS = ['AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'];

// Un cwd vide et temporaire : dotenv/config lit « .env » depuis le répertoire
// courant, et un .env local fausserait la résolution que ces tests vérifient.
const tempCwd = mkdtempSync(join(tmpdir(), 'megalomarket-ai-'));
process.on('exit', () => rmSync(tempCwd, { recursive: true, force: true }));

/** Environnement sans aucune variable IA, puis les surcharges demandées. */
function freshEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of AI_ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}

function runNode(script, overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: freshEnv(overrides),
    cwd: tempCwd,
  });
}

const ENV_URL = new URL('../src/config/env.js', import.meta.url).href;
const CLIENT_URL = new URL('../src/ai/client.js', import.meta.url).href;

/** Imprime l'état IA résolu dans un processus neuf. */
const PRINT_STATE = `
  const { config } = await import(${JSON.stringify(ENV_URL)});
  process.stdout.write(JSON.stringify({
    provider: config.ai.provider,
    baseUrl: config.ai.baseUrl,
    model: config.ai.model,
    ready: config.ai.ready,
    reason: config.ai.reason,
  }));
`;

function readState(overrides) {
  const run = runNode(PRINT_STATE, overrides);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

/* Le même helper de stub que tests/ownSite.test.js : une seule façon de mentir
   sur le réseau dans ce dépôt. */
function mockFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(call);
    const result = handler(call) || {};
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.json ?? {},
      text: async () => result.text ?? JSON.stringify(result.json ?? {}),
    };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('ANTHROPIC_API_KEY alone selects the anthropic provider', () => {
  const state = readState({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  assert.equal(state.provider, 'anthropic');
  assert.equal(state.ready, true);
  assert.equal(state.reason, null);
  // Modèle historique conservé : rien ne change pour une installation existante.
  assert.equal(state.model, 'claude-sonnet-5');
});

test('AI_BASE_URL + AI_API_KEY + AI_MODEL alone select the openai provider', () => {
  const state = readState({
    AI_BASE_URL: 'https://api.cerebras.ai/v1',
    AI_API_KEY: 'csk-test',
    AI_MODEL: 'llama3.1-8b',
  });
  assert.equal(state.provider, 'openai');
  assert.equal(state.baseUrl, 'https://api.cerebras.ai/v1');
  assert.equal(state.model, 'llama3.1-8b');
  assert.equal(state.ready, true);
  assert.equal(state.reason, null);
});

test('an explicit AI_PROVIDER wins over auto-detection', () => {
  // Anthropic imposé alors qu'une clé compatible OpenAI est aussi présente.
  const anthropic = readState({
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    AI_BASE_URL: 'https://api.groq.com/openai/v1',
    AI_API_KEY: 'gsk-test',
    AI_MODEL: 'llama-3.3-70b-versatile',
  });
  assert.equal(anthropic.provider, 'anthropic');
  assert.equal(anthropic.model, 'claude-sonnet-5');

  // Compatible OpenAI imposé alors qu'une clé Anthropic est présente.
  const openai = readState({
    AI_PROVIDER: 'openai',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    AI_BASE_URL: 'https://api.groq.com/openai/v1',
    AI_API_KEY: 'gsk-test',
    AI_MODEL: 'llama-3.3-70b-versatile',
  });
  assert.equal(openai.provider, 'openai');
  assert.equal(openai.model, 'llama-3.3-70b-versatile');
});

test('nothing configured yields a clear error naming the variables to set', () => {
  const script = `
    const { config } = await import(${JSON.stringify(ENV_URL)});
    const { askModel } = await import(${JSON.stringify(CLIENT_URL)});
    let message = null;
    try { await askModel({ system: 's', prompt: 'p' }); } catch (error) { message = error.message; }
    process.stdout.write(JSON.stringify({ provider: config.ai.provider, ready: config.ai.ready, reason: config.ai.reason, message }));
  `;
  const run = runNode(script);
  assert.equal(run.status, 0, run.stderr);
  const state = JSON.parse(run.stdout);

  assert.equal(state.provider, null);
  assert.equal(state.ready, false);
  // La raison nomme TOUTES les variables possibles : sans cela, l'utilisateur
  // ne sait pas quel chemin configurer.
  for (const variable of ['ANTHROPIC_API_KEY', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL']) {
    assert.match(state.reason, new RegExp(variable), `la raison doit nommer ${variable}`);
  }
  // askModel refuse avant tout réseau, avec exactement cette raison.
  assert.equal(state.message, state.reason);
});

test('the OpenAI-compatible path POSTs the exact URL, header and body', async () => {
  const mock = mockFetch(() => ({ json: { choices: [{ message: { content: '{"ok":true}' } }] } }));
  try {
    const reply = await client.askModel({
      system: 'Tu réponds uniquement en JSON.',
      prompt: 'Bonjour',
      maxTokens: 321,
    });

    assert.equal(reply, '{"ok":true}');
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.Authorization, 'Bearer cle-de-test');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.body.model, 'llama-3.3-70b-versatile');
    assert.equal(call.body.max_tokens, 321);
    // Le message système vient EN PREMIER : c'est ce que les fournisseurs
    // compatibles attendent pour appliquer les consignes.
    assert.deepEqual(call.body.messages, [
      { role: 'system', content: 'Tu réponds uniquement en JSON.' },
      { role: 'user', content: 'Bonjour' },
    ]);
  } finally {
    mock.restore();
  }
});

test('a trailing slash in AI_BASE_URL does not double up', async () => {
  const previous = process.env.AI_BASE_URL;
  process.env.AI_BASE_URL = 'https://api.groq.com/openai/v1/';
  const mock = mockFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }] } }));
  try {
    await client.askModel({ system: 's', prompt: 'p' });
    assert.equal(mock.calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  } finally {
    mock.restore();
    process.env.AI_BASE_URL = previous;
  }
});

test('HTTP 429 explains the free-tier cap and keeps the provider message', async () => {
  const mock = mockFetch(() => ({
    status: 429,
    text: 'Rate limit reached for requests: 1000 requests per day',
  }));
  try {
    await assert.rejects(
      () => client.askModel({ system: 's', prompt: 'p' }),
      (error) => {
        assert.match(error.message, /429/);
        // Un palier gratuit plafonne par minute et par jour : l'erreur doit le
        // dire, sinon l'utilisateur relance en boucle en croyant à une panne.
        assert.match(error.message, /palier|quota/i);
        assert.match(error.message, /attends/i);
        // Le message du fournisseur n'est jamais avalé : c'est lui qui donne la
        // cause exacte (quel quota, quel modèle…).
        assert.match(error.message, /1000 requests per day/);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test('HTTP 401/403 name AI_API_KEY and keep the provider message', async () => {
  for (const status of [401, 403]) {
    const mock = mockFetch(() => ({ status, text: 'invalid api key' }));
    try {
      await assert.rejects(
        () => client.askModel({ system: 's', prompt: 'p' }),
        (error) => {
          assert.match(error.message, new RegExp(`HTTP ${status}`));
          assert.match(error.message, /AI_API_KEY/);
          assert.match(error.message, /invalid api key/);
          return true;
        },
      );
    } finally {
      mock.restore();
    }
  }
});

test('a missing AI_MODEL on the openai provider is reported clearly', async () => {
  const previous = process.env.AI_MODEL;
  delete process.env.AI_MODEL;
  const mock = mockFetch(() => { throw new Error('aucun appel réseau ne doit partir sans modèle'); });
  try {
    assert.equal(config.ai.ready, false);
    assert.match(config.ai.reason, /AI_MODEL/);
    await assert.rejects(
      () => client.askModel({ system: 's', prompt: 'p' }),
      /AI_MODEL/,
    );
    assert.equal(mock.calls.length, 0, 'askModel doit refuser avant tout appel réseau');
  } finally {
    mock.restore();
    process.env.AI_MODEL = previous;
  }
});

test('a reply without choices[0].message.content is rejected explicitly', async () => {
  const mock = mockFetch(() => ({ json: { error: { message: 'modèle inconnu' } } }));
  try {
    await assert.rejects(
      () => client.askModel({ system: 's', prompt: 'p' }),
      /choices\[0\]\.message\.content/,
    );
  } finally {
    mock.restore();
  }
});
