/**
 * Démarrage automatique sur macOS (launchd).
 *
 * Trois agents utilisateur, lancés à l'ouverture de session et relancés s'ils
 * s'arrêtent : le serveur Megalomarket, le surveillant de favoris Chrome et, toutes les heures,
 * le rapport d'état.
 * Ollama a son propre démarrage (réglage « Ouvrir à la connexion » de l'app).
 * Le surveillant attend le serveur lui-même (voir scripts/watch-bookmarks.mjs),
 * l'ordre de lancement n'a donc aucune importance.
 */

export const SERVER_LABEL = 'com.megalomarket.server';
export const WATCHER_LABEL = 'com.megalomarket.watcher';
export const REPORT_LABEL = 'com.megalomarket.report';

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildPlist({ label, nodePath, script, scriptArgs = [], interval = null, workingDir, logDir, pathEnv }) {
  const args = [nodePath, script, ...scriptArgs].map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
${interval
    ? `  <key>StartInterval</key>
  <integer>${Number(interval)}</integer>`
    : `  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>`}
  <key>StandardOutPath</key>
  <string>${escapeXml(`${logDir}/${label}.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(`${logDir}/${label}.err.log`)}</string>
</dict>
</plist>
`;
}

export function buildAgents({ nodePath, projectDir, logDir }) {
  const pathEnv = `${nodePath.replace(/\/[^/]+$/, '')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return [
    { label: SERVER_LABEL, script: `${projectDir}/src/server.js` },
    { label: WATCHER_LABEL, script: `${projectDir}/scripts/watch-bookmarks.mjs` },
    // Rapport toutes les heures, publié sur la branche « rapports » (ponctuel, pas un service).
    { label: REPORT_LABEL, script: `${projectDir}/scripts/report.mjs`, scriptArgs: ['--push'], interval: 3600 },
  ].map((agent) => ({
    ...agent,
    plist: buildPlist({ ...agent, nodePath, workingDir: projectDir, logDir, pathEnv }),
  }));
}
