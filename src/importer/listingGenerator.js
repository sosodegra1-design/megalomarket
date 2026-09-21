import { askClaude } from '../ai/client.js';
import { dbGet, dbRun } from '../db/database.js';
import { computeSuggestedPrice } from './pricing.js';
import { config } from '../config/env.js';
import { connectors } from '../connectors/index.js';

const MARKETPLACES = ['amazon', 'tiktok_shop', 'allegro', 'ebay'];

const SYSTEM_PROMPT = `Tu es un expert e-commerce multi-marketplaces pour Megalomarket, une boutique d'articles pour enfants.
On te donne les informations brutes d'une fiche produit fournisseur (souvent en anglais ou chinois, parfois mal traduites).
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, au format exact :
{
  "amazon": {"title": "...", "description": "..."},
  "tiktok_shop": {"title": "...", "description": "..."},
  "allegro": {"title": "...", "description": "..."},
  "ebay": {"title": "...", "description": "..."}
}
Règles :
- Traduis systématiquement en français, y compris pour la fiche Allegro (l'équipe travaille en français en interne).
- Amazon : titre orienté mots-clés sans majuscules abusives, description structurée en avantages, conforme aux règles Amazon (pas de coordonnées de contact, pas de promotion).
- TikTok Shop : ton jeune et dynamique, phrases courtes, orienté usage au quotidien.
- Allegro : ton clair et rassurant, précis sur les caractéristiques.
- eBay : orienté mots-clés de recherche, caractéristiques techniques en points courts.
- Ne jamais inventer une caractéristique technique absente des données fournies.`;

/* ===================== SITE PROPRE =====================
   Le site BBVOLTEX n'accepte pas le même format que les marketplaces : il lui
   faut une catégorie, un univers, un âge, une clé d'icône et des libellés
   bilingues. Ces valeurs sont fermées (les filtres du site reposent dessus) et
   appartiennent au site : elles sont donc demandées à son API via
   /api/admin/taxonomy, jamais devinées ni recopiées ici. */

const SITE_TEXT_FIELDS = [
  'name', 'name_en', 'description', 'description_en',
  'ecoDetails', 'ecoDetails_en', 'safety', 'safety_en', 'care', 'care_en',
];
const SITE_REQUIRED_FIELDS = ['category', 'age', 'ageLabel', 'ageLabel_en', 'name', 'name_en', 'iconKey'];

function buildSitePrompt(imp, taxonomy) {
  return `Titre fournisseur : ${imp.title}
Description fournisseur (brute, éventuellement dans une autre langue) :
${imp.raw_description || '(aucune description fournie)'}

Prix d'achat fournisseur : ${imp.purchase_price} ${imp.currency}
Site source : ${imp.source_site}

Produit ce que le site a besoin de savoir pour publier cette fiche.`;
}

function buildSiteSystemPrompt(taxonomy) {
  return `Tu prépares une fiche produit pour le site e-commerce BBVOLTEX (articles pour enfants), à partir des informations brutes d'un fournisseur.
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, au format exact :
{
  "category": "...", "universe": "..." | null, "age": "...",
  "ageLabel": "...", "ageLabel_en": "...",
  "name": "...", "name_en": "...",
  "description": "...", "description_en": "...",
  "ecoDetails": "...", "ecoDetails_en": "...",
  "safety": "...", "safety_en": "...",
  "care": "...", "care_en": "...",
  "iconKey": "...",
  "colors": ["#rrggbb"],
  "sizeGuide": [["En-tête", "En-tête"], ["valeur", "valeur"]],
  "sizeGuide_en": [["Header", "Header"], ["value", "value"]]
}
Règles impératives :
- "category" DOIT être exactement l'une de ces valeurs : ${taxonomy.categories.join(', ')}.
- "universe" DOIT être null ou exactement l'une de ces valeurs : ${taxonomy.universes.join(', ')}.
- "iconKey" DOIT être exactement l'une de ces clés, qui correspond à une illustration existante : ${taxonomy.iconKeys.join(', ')}. Choisis la plus proche du produit ; n'invente jamais de clé.
- Tous les champs de texte existent en français ET en anglais (suffixe _en) : traduis, ne recopie pas.
- "sizeGuide" et "sizeGuide_en" : la première ligne est un en-tête de colonnes ; au moins une ligne de valeurs. Adapte les colonnes au produit (âge, dimensions, poids, matière…).
- "age" est un code court (par exemple "0-2", "3-5", "6-8", "adulte") ; "ageLabel" est son libellé lisible ("0-2 ans").
- "colors" : une à trois couleurs hexadécimales plausibles pour le produit.
- Ne jamais inventer une caractéristique technique absente des données fournies.`;
}

