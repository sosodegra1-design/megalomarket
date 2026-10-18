/*
 * Installe (ou retire) le démarrage automatique de Megalomarket sur macOS.
 *
 *   npm run autostart:install      installe et démarre le serveur + le surveillant
 *   npm run autostart:uninstall    arrête et retire les deux agents
 *   npm run autostart:install -- --dry-run   affiche ce qui serait écrit, sans rien toucher
 *
 * Journaux : ~/Library/Logs/Megalomarket/
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgents } from '../src/services/autostart.js';

const uninstall = process.argv.includes('--uninstall');
const dryRun = process.argv.includes('--dry-run');
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(homedir(), 'Library/LaunchAgents');
const logDir = join(homedir(), 'Library/Logs/Megalomarket');
const domain = `gui/${process.getuid()}`;

if (process.platform !== 'darwin' && !dryRun) {
  console.error('Le démarrage automatique par launchd ne fonctionne que sur macOS.');
  process.exit(1);
}

const agents = buildAgents({ nodePath: process.execPath, projectDir, logDir });
const launchctl = (...args) => execFileSync('launchctl', args, { stdio: 'pipe' }).toString();
const quietly = (fn) => { try { fn(); } catch { /* l'agent n'était pas chargé : rien à arrêter */ } };

if (dryRun) {
  for (const agent of agents) console.log(`--- ${join(agentsDir, `${agent.label}.plist`)}\n${agent.plist}`);
  process.exit(0);
}

if (uninstall) {
  for (const { label } of agents) {
    quietly(() => launchctl('bootout', `${domain}/${label}`));
    const file = join(agentsDir, `${label}.plist`);
    if (existsSync(file)) unlinkSync(file);
    console.log(`  ✓ ${label} retiré`);
  }
  process.exit(0);
}

if (!existsSync(join(projectDir, '.env'))) {
  console.error('Fichier .env introuvable : copie .env.example en .env et remplis-le avant d\'installer le démarrage automatique.');
  process.exit(1);
}

mkdirSync(agentsDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
for (const { label, plist } of agents) {
  const file = join(agentsDir, `${label}.plist`);
  writeFileSync(file, plist);
  quietly(() => launchctl('bootout', `${domain}/${label}`));
  launchctl('bootstrap', domain, file);
  launchctl('kickstart', '-k', `${domain}/${label}`);
  console.log(`  ✓ ${label} installé et démarré`);
}
console.log(`\nJournaux : ${logDir}\nContrôle : npm run doctor`);
