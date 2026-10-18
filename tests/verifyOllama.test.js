/*
 * Le script `npm run verify:ollama` et le délai IA configurable.
 * Un faux Ollama local (HTTP) répond aux routes /api/tags et /v1/chat/completions :
 * aucun vrai modèle n'est nécessaire.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/verify-ollama.mjs', import.meta.url));

let server;
let origin;
let models = ['llama3.1:latest'];

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    } else if (req.url === '/v1/chat/completions') {
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function runScript(env) {
  // `-I` n'est pas utilisé ici : le script est celui du projet, pas un fichier téléchargé.
  return run(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, ...env },
    timeout: 20000,
  }).then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
}

const base = () => ({ AI_PROVIDER: 'openai', AI_BASE_URL: `${origin}/v1`, AI_API_KEY: 'ollama', AI_MODEL: 'llama3.1' });

test('verify:ollama passes when Ollama answers and the model is installed', async () => {
  const result = await runScript(base());
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Ollama est correctement branché/);
});

test('verify:ollama explains how to install a missing model', async () => {
  const result = await runScript({ ...base(), AI_MODEL: 'mistral' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ollama pull mistral/);
});

test('verify:ollama tells the user when Ollama is not running', async () => {
  const result = await runScript({ ...base(), AI_BASE_URL: 'http://127.0.0.1:1/v1' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Ollama ne répond pas/);
});

test('AI_TIMEOUT_MS overrides the 30 s default and ignores nonsense values', async () => {
  const { config } = await import('../src/config/env.js');
  const saved = process.env.AI_TIMEOUT_MS;
  try {
    delete process.env.AI_TIMEOUT_MS;
    assert.equal(config.ai.timeoutMs, 30000);
    process.env.AI_TIMEOUT_MS = '180000';
    assert.equal(config.ai.timeoutMs, 180000);
    process.env.AI_TIMEOUT_MS = 'abc';
    assert.equal(config.ai.timeoutMs, 30000);
    process.env.AI_TIMEOUT_MS = '';
    assert.equal(config.ai.timeoutMs, 30000);
  } finally {
    if (saved === undefined) delete process.env.AI_TIMEOUT_MS;
    else process.env.AI_TIMEOUT_MS = saved;
  }
});
