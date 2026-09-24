import { askModel, parseJsonFromModel } from './client.js';

/*
 * Agent « coach » du Dénicheur.
 *
 * Le chasseur de tendances (nicheHunter.js) part d'un axe de recherche libre,
 * parfois vide, parfois trop vague pour donner 20 pistes vraiment ciblées. Ce
 * second agent ne génère aucune idée de produit lui-même : il précise l'axe
 * AVANT la chasse (catégories concrètes, saisonnalité, contrainte de
 * sourcing), pour que le chasseur reçoive une consigne plus exploitable. Le
 * résultat est montré à l'utilisateur avant la chasse — jamais appliqué en
 * silence — pour qu'il garde la main sur ce qui est réellement demandé.
 */

const COACH_SYSTEM_PROMPT = `Tu prépares une recherche de produits tendance pour un e-commerce qui importe et revend sur plusieurs canaux (eBay, Amazon, TikTok Shop, Allegro, site propre). Un second agent IA va générer 20 idées de produits à partir de l'axe que tu vas produire — ton seul rôle est de rendre cet axe plus précis et actionnable, pas de proposer toi-même des produits.
Réponds UNIQUEMENT avec un objet JSON valide, au format exact :
{"refinedFocus": "...", "reasoning": "..."}
- "refinedFocus" : une à trois phrases en français, concrètes (catégories visées, saisonnalité si pertinente, type de clientèle, contrainte de sourcing si utile) — jamais une simple reformulation vague de ce qui a été donné.
- "reasoning" : une phrase expliquant pourquoi cet axe affiné est pertinent maintenant.
- Si aucun axe n'est donné, propose toi-même un axe raisonnable et diversifié pour un e-commerce généraliste, et dis-le explicitement dans "reasoning" (ex. "aucun axe fourni, proposition par défaut").
- N'invente aucun chiffre de vente ni tendance vérifiée : "refinedFocus" reformule une intention de recherche, ce n'est pas une prédiction.`;

/** Affine un axe de recherche brut (ou en propose un si vide) avant une chasse. Ne touche à aucune donnée — c'est l'appelant qui décide d'en faire usage. */
export async function refineFocus(focus) {
  const trimmed = String(focus || '').trim();
  const raw = await askModel({
    system: COACH_SYSTEM_PROMPT,
    prompt: trimmed ? `Axe de recherche donné : ${trimmed}` : 'Aucun axe donné — propose un axe de recherche pertinent.',
    maxTokens: 500,
  });

  let parsed;
  try {
    parsed = parseJsonFromModel(raw);
  } catch {
    throw new Error(`Réponse IA non exploitable (coach du Dénicheur) : ${raw.slice(0, 200)}`);
  }

  const refinedFocus = typeof parsed.refinedFocus === 'string' ? parsed.refinedFocus.trim() : '';
  if (!refinedFocus) {
    throw new Error(`Réponse IA incomplète (axe affiné manquant) : ${raw.slice(0, 200)}`);
  }

  return {
    refinedFocus,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '',
  };
}
