import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env.js';

let client = null;

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

export async function askClaude({ system, prompt, maxTokens = 1024 }) {
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
