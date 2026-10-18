import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Lecture des favoris Chrome — la source des liens à importer.
 *
 * Chrome range les favoris dans un fichier JSON (`Bookmarks`) du profil. On le
 * lit en lecture seule : le dossier désigné par `folderName` (n'importe où dans
 * la barre de favoris ou les autres favoris) est la « boîte de veille » de
 * l'administrateur. Seuls les sites de sourcing autorisés sont retenus ; tout
 * autre lien du dossier est ignoré, jamais importé.
 */

export const ALLOWED_SOURCE_HOSTS = [
  'alibaba.com',
  'aliexpress.com',
  'aliexpress.us',
  'showroomprive.com',
  'veepee.fr',
  'veepee.com',
];

export function isAllowedSource(url, extraHosts = []) {
  let hostname;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return [...ALLOWED_SOURCE_HOSTS, ...extraHosts].some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/* La barre de favoris n'est pas un dossier comme les autres : Chrome la range sous
   la racine `bookmark_bar`, avec un nom qui reste souvent en anglais
   (« Bookmarks bar ») même si l'interface est en français. On la reconnaît donc
   par tous ses noms usuels, sans tenir compte des accents ni de la casse. */
const BAR_ALIASES = ['barre de favoris', 'barre de signets', 'bookmarks bar', 'bookmark bar', 'bookmark_bar', 'favorites bar'];

function normalizeName(value) {
  return String(value).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function isBookmarkBarName(folderName) {
  return BAR_ALIASES.includes(normalizeName(folderName));
}

function findFolders(node, folderName, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'folder' && normalizeName(node.name) === normalizeName(folderName)) {
    found.push(node);
  }
  for (const child of node.children || []) findFolders(child, folderName, found);
  return found;
}

function collectUrls(node, urls = []) {
  if (!node) return urls;
  if (node.type === 'url' && node.url) urls.push({ url: node.url, name: node.name || '' });
  for (const child of node.children || []) collectUrls(child, urls);
  return urls;
}

/**
 * Liens des favoris d'un dossier (sous-dossiers compris), dédoublonnés, limités
 * aux sources autorisées. Lève une erreur claire si le dossier n'existe pas.
 */
export function extractBookmarkUrls(bookmarksJson, folderName, { extraHosts = [] } = {}) {
  const roots = Object.values(bookmarksJson?.roots || {});
  const folders = isBookmarkBarName(folderName) && bookmarksJson?.roots?.bookmark_bar
    ? [bookmarksJson.roots.bookmark_bar]
    : roots.flatMap((root) => findFolders(root, folderName));
  if (folders.length === 0) {
    throw new Error(`Dossier de favoris « ${folderName} » introuvable dans Chrome. Crée-le dans la barre de favoris, ou change BOOKMARKS_FOLDER dans .env.`);
  }
  const seen = new Set();
  const accepted = [];
  const ignored = [];
  for (const folder of folders) {
    for (const entry of collectUrls(folder)) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      (isAllowedSource(entry.url, extraHosts) ? accepted : ignored).push(entry);
    }
  }
  return { accepted, ignored };
}

export async function readBookmarksFile(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Fichier de favoris Chrome illisible (${path}) : ${error.message}. Vérifie CHROME_BOOKMARKS_PATH dans .env.`);
  }
  return JSON.parse(raw);
}

/** Mémoire des liens déjà traités : un lien n'est jamais importé deux fois. */
export async function loadSeen(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return new Set(Array.isArray(data.urls) ? data.urls : []);
  } catch {
    return new Set();
  }
}

export async function saveSeen(path, seen) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ urls: [...seen] }, null, 2));
}
