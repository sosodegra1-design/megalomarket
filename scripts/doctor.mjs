/*
 * Contrôle complet de l'installation : npm run doctor [-- --deep]
 *
 * Passe en revue, dans l'ordre, tout ce dont dépend la chaîne
 * favoris Chrome → import → Ollama → fiches en brouillon :
 *   1. environnement (Node, .env : variables vides, doublons, valeurs « <à remplir> »)
 *   2. IA (Ollama joignable, modèles installés, appel réel ; --deep : lecture d'image)
 *   3. serveur Megalomarket et canaux (LumiVita, site propre…)
 *   4. catalogue LumiVita
 *   5. favoris Chrome (dossier, liens autorisés)
 *   6. démarrage automatique (macOS)
 * Code de sortie ≠ 0 s'il reste au moins un point KO. Aucune écriture, rien n'est publié.
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config/env.js';
import { askModel, askVision } from '../src/ai/client.js';
import { extractBookmarkUrls, readBookmarksFile } from '../src/services/bookmarks.js';
import { SERVER_LABEL, WATCHER_LABEL } from '../src/services/autostart.js';

const DEEP = process.argv.includes('--deep');
const SERVER = (process.env.MEGALOMARKET_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
let ko = 0;
let warn = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, fix) => { ko += 1; console.log(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ''}`); };
const note = (msg) => { warn += 1; console.log(`  ! ${msg}`); };
const section = (title) => console.log(`\n${title}`);

/* ---------- 1. Environnement ---------- */
section('1. Environnement');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node ${process.versions.node}`); else bad(`Node ${process.versions.node} trop ancien`, 'installe Node 20 ou plus (https://nodejs.org)');

const envPath = '.env';
if (!existsSync(envPath)) {
  bad('Fichier .env introuvable', 'copie .env.example en .env');
} else {
  ok('.env présent');
  const seenKeys = new Map();
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    seenKeys.set(key, (seenKeys.get(key) || 0) + 1);
    if (/<[^>]+>/.test(value)) bad(`${key} contient un texte à remplacer : ${value}`, `mets une vraie valeur pour ${key}`);
  }
  for (const [key, count] of seenKeys) {
    if (count > 1) bad(`${key} est défini ${count} fois dans .env (la dernière l’emporte, ce qui prête à confusion)`, `garde une seule ligne ${key}=`);
  }
}
if (config.admin.apiKey) ok('ADMIN_API_KEY définie'); else bad('ADMIN_API_KEY manquante : le serveur répond 503 partout', 'génère-la : openssl rand -hex 32');

/* ---------- 2. IA ---------- */
section('2. IA (fournisseur compatible OpenAI, ex. Ollama)');
if (!config.ai.ready) {
  bad(config.ai.reason);
} else if (config.ai.provider !== 'openai') {
  note(`fournisseur actif : ${config.ai.provider} (pas Ollama) — le contrôle Ollama est ignoré`);
} else {
  ok(`fournisseur openai · ${config.ai.baseUrl} · modèle ${config.ai.model} · vision ${config.ai.visionModel} · délai ${config.ai.timeoutMs / 1000} s`);
  const origin = new URL(config.ai.baseUrl).origin;
  let installed = null;
  try {
    const response = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(5000) });
    installed = (await response.json()).models?.map((m) => m.name) ?? [];
    ok(`Ollama répond (${installed.length} modèle(s) installé(s))`);
  } catch {
    bad(`Ollama ne répond pas sur ${origin}`, "ouvre l'application Ollama (ou « ollama serve »)");
  }
  if (installed) {
    for (const [label, model] of [['texte', config.ai.model], ['vision', config.ai.visionModel]]) {
      const found = installed.some((n) => n === model || n === `${model}:latest` || n.split(':')[0] === model);
      if (found) ok(`modèle ${label} « ${model} » installé`);
      else bad(`modèle ${label} « ${model} » non installé`, `ollama pull ${model}`);
    }
    try {
      const started = Date.now();
      const reply = await askModel({ system: 'Réponds UNIQUEMENT avec un objet JSON valide.', prompt: 'Renvoie {"ok": true}.', maxTokens: 50 });
      ok(`appel texte réussi en ${((Date.now() - started) / 1000).toFixed(1)} s : ${reply.trim().slice(0, 60)}`);
    } catch (error) {
      bad(`appel texte en échec : ${error.message}`, 'si c\'est un délai dépassé, augmente AI_TIMEOUT_MS');
    }
    if (DEEP) {
      // PNG 1×1 : suffit à vérifier que le modèle accepte une image, pas sa qualité d'analyse.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      try {
        await askVision({ system: 'Décris brièvement.', prompt: 'Que vois-tu ?', images: [{ source: { type: 'base64', media_type: 'image/png', data: png } }], maxTokens: 50 });
        ok('appel vision réussi');
      } catch (error) {
        bad(`appel vision en échec : ${error.message}`);
      }
    } else {
      console.log('    (test d\'image ignoré : relance avec « npm run doctor -- --deep »)');
    }
  }
}

/* ---------- 3. Serveur ---------- */
section('3. Serveur Megalomarket');
let serverUp = false;
try {
  serverUp = (await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(5000) })).ok;
} catch { /* injoignable */ }
if (!serverUp) {
  bad(`serveur injoignable sur ${SERVER}`, 'lance « npm run dev » (ou installe le démarrage automatique)');
} else {
  ok(`serveur en ligne (${SERVER})`);
  const headers = { 'X-Admin-Key': config.admin.apiKey || '' };
  try {
    const response = await fetch(`${SERVER}/api/config`, { headers, signal: AbortSignal.timeout(5000) });
    if (response.status === 401 || response.status === 403) {
      bad('le serveur refuse ADMIN_API_KEY', 'le serveur tourne avec une autre clé : relance-le après avoir corrigé .env');
    } else {
      const body = await response.json();
      ok(`base : ${body.database?.persistent ? 'distante' : 'locale'} · IA configurée : ${body.ai?.configured ? 'oui' : 'NON'}`);
      if (!body.ai?.configured) bad(`le serveur ne voit pas l'IA : ${body.ai?.reason || ''}`, 'relance le serveur après modification de .env');
      for (const [channel, configured] of Object.entries(body.channels || {})) {
        console.log(`    canal ${channel.padEnd(12)} ${configured ? 'configuré' : 'non configuré'}`);
      }
      if (body.channels && body.channels.lumivita !== true) bad('canal LumiVita non configuré', 'vérifie data/lumivita-catalogue.json');
    }
  } catch (error) {
    bad(`lecture de /api/config impossible : ${error.message}`);
  }

  /* ---------- 4. LumiVita ---------- */
  section('4. Catalogue LumiVita');
  try {
    const response = await fetch(`${SERVER}/api/lumivita/products`, { headers, signal: AbortSignal.timeout(5000) });
    const products = await response.json();
    if (Array.isArray(products) && products.length > 0) {
      ok(`${products.length} produit(s) : ${products.map((p) => p.sku).join(', ')}`);
      console.log('    aucun prix dans le catalogue : saisis les prix d\'achat avant tout prix conseillé');
    } else {
      bad('catalogue vide ou illisible', 'vérifie data/lumivita-catalogue.json');
    }
  } catch (error) {
    bad(`lecture du catalogue impossible : ${error.message}`);
  }
}

