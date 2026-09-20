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
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : '';
}
