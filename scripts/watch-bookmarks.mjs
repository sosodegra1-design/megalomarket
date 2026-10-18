/*
 * Surveillant de favoris Chrome → Megalomarket.
 *
 * Toutes les N minutes, il lit le dossier de favoris « boîte de veille »,
 * repère les NOUVEAUX liens de sites de sourcing autorisés (Alibaba, AliExpress,
 * Showroomprivé, Veepee), puis pour chacun :
 *   1. POST /api/imports            -> extraction, import en « brouillon »
 *   2. POST /api/imports/:id/generate -> fiches par canal générées par ton IA
 *      (Ollama), statut « a_valider »
 * RIEN n'est publié : la publication reste un clic humain dans le tableau de bord.
 * Un lien en échec n'est pas retenté en boucle : il est mémorisé avec la raison.
 *
 *   npm run watch:bookmarks          boucle (Ctrl+C pour arrêter)
 *   npm run watch:bookmarks -- --once   un seul passage
 *   npm run watch:bookmarks -- --baseline   ignore les liens déjà présents (à faire AVANT
 *                                      la première surveillance d'un dossier déjà rempli)
 *
 * Le serveur doit tourner (npm run dev) : ce script lui parle en HTTP.
 */

import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  extractBookmarkUrls, readBookmarksFile, loadSeen, saveSeen,
} from '../src/services/bookmarks.js';

const SERVER = (process.env.MEGALOMARKET_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const KEY = process.env.ADMIN_API_KEY;
const FOLDER = process.env.BOOKMARKS_FOLDER || 'Megalomarket';
const BOOKMARKS_PATH = process.env.CHROME_BOOKMARKS_PATH
  || join(homedir(), 'Library/Application Support/Google/Chrome/Default/Bookmarks');
const SEEN_PATH = process.env.BOOKMARKS_STATE_PATH || './data/bookmarks-seen.json';
const EXTRA_HOSTS = (process.env.BOOKMARKS_EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
const INTERVAL_MIN = Number(process.env.WATCH_INTERVAL_MINUTES) || 5;
const ONCE = process.argv.includes('--once');
const BASELINE = process.argv.includes('--baseline');
// Garde-fou : au plus N nouveaux liens par passage (le reste attend le passage suivant),
// pour ne pas saturer Ollama si beaucoup de favoris arrivent d'un coup.
const MAX_PER_PASS = Number(process.env.BOOKMARKS_MAX_PER_PASS) || 5;

if (!KEY) {
  console.error('ADMIN_API_KEY manquante dans .env : le serveur refuse toute requête sans elle.');
  process.exit(1);
}

async function api(path, body) {
  const response = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 180000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function serverIsUp() {
  try {
    const response = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function pass() {
  const stamp = new Date().toLocaleTimeString('fr-FR');
  // Au démarrage du Mac, ce script peut partir avant le serveur : on attend le
  // prochain passage SANS toucher aux liens, sinon ils seraient mémorisés en échec.
  if (!(await serverIsUp())) {
    console.log(`[${stamp}] serveur Megalomarket injoignable (${SERVER}) — nouvel essai dans ${INTERVAL_MIN} min`);
    return;
  }
  let result;
  try {
    result = extractBookmarkUrls(await readBookmarksFile(BOOKMARKS_PATH), FOLDER, { extraHosts: EXTRA_HOSTS });
  } catch (error) {
    console.error(`[${stamp}] ${error.message}`);
    return;
  }

  const seen = await loadSeen(SEEN_PATH);
  if (BASELINE) {
    // Marque tous les liens ACTUELS comme déjà vus, sans rien importer : seuls ceux
    // ajoutés ensuite seront traités. À faire avant la première surveillance d'un
    // dossier qui contient déjà des favoris (ex. la barre de favoris entière).
    for (const entry of [...result.accepted, ...result.ignored]) seen.add(entry.url);
    await saveSeen(SEEN_PATH, seen);
    console.log(`[${stamp}] état de départ enregistré : ${seen.size} lien(s) existant(s) ne seront pas importés`);
    return;
  }
  const pending = result.accepted.filter((entry) => !seen.has(entry.url));
  const fresh = pending.slice(0, MAX_PER_PASS);
  if (pending.length > fresh.length) console.log(`[${stamp}] ${pending.length} nouveaux liens : ${fresh.length} traités maintenant, le reste au prochain passage`);
  for (const entry of result.ignored.filter((e) => !seen.has(e.url))) {
    console.log(`[${stamp}] ignoré (site non autorisé) : ${entry.url}`);
    seen.add(entry.url);
  }
  if (fresh.length === 0) console.log(`[${stamp}] aucun nouveau lien dans « ${FOLDER} »`);

  for (const entry of fresh) {
    console.log(`[${stamp}] nouveau lien : ${entry.url}`);
    let imported = null;
    try {
      imported = await api('/api/imports', { url: entry.url });
      await api(`/api/imports/${imported.id}/generate`);
      console.log(`  ✓ import #${imported.id} « ${imported.title} » : fiches en brouillon, à valider dans le tableau de bord`);
    } catch (error) {
      console.error(`  ✗ échec : ${error.message}`);
      if (imported) console.error(`    L'import #${imported.id} existe en brouillon : relance « Générer les fiches » depuis le tableau de bord (vérifie qu'Ollama tourne).`);
      // Le serveur est tombé en cours de route : ce n'est pas la faute du lien,
      // on ne le mémorise pas (il sera repris au prochain passage).
      if (!(await serverIsUp())) break;
    }
    // Réussi ou non, le lien est mémorisé : pas de boucle de nouvelles tentatives
    // (retire-le du dossier puis remets-le, ou supprime data/bookmarks-seen.json).
    seen.add(entry.url);
    await saveSeen(SEEN_PATH, seen);
  }
  await saveSeen(SEEN_PATH, seen);
}

console.log(`Surveillance du dossier « ${FOLDER} » (${BOOKMARKS_PATH}) vers ${SERVER}`);
await pass();
if (!ONCE && !BASELINE) {
  setInterval(() => pass().catch((error) => console.error(error.message)), INTERVAL_MIN * 60 * 1000);
}
