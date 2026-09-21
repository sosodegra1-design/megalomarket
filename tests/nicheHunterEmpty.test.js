/* Cas vide de src/ai/nicheHunter.js, isolé dans son propre fichier : la base
   doit être fraîche (aucune chasse jamais lancée), ce qu'un fichier partageant
   son serveur avec d'autres tests ne peut pas garantir. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-niches-empty-')), 'empty.db');

const { initDatabase } = await import('../src/db/database.js');
const { latestFinds } = await import('../src/ai/nicheHunter.js');

test('latestFinds() sans aucune chasse préalable renvoie un lot vide', async () => {
  await initDatabase();
  const result = await latestFinds();
  assert.equal(result.batchId, null);
  assert.deepEqual(result.finds, []);
});
