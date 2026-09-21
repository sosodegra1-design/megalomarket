import { randomUUID } from 'node:crypto';
import { askModel, parseJsonFromModel } from './client.js';
import { dbAll, dbRun, logActivity } from '../db/database.js';

/*
 * Agent « chasseur de pépites ».
 *
 * IMPORTANT — nature du résultat : ce module n'a accès à AUCUNE donnée de
 * ventes mondiales en temps réel (aucune API de ce type n'est configurée
 * dans Megalomarket). Il produit des SUGGESTIONS générées par le modèle de
 * langage à partir de ses connaissances générales sur les tendances
 * e-commerce — un point de départ pour la recherche produit, pas un
 * classement de ventes vérifié. Le tableau de bord doit toujours l'annoncer
 * clairement à côté du résultat ; ce module lui-même ne prétend jamais
 * l'inverse dans ses messages.
 */

const RANK_COUNT = 20;

const SYSTEM_PROMPT = `Tu es un chasseur de tendances e-commerce pour Megalomarket, spécialisé dans la recherche de produits à fort potentiel pour l'import et la revente multicanale (eBay, Amazon, TikTok Shop, Allegro, site propre).
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, au format exact :
{"finds": [{"rank": 1, "title": "...", "category": "...", "rationale": "...", "targetAudience": "...", "priceRange": "..."}]}
Règles :
- Exactement 20 entrées, classées de 1 (le plus prometteur) à 20.
- "title" : nom de produit concret et vendable, pas une catégorie vague.
- "rationale" : pourquoi ce produit est intéressant en ce moment (tendance, usage, saisonnalité) — deux phrases maximum, en français.
- "targetAudience" : à qui ce produit s'adresse.
- "priceRange" : fourchette de prix de vente indicative au détail, en euros (ex. "15-25 €").
- Diversité : ne propose pas 20 variantes du même produit.
- N'invente pas de chiffre de vente précis ni de source : ce sont des suggestions, pas des statistiques vérifiées.`;

function buildPrompt({ focus }) {
  const base = 'Propose 20 idées de produits à fort potentiel pour un e-commerce généraliste qui importe et revend sur plusieurs canaux.';
  return focus && focus.trim()
    ? `${base}\n\nAxe de recherche demandé : ${focus.trim()}`
    : base;
}

/** Lance une nouvelle chasse et enregistre le lot de 20 suggestions (remplace l'agent unique de génération). */
export async function huntNiches({ focus } = {}) {
  const raw = await askModel({ system: SYSTEM_PROMPT, prompt: buildPrompt({ focus }), maxTokens: 3000 });

  let parsed;
  try {
    parsed = parseJsonFromModel(raw);
  } catch {
    throw new Error(`Réponse IA non exploitable (JSON invalide) : ${raw.slice(0, 200)}`);
  }

  const finds = Array.isArray(parsed.finds) ? parsed.finds : [];
  const valid = finds.filter((f) => f && typeof f.title === 'string' && f.title.trim());
  if (!valid.length) {
    throw new Error("L'IA n'a renvoyé aucune suggestion exploitable.");
  }

  const batchId = randomUUID();
  const now = Date.now();
  const saved = [];

  for (const [index, find] of valid.slice(0, RANK_COUNT).entries()) {
    const rank = Number.isInteger(find.rank) && find.rank > 0 ? find.rank : index + 1;
    const row = {
      batchId,
      rank,
      title: find.title.trim(),
      category: typeof find.category === 'string' ? find.category.trim() : '',
      rationale: typeof find.rationale === 'string' ? find.rationale.trim() : '',
      targetAudience: typeof find.targetAudience === 'string' ? find.targetAudience.trim() : '',
      priceRange: typeof find.priceRange === 'string' ? find.priceRange.trim() : '',
    };
    await dbRun(
      `INSERT INTO trend_finds (batch_id, rank, title, category, rationale, target_audience, price_range, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.batchId, row.rank, row.title, row.category, row.rationale, row.targetAudience, row.priceRange, now],
    );
    saved.push(row);
  }

  saved.sort((a, b) => a.rank - b.rank);
  await logActivity('DENICHEUR_CHASSE', `Nouvelle chasse aux pépites : ${saved.length} suggestion(s) générée(s) (lot ${batchId}).`);
  return { batchId, finds: saved };
}

/** Retourne le dernier lot généré (les 20 lignes les plus récentes du batch le plus récent), ou un lot vide. */
export async function latestFinds() {
  const latest = await dbAll('SELECT batch_id FROM trend_finds ORDER BY created_at DESC LIMIT 1');
  if (!latest.length) return { batchId: null, finds: [] };
  const batchId = latest[0].batch_id;
  const finds = await dbAll(
    'SELECT rank, title, category, rationale, target_audience AS targetAudience, price_range AS priceRange, created_at FROM trend_finds WHERE batch_id = ? ORDER BY rank ASC',
    [batchId],
  );
  return { batchId, finds };
}
