/**
 * Démarrage automatique sur macOS (launchd).
 *
 * Deux agents utilisateur, lancés à l'ouverture de session et relancés s'ils
 * s'arrêtent : le serveur Megalomarket, et le surveillant de favoris Chrome.
 * Ollama a son propre démarrage (réglage « Ouvrir à la connexion » de l'app).
 * Le surveillant attend le serveur lui-même (voir scripts/watch-bookmarks.mjs),
 * l'ordre de lancement n'a donc aucune importance.
 */

export const SERVER_LABEL = 'com.megalomarket.server';
export const WATCHER_LABEL = 'com.megalomarket.watcher';

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildPlist({ label, nodePath, script, workingDir, logDir, pathEnv }) {
  const args = [nodePath, script].map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
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
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
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
  ].map((agent) => ({
    ...agent,
    plist: buildPlist({ ...agent, nodePath, workingDir: projectDir, logDir, pathEnv }),
  }));
}
