/*
 * POST /api/imports/:id/inspect-images — contrôle visuel IA des photos d'UN
 * import, sur demande explicite (jamais automatique, jamais bloquant pour la
 * publication).
 *
 * Bug de production corrigé : une photo de câble USB s'était retrouvée dans
 * la galerie d'un blender publié, sans qu'aucun contrôle ne l'ait repérée —
 * l'agent de contrôle visuel (src/ai/visionInspector.js) existait déjà dans
 * le code mais n'était câblé que sur le pipeline Dénicheur, jamais sur ce
 * flux d'import par URL fournisseur. Cette route corrige ça en le rendant
 * disponible ici aussi.
 *
 * inspectImages() n'utilise le SDK Anthropic (node-fetch interne, pas
 * global.fetch — voir askVision dans src/ai/client.js) que pour l'appel
 * modèle final : tout ce qui précède (image absente/injoignable/type MIME
 * invalide, ANTHROPIC_API_KEY manquante) est testable ici sans y toucher, en
 * stubant seulement global.fetch pour la récupération des images elles-mêmes.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-inspect-images-')), 'inspect.db');
const ADMIN_KEY = 'cle-de-test-inspect-images-0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../src/server.js');
const { initDatabase, dbRun } = await import('../src/db/database.js');

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

async function createImport({ title = 'Blendeur extracteur de jus 12 lames USB', imageUrls = [] } = {}) {
  const info = await dbRun(
    `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'brouillon', ?)`,
    [
      'https://supplier.example/item/1.html',
      'aliexpress',
      title,
      'Un blendeur puissant',
      9.9,
      'USD',
      JSON.stringify(imageUrls),
      Date.now(),
    ],
  );
  return info.lastInsertRowid;
}

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('la route exige la clé admin', async () => {
  const response = await fetch(base + '/api/imports/1/inspect-images', { method: 'POST' });
  assert.equal(response.status, 401);
});

test('un import inconnu est signalé clairement', async () => {
  const { status, body } = await call('/api/imports/999999/inspect-images', { method: 'POST' });
  assert.equal(status, 400);
  assert.match(body.error, /introuvable/i);
});

test('un import sans aucune photo renvoie un verdict explicite, sans appel réseau', async () => {
  const id = await createImport({ imageUrls: [] });
  const { status, body } = await call(`/api/imports/${id}/inspect-images`, { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(body.overallOk, false);
  assert.match(body.summary, /Aucune image fournie/);
});

test('une photo injoignable fait échouer le lot avec le détail de l\'échec', async () => {
  const id = await createImport({ imageUrls: ['https://supplier.example/cable-usb-sans-rapport.jpg'] });
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('cable-usb-sans-rapport')) {
      return { ok: false, status: 404, headers: new Headers(), text: async () => 'not found' };
    }
    return original(url, options);
  };
  let result;
  try {
    result = await call(`/api/imports/${id}/inspect-images`, { method: 'POST' });
  } finally {
    global.fetch = original;
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.overallOk, false);
  assert.match(result.body.summary, /inaccessible|HTTP 404/);
});

test('des photos valides sans ANTHROPIC_API_KEY échouent avec un message explicite (pas de faux positif silencieux)', async () => {
  const id = await createImport({
    imageUrls: ['https://supplier.example/blender-1.jpg', 'https://supplier.example/blender-2.jpg'],
  });
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://supplier.example/blender-')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
    return original(url, options);
  };
  let result;
  try {
    result = await call(`/api/imports/${id}/inspect-images`, { method: 'POST' });
  } finally {
    global.fetch = original;
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.overallOk, false);
  assert.match(result.body.summary, /ANTHROPIC_API_KEY/);
});
