/*
 * Vérifie que Megalomarket peut parler à Ollama sur cette machine.
 *
 *   1. Ollama répond-il à l'adresse de AI_BASE_URL ?
 *   2. Le modèle indiqué dans AI_MODEL est-il téléchargé ?
 *   3. Un vrai appel passe-t-il par le même chemin que l'application ?
 *
 * Lancement : npm run verify:ollama   (le fichier .env est lu s'il existe)
 */

import 'dotenv/config';
import { config } from '../src/config/env.js';
import { askModel } from '../src/ai/client.js';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

if (!config.ai.ready) fail(config.ai.reason);
if (config.ai.provider !== 'openai') {
  fail('Le fournisseur actif est Anthropic, pas Ollama. Dans .env : AI_PROVIDER=openai, AI_BASE_URL=http://localhost:11434/v1, AI_API_KEY=ollama, AI_MODEL=<ton modèle>.');
}

const baseUrl = String(config.ai.baseUrl).replace(/\/+$/, '');
const origin = new URL(baseUrl).origin;
console.log(`Fournisseur : ${baseUrl}  ·  modèle : ${config.ai.model}  ·  délai : ${config.ai.timeoutMs / 1000} s`);

let installed;
try {
  const response = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  installed = (await response.json()).models?.map((model) => model.name) ?? [];
} catch (error) {
  fail(`Ollama ne répond pas sur ${origin} (${error.message}). Lance l'application Ollama (ou « ollama serve »), puis relance ce contrôle.`);
}
console.log(`  ✓ Ollama répond (${installed.length} modèle(s) installé(s))`);

// « llama3.1 » désigne « llama3.1:latest » : on accepte les deux écritures.
const wanted = config.ai.model;
const found = installed.some((name) => name === wanted || name === `${wanted}:latest` || name.split(':')[0] === wanted);
if (!found) {
  fail(`Le modèle « ${wanted} » n'est pas installé. Installés : ${installed.join(', ') || 'aucun'}. Télécharge-le avec : ollama pull ${wanted}`);
}
console.log(`  ✓ Modèle « ${wanted} » installé`);

console.log('  … test d\'un appel réel (le premier appel charge le modèle en mémoire, cela peut être long)');
const started = Date.now();
try {
  const reply = await askModel({
    system: 'Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour.',
    prompt: 'Renvoie {"ok": true}.',
    maxTokens: 50,
  });
  console.log(`  ✓ Réponse reçue en ${((Date.now() - started) / 1000).toFixed(1)} s : ${reply.trim().slice(0, 120)}`);
} catch (error) {
  fail(`${error.message}\n    Si c'est un dépassement de délai, augmente AI_TIMEOUT_MS dans .env (ex. 180000).`);
}
console.log('\nOllama est correctement branché.\n');