/**
 * Valide et nettoie une fiche destinée au site, en s'appuyant sur ses listes
 * fermées. Fonction pure : c'est ici qu'est garantie la contrainte « une
 * catégorie inventée casse les filtres du site ». Une fiche hors listes est
 * rejetée plutôt que publiée.
 */
export function validateSitePayload(payload, taxonomy) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Fiche site invalide : objet JSON attendu.');
  }

  const cleaned = {};

  for (const field of SITE_REQUIRED_FIELDS) {
    const value = payload[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Fiche site incomplète : champ "${field}" manquant.`);
    }
    cleaned[field] = value.trim();
  }

  if (!taxonomy.categories.includes(cleaned.category)) {
    throw new Error(
      `Catégorie "${cleaned.category}" inconnue du site — les filtres ne la proposeraient jamais. ` +
      `Valeurs autorisées : ${taxonomy.categories.join(', ')}.`,
    );
  }

  if (!taxonomy.iconKeys.includes(cleaned.iconKey)) {
    throw new Error(
      `Clé d'icône "${cleaned.iconKey}" absente de la bibliothèque du site. ` +
      `Valeurs autorisées : ${taxonomy.iconKeys.join(', ')}.`,
    );
  }

  const universe = payload.universe ?? null;
  if (universe !== null && !taxonomy.universes.includes(universe)) {
    throw new Error(
      `Univers "${universe}" inconnu du site. Valeurs autorisées : ${taxonomy.universes.join(', ')}.`,
    );
  }
  cleaned.universe = universe;

  for (const field of SITE_TEXT_FIELDS) {
    if (field === 'name' || field === 'name_en') continue;
    cleaned[field] = typeof payload[field] === 'string' ? payload[field].trim() : '';
  }

  for (const field of ['sizeGuide', 'sizeGuide_en']) {
    const guide = payload[field];
    cleaned[field] = Array.isArray(guide) && guide.length > 0 && Array.isArray(guide[0])
      ? guide.map((row) => (Array.isArray(row) ? row.map(String) : [String(row)]))
      : [[field === 'sizeGuide' ? 'Caractéristique' : 'Feature', field === 'sizeGuide' ? 'Valeur' : 'Value']];
  }

  const colors = Array.isArray(payload.colors)
    ? payload.colors.filter((c) => typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c))
    : [];
  cleaned.colors = colors.length ? colors : ['#ffffff'];

  return cleaned;
}

/** Récupère les listes fermées du site. Retourne null si le site n'est pas configuré ou injoignable. */
async function fetchSiteTaxonomy() {
  const connector = connectors.own_site;
  if (!connector?.isConfigured?.() || !connector.getTaxonomy) return null;
  try {
    return await connector.getTaxonomy();
  } catch {
    return null;
  }
}

