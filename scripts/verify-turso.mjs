/*
 * Vérifie — AVANT de déployer — que TURSO_DATABASE_URL et TURSO_AUTH_TOKEN
 * désignent bien une base joignable.
 *
 * Sans ce contrôle, deux valeurs croisées entre ces variables ne se voient
 * qu'après un déploiement complet, dans le journal de la plateforme, et le
 * service refuse de démarrer. C'est plusieurs minutes perdues par tentative,
 * pour une erreur qui se détecte en une seconde en local.
 *
 *   TURSO_DATABASE_URL='libsql://…' TURSO_AUTH_TOKEN='eyJ…' \
 *     node scripts/verify-turso.mjs
 *
 * Le fichier .env est lu s'il existe : on peut donc aussi se contenter de
 * lancer `node scripts/verify-turso.mjs` après y avoir collé les valeurs.
 */

import 'dotenv/config';
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN ?? '';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/* Les jetons Turso sont des JWT : ils commencent toujours par « eyJ ». Le
   contrôle de forme attrape les deux erreurs de saisie les plus courantes —
   les valeurs croisées, et un jeton d'une autre base — avant tout appel
   réseau, donc avec un message qui dit quoi corriger. */
if (!url) fail("TURSO_DATABASE_URL n'est pas définie.");
if (!authToken) fail("TURSO_AUTH_TOKEN n'est pas définie.");
if (/^(libsql|https?|wss?):\/\//i.test(authToken)) {
  fail("TURSO_AUTH_TOKEN contient une ADRESSE : les deux valeurs sont croisées ou décalées.");
}
if (authToken !== authToken.trim()) {
  fail("TURSO_AUTH_TOKEN commence ou finit par un blanc : un espace ou un retour à la ligne s'est glissé au copier-coller.");
}
if (!authToken.startsWith('eyJ')) {
  console.warn("  ! TURSO_AUTH_TOKEN ne commence pas par « eyJ » : ce n'est peut-être pas un jeton Turso.");
}
if (!url.startsWith('libsql:') && !url.startsWith('https:') && !url.startsWith('file:')) {
  console.warn(`  ! L'adresse ne commence pas par libsql:// ni https:// (reçu : ${url.slice(0, 40)}).`);
}

console.log(`  Adresse    : ${url}`);
console.log(`  Jeton      : ${authToken.slice(0, 6)}… (${authToken.length} caractères)`);
console.log('  Connexion…');

const client = createClient({ url, authToken });

try {
  const probe = await client.execute('SELECT 1 AS ok');
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const names = tables.rows.map((row) => row.name);

  console.log(`\n  ✓ Connexion réussie (${probe.rows.length} ligne de test).`);
  console.log(`  Tables présentes : ${names.length ? names.join(', ') : '(aucune — base neuve)'}`);
  console.log('\n  Ces deux valeurs peuvent être recopiées telles quelles dans la plateforme.\n');
} catch (error) {
  const status = error?.cause?.status ?? error?.status;
  console.error(`\n  ✗ Connexion refusée${status ? ` (HTTP ${status})` : ''} : ${error.message}`);
  console.error('\n  Pistes :');
  console.error("   - l'adresse doit être recopiée depuis la page de la base (elle contient la région, ex. .aws-eu-west-1.turso.io)");
  console.error('   - le jeton doit être créé pour CETTE base : bouton « Create Token », ou « turso db tokens create <base> »');
  console.error('   - un jeton révoqué, ou destiné à une autre base, est refusé exactement de la même façon\n');
  process.exit(1);
} finally {
  // close() ne renvoie pas toujours une promesse selon la version : on
  // l'entoure plutôt que d'enchaîner un .catch() qui planterait.
  try {
    await client.close();
  } catch {
    /* la fermeture a échoué : sans conséquence pour ce script de diagnostic */
  }
}
