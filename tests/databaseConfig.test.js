/* Une variable d'environnement saisie dans la mauvaise case, sur la plateforme
 * d'hébergement, faisait planter le service avec une erreur libsql qui ne
 * nommait aucune variable :
 *
 *   LibsqlError: URL_INVALID: The URL 'openai/gpt-oss-120b' is not in a valid format
 *
 * Le diagnostic demandait alors de deviner laquelle des dix variables était en
 * cause. Ces tests verrouillent le contrôle qui la nomme — c'est la première
 * chose qu'on cherche quand un déploiement refuse de démarrer.
 *
 * La configuration est figée à l'import du module : chaque cas tourne donc dans
 * un processus neuf, avec les variables déjà posées.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATABASE_MODULE = new URL('../src/db/database.js', import.meta.url).href;

function runWith(env, imports = DATABASE_MODULE) {
  const assignments = Object.entries(env)
    .map(([key, value]) => (value === null
      ? `delete process.env.${key};`
      : `process.env.${key} = ${JSON.stringify(value)};`))
    .join('\n');
  const script = `
    ${assignments}
    await import(${JSON.stringify(imports)});
    process.stdout.write('importe');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

test('a value pasted into the wrong variable is named, not left cryptic', () => {
  // Le cas réel : la valeur de AI_MODEL avait atterri dans TURSO_DATABASE_URL.
  const run = runWith({ TURSO_DATABASE_URL: 'openai/gpt-oss-120b' });
  assert.notEqual(run.status, 0, 'le service doit refuser de démarrer sur une adresse invalide');
  assert.match(run.stderr, /TURSO_DATABASE_URL n'est pas une adresse de base valide/);
  assert.match(run.stderr, /openai\/gpt-oss-120b/, 'la valeur reçue doit apparaître');
  assert.match(run.stderr, /libsql:\/\//, 'les formats attendus doivent être rappelés');
  assert.match(run.stderr, /vide TURSO_DATABASE_URL/, 'la sortie de secours doit être indiquée');
});

test('a remote database without its token is reported before connecting', () => {
  const run = runWith({ TURSO_DATABASE_URL: 'libsql://exemple.turso.io', TURSO_AUTH_TOKEN: null });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /TURSO_AUTH_TOKEN est absente/);
  assert.match(run.stderr, /TURSO_DATABASE_URL/, 'la variable complémentaire doit être nommée');
});

test('a local file database still starts, with no configuration at all', () => {
  // Le repli local ne doit pas être bloqué par le contrôle : c'est ce qui
  // permet de lancer le projet sans rien configurer.
  const run = runWith({
    TURSO_DATABASE_URL: null,
    TURSO_AUTH_TOKEN: null,
    DATABASE_PATH: join(mkdtempSync(join(tmpdir(), 'megalomarket-dbconfig-')), 'local.db'),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'importe');
});

test('every documented protocol is accepted', () => {
  for (const url of ['libsql://exemple.turso.io', 'https://exemple.turso.io', 'file:/tmp/megalomarket-proto.db']) {
    // Un jeton est fourni pour les adresses distantes : sans lui, l'erreur
    // porterait sur le jeton et masquerait le test du protocole.
    const run = runWith({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'jeton-de-test' });
    assert.doesNotMatch(run.stderr, /adresse de base valide/, `${url} doit être accepté`);
    assert.doesNotMatch(run.stderr, /TURSO_AUTH_TOKEN est absente/, `${url} : le jeton est fourni`);
  }
});
