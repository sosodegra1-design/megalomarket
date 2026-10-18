/*
 * Rapport d'état.
 *
 *   npm run report          affiche le rapport et l'enregistre dans data/rapport.md
 *   npm run report:push     idem, et le publie sur la branche « rapports » du dépôt
 *                           (lisible à distance ; ne contient aucun secret)
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../src/config/env.js';
import { buildReport, publishReport } from '../src/services/report.js';
import { loadSeen } from '../src/services/bookmarks.js';

const SERVER = (process.env.MEGALOMARKET_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const headers = { 'X-Admin-Key': config.admin.apiKey || '' };

async function getJson(url, options = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), ...options });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const health = await getJson(`${SERVER}/api/health`);
const server = { up: health !== null };
const data = { server };

if (server.up) {
  data.config = await getJson(`${SERVER}/api/config`, { headers });
  data.imports = await getJson(`${SERVER}/api/imports`, { headers });
  data.activity = await getJson(`${SERVER}/api/activity`, { headers });
}

if (config.ai.ready && config.ai.provider === 'openai') {
  const tags = await getJson(`${new URL(config.ai.baseUrl).origin}/api/tags`);
  data.ollama = {
    up: tags !== null,
    models: tags?.models?.map((m) => m.name) ?? [],
    wanted: [...new Set([config.ai.model, config.ai.visionModel].filter(Boolean))],
  };
}
data.watcher = { seen: (await loadSeen(process.env.BOOKMARKS_STATE_PATH || './data/bookmarks-seen.json')).size };

const { text } = buildReport(data);
mkdirSync('./data', { recursive: true });
writeFileSync('./data/rapport.md', text);
console.log(text);

if (process.argv.includes('--push')) {
  try {
    publishReport({ cwd: process.cwd(), content: text });
    console.log('Rapport publié sur la branche « rapports ».');
  } catch (error) {
    console.error(`Publication impossible : ${error.stderr?.toString().trim() || error.message}`);
    process.exit(1);
  }
}
