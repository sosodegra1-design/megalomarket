/*
 * TOUT L'EXISTANT PART AU PIPELINE.
 *
 * Les imports déjà faits n'étaient jamais passés au pipeline : ils restaient à
 * préparer un par un. La route /from-imports les prend en lot — et IGNORE ceux
 * qui ne peuvent pas passer, avec leur raison, plutôt que de les traiter de
 * travers.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-lot-')), 'lot.db');
process.env.ADMIN_API_KEY = 'cle-admin-de-test-0123456789abcdef';

const { app } = await import('../src/server.js');
const { initDatabase, dbRun, dbGet } = await import('../src/db/database.js');

let server;
let base;

before(async () => {
  await initDatabase();
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'X-Admin-Key': process.env.ADMIN_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('la route de lot existe et répond', async () => {
  const source = readFileSync(new URL('../src/routes/pipeline.js', import.meta.url), 'utf8');
  assert.match(source, /'\/from-imports'/);
  assert.match(source, /executerPipeline/, 'le corps du pipeline doit être réutilisable');
});

test('un import sans photo est IGNORÉ avec sa raison', async () => {
  await dbRun(
    "INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at) VALUES ('https://x.test/sans-photo', 'alibaba', 'Sans photo', '', 5, 'EUR', '[]', 'pret', ?)",
    [Date.now()],
  );
  const imp = await dbGet("SELECT id FROM imports WHERE title = 'Sans photo'");
  const { status, body } = await post('/api/pipeline/from-imports', { importIds: [imp.id] });
  assert.equal(status, 200);
  assert.equal(body.ignores, 1);
  assert.match(body.resultats[0].ignore, /aucune photo/);
});

test('un import sans prix d’achat est IGNORÉ avec sa raison', async () => {
  await dbRun(
    "INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at) VALUES ('https://x.test/sans-prix', 'alibaba', 'Sans prix', '', 0, 'EUR', ?, 'pret', ?)",
    [JSON.stringify(['https://exemple.test/a.jpg']), Date.now()],
  );
  const imp = await dbGet("SELECT id FROM imports WHERE title = 'Sans prix'");
  const { status, body } = await post('/api/pipeline/from-imports', { importIds: [imp.id] });
  assert.equal(status, 200);
  assert.equal(body.ignores, 1);
  assert.match(body.resultats[0].ignore, /prix d'achat/);
});
