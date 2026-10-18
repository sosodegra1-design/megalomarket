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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  collectBookmarks, resolveBookmarkFiles, loadSeen, saveSeen, normalizeLinkKey, isGenericSourceTitle,
} from '../src/services/bookmarks.js';

const SERVER = (process.env.MEGALOMARKET_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const KEY = process.env.ADMIN_API_KEY;
const FOLDER = process.env.BOOKMARKS_FOLDER || 'Megalomarket';
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

async function api(path, body, method = 'POST') {
  const response = await fetch(`${SERVER}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 180000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const RETRY_PATH = process.env.BOOKMARKS_RETRY_PATH || './data/bookmarks-retries.json';
const MAX_RETRIES = 3;

async function loadRetries() {
  try { return JSON.parse(await readFile(RETRY_PATH, 'utf8')); } catch { return {}; }
}
async function saveRetries(retries) {
  await mkdir(dirname(RETRY_PATH), { recursive: true });
  await writeFile(RETRY_PATH, JSON.stringify(retries, null, 2));
}

/* Imports restés « brouillon » (fiches jamais générées : Ollama occupé, délai dépassé…) :
   on retente la génération, au plus MAX_RETRIES fois chacun. Les imports issus d'une page
   « barrière » (titre générique) sont supprimés : ils n'ont rien à générer. */
async function repairPending(stamp) {
  let imports;
  try { imports = await api('/api/imports', undefined, 'GET'); } catch { return; }
  const retries = await loadRetries();
  let attempts = 0;
  for (const imp of imports.filter((i) => i.status === 'brouillon')) {
    if (isGenericSourceTitle(imp.title)) {
      try {
        await api(`/api/imports/${imp.id}`, undefined, 'DELETE');
        console.log(`[${stamp}] import #${imp.id} supprimé : page générique (le site a bloqué la lecture), pas un vrai produit`);
      } catch (error) {
        console.error(`[${stamp}] suppression de #${imp.id} impossible : ${error.message}`);
      }
      continue;
    }
    if (attempts >= MAX_PER_PASS || (retries[imp.id] || 0) >= MAX_RETRIES) continue;
    attempts += 1;
    retries[imp.id] = (retries[imp.id] || 0) + 1;
    await saveRetries(retries);
    try {
      await api(`/api/imports/${imp.id}/generate`);
      console.log(`[${stamp}] import #${imp.id} : fiches générées (reprise ${retries[imp.id]}/${MAX_RETRIES})`);
    } catch (error) {
      console.error(`[${stamp}] import #${imp.id} : reprise ${retries[imp.id]}/${MAX_RETRIES} en échec : ${error.message}`);
    }
  }
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
  const files = await resolveBookmarkFiles();
  if (files.length === 0) {
    console.error(`[${stamp}] aucun fichier de favoris Chrome trouvé. Renseigne CHROME_BOOKMARKS_PATH dans .env.`);
    return;
  }
  const result = await collectBookmarks({ files, folderName: FOLDER, extraHosts: EXTRA_HOSTS });
  if (result.accepted.length + result.ignored.length === 0) {
    const reasons = result.perFile.map((f) => `${f.path} : ${f.error || 'aucun lien'}`).join('\n  ');
    console.log(`[${stamp}] aucun lien trouvé dans « ${FOLDER} » :\n  ${reasons}`);
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
  // Même produit sous plusieurs liens (paramètres de suivi, ancres) : un seul import.
  const knownKeys = new Set([...seen].map((u) => normalizeLinkKey(u)));
  const pendingKeys = new Set();
  const pending = result.accepted.filter((entry) => {
    const key = normalizeLinkKey(entry.url);
    if (seen.has(entry.url) || knownKeys.has(key) || pendingKeys.has(key)) {
      if (!seen.has(entry.url) && (knownKeys.has(key) || pendingKeys.has(key))) seen.add(entry.url);
      return false;
    }
    pendingKeys.add(key);
    return true;
  });
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
      if (isGenericSourceTitle(imported.title)) {
        await api(`/api/imports/${imported.id}`, undefined, 'DELETE');
        console.log(`  ✗ page générique « ${String(imported.title).slice(0, 50)}… » : le site a bloqué la lecture, lien ignoré (ouvre-le et remets-le en favori depuis la page produit)`);
        imported = null;
        seen.add(entry.url);
        await saveSeen(SEEN_PATH, seen);
        continue;
      }
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
  await repairPending(stamp);
}

console.log(`Surveillance du dossier « ${FOLDER} » (tous les profils Chrome, ou CHROME_BOOKMARKS_PATH) vers ${SERVER}`);
// Passages SÉQUENTIELS : le suivant ne part qu'une fois le précédent terminé. Avec un
// minuteur fixe, un passage lent (Ollama) en chevauchait un autre, qui réimportait
// les mêmes liens en double.
async function runPass() {
  try {
    await pass();
  } catch (error) {
    console.error(`passage en échec : ${error.message}`);
  }
}
await runPass();
if (!ONCE && !BASELINE) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MIN * 60 * 1000));
    await runPass();
  }
}
