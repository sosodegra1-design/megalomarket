/*
 * Chaîne complète, sans clé Anthropic ni réseau externe :
 *   import (manuel) → Ollama simulé (HTTP) → fiches par canal → brouillons.
 * Vérifie aussi les garanties de la direction : verrou anti-vente à perte,
 * rien de publié sans validation humaine, LumiVita en lecture seule.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-e2e-')), 'e2e.db');
const ADMIN_KEY = 'cle-de-test-bout-en-bout-0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OWN_SITE_API_URL;
delete process.env.OWN_SITE_API_KEY;

const chatRequests = [];
const fakeOllama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      chatRequests.push(JSON.parse(body));
      const listing = (title) => ({ title, description: `Description ${title}` });
      const content = `<think>réflexion</think>${JSON.stringify({
        amazon: listing('Lampe LED 3D Amazon'),
        tiktok_shop: listing('Lampe LED 3D TikTok'),
        allegro: listing('Lampe LED 3D Allegro'),
        lumivita: listing('Lampe LED 3D LumiVita'),
      })}`;
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});
fakeOllama.listen(0, '127.0.0.1');
await once(fakeOllama, 'listening');

process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${fakeOllama.address().port}/v1`;
process.env.AI_API_KEY = 'ollama';
process.env.AI_MODEL = 'qwen3:8b';

const { app } = await import('../src/server.js');
const { initDatabase, dbAll, dbGet } = await import('../src/db/database.js');

let server;
let base;
async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fakeOllama.close(resolve));
});

test('the service is protected, and the AI is ready with Ollama only (no Anthropic key)', async () => {
  assert.equal((await fetch(base + '/api/config')).status, 401, 'sans clé : refusé');
  const { status, body } = await call('/api/config');
  assert.equal(status, 200);
  assert.equal(body.ai.configured, true);
  assert.equal(body.ai.provider, 'openai');
  assert.equal(body.channels.lumivita, true);
  assert.ok(!body.missing.some((entry) => /ANTHROPIC/.test(entry) && !/AI_BASE_URL/.test(entry)));
});

let importId;
test('a link imported manually goes through Ollama and becomes drafts for every channel', async () => {
  const created = await call('/api/imports/manual', {
    method: 'POST',
    body: { url: 'https://www.alibaba.com/product-detail/lampe_1.html', title: 'Lampe LED 3D acrylique', purchasePrice: 10, currency: 'EUR', rawDescription: 'Lampe 3D' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  importId = created.body.id;

  const generated = await call(`/api/imports/${importId}/generate`, { method: 'POST' });
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  const channels = generated.body.listings.map((l) => l.marketplace).sort();
  assert.deepEqual(channels, ['allegro', 'amazon', 'lumivita', 'tiktok_shop']);
  assert.equal(chatRequests.length, 1, 'un seul appel vers Ollama');
  assert.equal(chatRequests[0].model, 'qwen3:8b');

  const listings = await dbAll('SELECT marketplace, status, suggested_price FROM import_listings WHERE import_id = ?', [importId]);
  assert.ok(listings.every((l) => l.status === 'a_valider'), 'tout reste à valider');
  assert.ok(listings.every((l) => l.suggested_price >= 10), 'verrou anti-vente à perte : jamais sous le prix d’achat');
});

test('nothing is published without a human action', async () => {
  const published = await dbAll("SELECT id FROM import_listings WHERE status = 'publie'");
  assert.equal(published.length, 0);
});

test('a price below the purchase price is refused', async () => {
  const { status, body } = await call(`/api/imports/${importId}/listings/amazon`, { method: 'PATCH', body: { suggestedPrice: 5 } });
  assert.equal(status, 400);
  assert.match(body.error, /Vente à perte/);
});

test('even after validation, LumiVita refuses publication: read-only catalogue', async () => {
  const validated = await call(`/api/imports/${importId}/listings/lumivita`, { method: 'PATCH', body: { title: 'Lampe LumiVita validée' } });
  assert.equal(validated.status, 200);
  const publish = await call(`/api/imports/${importId}/listings/lumivita/publish`, { method: 'POST' });
  assert.ok(publish.status >= 400, 'la publication est refusée');
  assert.match(JSON.stringify(publish.body), /lecture seule/);
  const row = await dbGet("SELECT status FROM import_listings WHERE import_id = ? AND marketplace = 'lumivita'", [importId]);
  assert.notEqual(row.status, 'publie');
});

test('the LumiVita catalogue is inscribed in the database', async () => {
  const synced = await call('/api/lumivita/sync', { method: 'POST' });
  assert.equal(synced.body.total, 6);
  assert.equal((await dbAll("SELECT id FROM products WHERE sku LIKE 'LV-%'")).length, 6);
});
