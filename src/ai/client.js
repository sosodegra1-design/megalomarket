import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env.js';

let client = null;

// Au-delà de ce délai, le fournisseur est considéré comme injoignable. Les
// paliers gratuits saturent et laissent parfois la connexion ouverte sans
// jamais répondre : sans borne, la requête Express (import, support) resterait
// bloquée indéfiniment. 30 s couvre les générations les plus longues (la fiche
// du site propre demande jusqu'à 2500 jetons) tout en libérant l'appelant dans
// un délai acceptable. Même approche que le connecteur site et le scraper.
const AI_TIMEOUT_MS = 30000;

export function getAnthropicClient() {
  if (!config.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY manquante — ajoute-la dans le fichier .env pour activer les recommandations IA.",
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

/** Chemin Anthropic : SDK officiel, comportement inchangé. */
async function askAnthropic({ system, prompt, maxTokens }) {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: config.anthropicModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : '';
}

/**
 * Chemin « compatible OpenAI » : une seule implémentation couvre Groq,
 * Cerebras, OpenRouter, Gemini, Mistral et Ollama local, car tous exposent
 * POST /chat/completions avec le même format de requête et de réponse. Le SDK
 * Anthropic ne sert donc plus qu'au chemin Anthropic.
 */
async function askOpenAiCompatible({ system, prompt, maxTokens }) {
  // Une base terminée par un slash (fréquent dans une variable recopiée)
  // produirait « //chat/completions » ; on la normalise ici.
  const baseUrl = String(config.ai.baseUrl).replace(/\/+$/, '');
  const provider = config.ai.provider;

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: maxTokens,
        // Le message système précède toujours le message utilisateur : les
        // fournisseurs compatibles suivent cette convention pour appliquer les
        // consignes (répondre en JSON, ne rien inventer…).
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(
        `Fournisseur IA « ${provider} » injoignable (${baseUrl}) : aucune réponse en ${AI_TIMEOUT_MS / 1000} s. ` +
        'Vérifie AI_BASE_URL et que le service est bien en ligne.',
      );
    }
    throw new Error(`Impossible de contacter le fournisseur IA « ${provider} » (${baseUrl}) : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    // On lit le corps pour le rendre tel quel : les fournisseurs y mettent la
    // cause exacte (quota, modèle inconnu, clé révoquée). La masquer
    // transformerait un problème réparable en panne opaque.
    const detail = await response.text().catch(() => '');

    // 429 : les paliers gratuits plafonnent par minute ET par jour. Le dire
    // évite de croire à une panne et de relancer en boucle.
    if (response.status === 429) {
      throw new Error(
        `Quota IA dépassé (HTTP 429) chez « ${provider} » — les paliers gratuits plafonnent par minute et par jour. ` +
        'Attends la fenêtre suivante (ou le lendemain) avant de réessayer, ou change de fournisseur via AI_BASE_URL/AI_API_KEY/AI_MODEL. ' +
        `Réponse du fournisseur : ${detail.slice(0, 300)}`,
      );
    }

    // 401/403 : clé absente, mauvaise ou révoquée.
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Authentification refusée (HTTP ${response.status}) chez « ${provider} » — vérifie AI_API_KEY dans .env. ` +
        `Réponse du fournisseur : ${detail.slice(0, 300)}`,
      );
    }

    throw new Error(`Erreur du fournisseur IA « ${provider} » (HTTP ${response.status}) : ${detail.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "Réponse IA illisible : le fournisseur n'a pas renvoyé du JSON. " +
      'Vérifie que AI_BASE_URL pointe bien sur une API compatible OpenAI (elle doit se terminer par /v1).',
    );
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(
      "Réponse IA inattendue : le fournisseur n'a pas renvoyé choices[0].message.content. " +
      `Vérifie que AI_BASE_URL et AI_MODEL correspondent bien à une API compatible OpenAI.`,
    );
  }
  return content;
}

/**
 * Point d'entrée UNIQUE de toutes les fonctions IA.
 * `askClaude` a été renommé `askModel` : le nom mentait dès que le fournisseur
 * devenait configurable. Les appelants n'ont pas à savoir quel fournisseur est
 * actif — ils envoient un système + un prompt et reçoivent du texte.
 */
export async function askModel({ system, prompt, maxTokens = 1024 }) {
  // On refuse AVANT tout appel réseau, avec la raison exacte (variable
  // manquante), plutôt que de laisser le fournisseur renvoyer un 401 obscur.
  if (!config.ai.ready) {
    throw new Error(config.ai.reason);
  }
  if (config.ai.provider === 'anthropic') {
    return askAnthropic({ system, prompt, maxTokens });
  }
  return askOpenAiCompatible({ system, prompt, maxTokens });
}

/**
 * Isole le premier objet ou tableau JSON équilibré à partir de `start`.
 * Les accolades/crochets situés dans une chaîne ne comptent pas : une
 * description contenant « { » casserait un simple comptage de caractères.
 * Retourne null si l'ouverture n'est jamais refermée.
 */
function extractBalanced(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extrait la valeur JSON d'une réponse de modèle.
 * Tous les prompts demandent « uniquement un objet JSON », mais les modèles
 * enveloppent régulièrement leur réponse dans un bloc markdown (```json … ```)
 * ou ajoutent une phrase avant/après. Un `JSON.parse` brut échoue alors que la
 * réponse est parfaitement exploitable ; on tolère donc ces emballages plutôt
 * que de perdre la génération. Lève une erreur explicite (mentionnant JSON)
 * quand il n'y a réellement rien à parser, pour que les appelants conservent
 * leur gestion d'erreur.
 */
export function parseJsonFromModel(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Réponse IA non exploitable (JSON invalide) : réponse vide.');
  }

  // Cas nominal : le modèle a obéi, on ne complique pas la lecture.
  try {
    return JSON.parse(raw);
  } catch {
    // Réponse emballée : on tente les stratégies d'extraction ci-dessous.
  }

  // Bloc markdown, avec ou sans langage (```json / ```).
  const fencePattern = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let fence;
  while ((fence = fencePattern.exec(raw)) !== null) {
    const inner = fence[1].trim();
    try {
      return JSON.parse(inner);
    } catch {
      // Bloc inexploitable : on essaie le suivant, puis la prose autour.
    }
  }

  // Dernier recours : le premier objet/tableau équilibré, prose ignorée.
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== '{' && char !== '[') continue;
    const candidate = extractBalanced(raw, i);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Candidat invalide (ex. accolade dans la prose) : on cherche le suivant.
    }
  }

  throw new Error(`Réponse IA non exploitable (JSON invalide) : ${raw.slice(0, 200)}`);
}
