import { dbAll } from '../db/database.js';
import { normalizeTitleKey } from './categorizer.js';
import { normalizeLinkKey, isGenericSourceTitle } from '../services/bookmarks.js';

/** Un import déjà présent pour le même produit : même lien (hors paramètres de suivi) ou même titre. */
export async function findDuplicateImport({ url, title }) {
  const existing = await dbAll('SELECT id, source_url, title FROM imports');
  const linkKey = url ? normalizeLinkKey(url) : null;
  const titleKey = normalizeTitleKey(title);
  return existing.find((imp) => (
    (linkKey && imp.source_url && normalizeLinkKey(imp.source_url) === linkKey)
    || (titleKey && normalizeTitleKey(imp.title) === titleKey)
  )) || null;
}

/**
 * Refuse d'importer une page « barrière » (le site a bloqué la lecture) ou un doublon.
 * Les messages commencent par « Page générique » / « Doublon » : le surveillant de
 * favoris s'en sert pour ne pas retenter ces liens.
 */
export async function assertImportable({ url, title }) {
  if (isGenericSourceTitle(title)) {
    throw new Error(
      `Page générique : « ${String(title).slice(0, 60)} » — le site a bloqué la lecture et n'a pas renvoyé la fiche du produit. `
      + "Ouvre la page du produit lui-même et ajoute celle-là.",
    );
  }
  const duplicate = await findDuplicateImport({ url, title });
  if (duplicate) {
    throw new Error(`Doublon : « ${String(title).slice(0, 60)} » est déjà importé (import n°${duplicate.id}) — il n'est pas importé une seconde fois.`);
  }
}
