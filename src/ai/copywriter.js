import { askModel, parseJsonFromModel } from './client.js';

/*
 * Agent 2 — rédacteur/marketeur. Écrit une fiche complète (titre SEO,
 * accroche AIDA, bénéfices en puces, CTA, description assemblée) à partir
 * des seules informations fournies — jamais de chiffre, certification ou
 * promesse inventée, conformément à l'exigence de la chaîne autonome : une
 * publication automatique doit reposer sur des affirmations vérifiables,
 * pas sur ce qu'un modèle de langage aurait pu improviser.
 */

const SYSTEM_PROMPT = `Tu es copywriter e-commerce senior, spécialisé conversion et SEO, pour la marque BBVOLTEX (famille, enfants, maison).
Réponds UNIQUEMENT avec un objet JSON valide, au format exact :
{"seoTitle":"...","hook":"...","bullets":["...","...","..."],"cta":"...","description":"..."}
- "seoTitle" : titre optimisé SEO et vendeur, concret, 70 caractères maximum, sans superlatif non justifié.
- "hook" : accroche courte (1 à 2 phrases), méthode AIDA (capter l'Attention), qui donne envie de lire la suite.
- "bullets" : 3 à 5 puces, chacune un bénéfice client concret déduit des informations fournies (pas une caractéristique technique brute recopiée telle quelle).
- "cta" : une phrase d'appel à l'action, sans fausse urgence ni rareté inventée.
- "description" : le texte complet prêt à publier (accroche + corps + puces reformulées en prose), en français, sans emoji.
Interdiction absolue d'inventer un chiffre, une certification, un avis client ou une promesse qui n'est pas dans les informations fournies.`;

export async function writeListing({ title, category, universe, ageLabel, price, notes }) {
  const trimmedTitle = typeof title === 'string' ? title.trim() : '';
  if (!trimmedTitle) throw new Error('Le titre du produit est obligatoire pour rédiger la fiche.');

  const priceNumber = Number(price);
  const details = [
    category && `Catégorie : ${category}`,
    universe && `Univers : ${universe}`,
    ageLabel && `Âge cible : ${ageLabel}`,
    Number.isFinite(priceNumber) && priceNumber > 0 && `Prix : ${priceNumber.toFixed(2)} €`,
    notes && `Notes fournies par le vendeur : ${notes}`,
  ].filter(Boolean).join('\n');

  const prompt = `Produit : ${trimmedTitle}\n${details || '(aucun autre détail fourni)'}\n\nRédige la fiche complète.`;

  const raw = await askModel({ system: SYSTEM_PROMPT, prompt, maxTokens: 900 });
  let parsed;
  try {
    parsed = parseJsonFromModel(raw);
  } catch {
    throw new Error(`Réponse IA non exploitable (fiche produit) : ${raw.slice(0, 200)}`);
  }

  for (const key of ['seoTitle', 'hook', 'cta', 'description']) {
    if (!parsed[key] || typeof parsed[key] !== 'string') {
      throw new Error(`Réponse IA incomplète : champ "${key}" manquant ou invalide.`);
    }
  }
  if (!Array.isArray(parsed.bullets) || !parsed.bullets.length) {
    throw new Error('Réponse IA incomplète : "bullets" doit être une liste non vide.');
  }

  return {
    seoTitle: parsed.seoTitle.trim(),
    hook: parsed.hook.trim(),
    bullets: parsed.bullets.map((b) => String(b).trim()).filter(Boolean),
    cta: parsed.cta.trim(),
    description: parsed.description.trim(),
  };
}
