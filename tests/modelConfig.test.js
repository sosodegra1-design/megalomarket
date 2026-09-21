/* Le modèle IA était écrit en dur dans le code. Anthropic retire régulièrement
 * d'anciens modèles — et un modèle retiré fait échouer TOUS les appels IA,
 * silencieusement côté utilisateur (import, prix, descriptions, support).
 * claude-sonnet-4-5, le choix précédent, n'était plus garanti au-delà du
 * 29 septembre 2026. Ces tests verrouillent le remplacement et la possibilité
 * de changer de modèle sans toucher au code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const { config } = await import('../src/config/env.js');

test('the default model is a current one, not the retired-soon placeholder', () => {
  assert.equal(typeof config.anthropicModel, 'string');
  assert.match(config.anthropicModel, /^claude-/);
  assert.equal(
    config.anthropicModel,
    'claude-sonnet-5',
    'claude-sonnet-4-5 n\'est plus garanti au-delà du 29/09/2026',
  );
});

test('no AI call can fall back to a hard-coded model id', async () => {
  // Une régression consisterait à réintroduire un identifiant en dur dans
  // client.js : on vérifie que l'appel lit bien la configuration.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/ai/client.js', import.meta.url), 'utf8');
  assert.match(source, /model:\s*config\.anthropicModel/);
  assert.doesNotMatch(source, /model:\s*['"]claude-/, 'aucun identifiant de modèle en dur');
});

test('ANTHROPIC_MODEL overrides the default without a code change', () => {
  // config est figée à l'import : la surcharge ne peut se vérifier que dans un
  // processus neuf, qui importe le module avec la variable déjà posée.
  const script = `
    process.env.ANTHROPIC_MODEL = 'claude-modele-de-test';
    const { config } = await import(${JSON.stringify(new URL('../src/config/env.js', import.meta.url).href)});
    process.stdout.write(config.anthropicModel);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'claude-modele-de-test');
});

test('every AI caller goes through the shared client', async () => {
  // Si un module appelait l'API Anthropic directement, il contournerait à la
  // fois le modèle configuré, le fournisseur choisi et la lecture tolérante du
  // JSON. Le point d'entrée s'appelle désormais askModel (et non plus
  // askClaude) : le nom doit suivre le fournisseur configurable.
  const { readFileSync } = await import('node:fs');
  for (const file of ['priceOptimizer.js', 'descriptionWriter.js', 'supportAgent.js']) {
    const source = readFileSync(new URL(`../src/ai/${file}`, import.meta.url), 'utf8');
    assert.match(source, /askModel/, `${file} doit passer par askModel`);
    assert.doesNotMatch(source, /askClaude/, `${file} ne doit plus référencer l'ancien nom`);
    assert.doesNotMatch(source, /messages\.create/, `${file} ne doit pas appeler l'API directement`);
  }
  const generator = readFileSync(new URL('../src/importer/listingGenerator.js', import.meta.url), 'utf8');
  assert.match(generator, /askModel/);
  assert.doesNotMatch(generator, /askClaude/);
  assert.doesNotMatch(generator, /messages\.create/);
  // listingGenerator appelle le point d'entrée deux fois (marketplaces + site
  // propre) : les deux doivent passer par le client partagé.
  assert.equal(
    (generator.match(/askModel\(/g) || []).length,
    2,
    'listingGenerator doit appeler askModel pour les marketplaces ET pour le site propre',
  );
});