/** Génère la fiche détaillée du site propre, validée contre sa taxonomie. */
async function generateSiteListing(imp, taxonomy) {
  const raw = await askClaude({
    system: buildSiteSystemPrompt(taxonomy),
    prompt: buildSitePrompt(imp, taxonomy),
    maxTokens: 2500,
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Réponse IA non exploitable pour le site propre (JSON invalide) : ${raw.slice(0, 200)}`);
  }

  return validateSitePayload(parsed, taxonomy);
}

function buildPrompt(imp) {
  return `Titre fournisseur : ${imp.title}
Description fournisseur (brute, éventuellement dans une autre langue) :
${imp.raw_description || '(aucune description fournie)'}

Prix d'achat fournisseur : ${imp.purchase_price} ${imp.currency}
Site source : ${imp.source_site}`;
}

/**
 * Génère une fiche produit adaptée par marketplace via l'IA, calcule le prix
 * conseillé, et les enregistre en statut "à valider".
 *
 * La fiche du site propre est produite par un second appel : son format est
 * beaucoup plus riche et contraint par la taxonomie du site, ce qui nuit à la
 * qualité si on le demande dans le même souffle que les fiches marketplace.
 */
export async function generateListingsForImport(importId) {
  const imp = await dbGet('SELECT * FROM imports WHERE id = ?', [importId]);
  if (!imp) throw new Error(`Import introuvable (id=${importId}).`);

  const raw = await askClaude({ system: SYSTEM_PROMPT, prompt: buildPrompt(imp), maxTokens: 1800 });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Réponse IA non exploitable (JSON invalide) : ${raw.slice(0, 200)}`);
  }

  const suggestedPrice = computeSuggestedPrice(imp.purchase_price, config.pricing);
  const now = Date.now();
  const saved = [];

  for (const marketplace of MARKETPLACES) {
    const listing = parsed[marketplace];
    if (!listing?.title || !listing?.description) continue;
    await dbRun(
      `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'a_valider', ?, ?)
       ON CONFLICT(import_id, marketplace) DO UPDATE SET
         title = excluded.title, description = excluded.description, suggested_price = excluded.suggested_price,
         status = 'a_valider', publish_error = NULL, updated_at = excluded.updated_at`,
      [importId, marketplace, listing.title, listing.description, suggestedPrice, now, now],
    );
    saved.push({ marketplace, title: listing.title, description: listing.description, suggestedPrice });
  }

  // Site propre : la fiche est plus riche, donc plus fragile. Un échec ici ne
  // doit pas faire perdre les fiches marketplace déjà générées — il est signalé
  // à part, et l'import reste utilisable.
  const taxonomy = await fetchSiteTaxonomy();
  if (taxonomy) {
    try {
      const site = await generateSiteListing(imp, taxonomy);
      await dbRun(
        `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, site_payload, status, created_at, updated_at)
         VALUES (?, 'own_site', ?, ?, ?, ?, 'a_valider', ?, ?)
         ON CONFLICT(import_id, marketplace) DO UPDATE SET
           title = excluded.title, description = excluded.description, suggested_price = excluded.suggested_price,
           site_payload = excluded.site_payload, status = 'a_valider', publish_error = NULL, updated_at = excluded.updated_at`,
        [importId, site.name, site.description, suggestedPrice, JSON.stringify(site), now, now],
      );
      saved.push({ marketplace: 'own_site', title: site.name, description: site.description, suggestedPrice, site });
    } catch (error) {
      await dbRun(
        `INSERT INTO import_listings (import_id, marketplace, title, description, suggested_price, status, publish_error, created_at, updated_at)
         VALUES (?, 'own_site', ?, ?, ?, 'echec', ?, ?, ?)
         ON CONFLICT(import_id, marketplace) DO UPDATE SET
           status = 'echec', publish_error = excluded.publish_error, updated_at = excluded.updated_at`,
        [importId, imp.title, '', suggestedPrice, error.message, now, now],
      );
      saved.push({ marketplace: 'own_site', error: error.message });
    }
  }

  if (saved.length === 0) {
    throw new Error("L'IA n'a généré aucune fiche exploitable pour ce produit.");
  }

  await dbRun("UPDATE imports SET status = 'pret' WHERE id = ?", [importId]);
  return saved;
}
