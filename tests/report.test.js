import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, publishReport } from '../src/services/report.js';

test('a healthy system reports nothing to flag', () => {
  const { text, problems } = buildReport({
    server: { up: true },
    ollama: { up: true, models: ['qwen3:8b', 'llama3.2-vision:latest'], wanted: ['qwen3:8b', 'llama3.2-vision'] },
    config: { ai: { configured: true }, channels: { lumivita: true } },
    imports: [{ id: 1, title: 'Lampe', source_site: 'alibaba', status: 'pret' }],
    activity: [{ kind: 'IMPORT_CREE', message: 'Produit importé' }],
    watcher: { seen: 3 },
  });
  assert.deepEqual(problems, []);
  assert.match(text, /Rien à signaler/);
  assert.match(text, /Serveur : en ligne/);
});

test('failures are listed in the summary', () => {
  const { text, problems } = buildReport({
    server: { up: true },
    ollama: { up: false, models: [], wanted: ['qwen3:8b'] },
    config: { ai: { configured: false }, channels: {} },
    imports: [{ id: 2, title: 'X', source_site: 'alibaba', status: 'brouillon' }],
    activity: [{ kind: 'ERREUR_SYNC', message: 'Échec' }],
  });
  assert.ok(problems.includes('Ollama hors ligne'));
  assert.ok(problems.includes('1 import(s) sans fiches générées'));
  assert.ok(problems.includes('1 erreur(s) dans le journal récent'));
  assert.match(text, /À regarder/);
});

test('the report never contains a secret-looking value', () => {
  const { text } = buildReport({ server: { up: false } });
  assert.ok(!/ADMIN_API_KEY|sk-|Bearer/.test(text));
});

test('publishReport pushes a single orphan commit to the rapports branch without touching the working tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  execFileSync('git', ['init', work], { stdio: 'pipe' });
  run(work, 'remote', 'add', 'origin', remote);

  publishReport({ cwd: work, content: '# premier' });
  publishReport({ cwd: work, content: '# second' });

  assert.equal(run(remote, 'show', 'rapports:rapport.md'), '# second');
  assert.equal(run(remote, 'rev-list', '--count', 'rapports'), '1', 'un seul commit, remplacé à chaque fois');
  assert.equal(run(work, 'status', '--porcelain'), '', 'l\'arbre de travail est intact');
});