/* ---------- 5. Favoris Chrome ---------- */
section('5. Favoris Chrome');
const bookmarksPath = process.env.CHROME_BOOKMARKS_PATH || join(homedir(), 'Library/Application Support/Google/Chrome/Default/Bookmarks');
const folder = process.env.BOOKMARKS_FOLDER || 'Megalomarket';
try {
  const result = extractBookmarkUrls(await readBookmarksFile(bookmarksPath), folder, {
    extraHosts: (process.env.BOOKMARKS_EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
  });
  ok(`dossier « ${folder} » trouvé : ${result.accepted.length} lien(s) autorisé(s), ${result.ignored.length} ignoré(s)`);
  const seenPath = process.env.BOOKMARKS_STATE_PATH || './data/bookmarks-seen.json';
  if (result.accepted.length > 0 && !existsSync(seenPath)) {
    note(`${result.accepted.length} lien(s) déjà présent(s) seraient tous importés au premier passage → lance d'abord « npm run watch:bookmarks -- --baseline » pour ne traiter que les NOUVEAUX liens`);
  }
} catch (error) {
  bad(error.message);
}

/* ---------- 6. Démarrage automatique ---------- */
section('6. Démarrage automatique (macOS)');
if (process.platform !== 'darwin') {
  console.log('    non applicable (ce n\'est pas un Mac)');
} else {
  for (const label of [SERVER_LABEL, WATCHER_LABEL]) {
    try {
      execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'pipe' });
      ok(`${label} chargé`);
    } catch {
      note(`${label} non installé (facultatif) → npm run autostart:install`);
    }
  }
}

console.log(`\n${ko === 0 ? 'Tout est en ordre' : `${ko} point(s) à corriger`}${warn ? ` · ${warn} remarque(s)` : ''}.\n`);
process.exit(ko === 0 ? 0 : 1);
