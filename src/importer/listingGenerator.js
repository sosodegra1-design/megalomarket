import { askClaude } from '../ai/client.js';
import { dbGet, dbRun } from '../db/database.js';
import { computeSuggestedPrice } from './pricing.js';
import { config } from '../config/env.js';

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

function buildPrompt(imp) {
  return `Titre fournisseur : ${imp.title}
Description fournisseur (brute, éventuellement dans une autre langue) :
${imp.raw_description || '(aucune description fournie)'}

Prix d'achat fournisseur : ${imp.purchase_price} ${imp.currency}
Site source : ${imp.source_site}`;
}

/** Génère une fiche produit adaptée par marketplace via l'IA, calcule le prix conseillé, et les enregistre en statut "à valider". */
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

  if (saved.length === 0) {
    throw new Error("L'IA n'a généré aucune fiche exploitable pour ce produit.");
  }

  await dbRun("UPDATE imports SET status = 'pret' WHERE id = ?", [importId]);
  return saved;
}
