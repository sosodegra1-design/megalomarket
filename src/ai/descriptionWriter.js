import { askClaude } from './client.js';
import { dbGet, dbRun, logActivity } from '../db/database.js';

const CHANNEL_GUIDANCE = {
  ebay: 'Description eBay : orientée mots-clés de recherche, liste les caractéristiques techniques en points courts, ton factuel.',
  amazon: "Description Amazon : structure en avantages clients, respecte les conventions Amazon (pas de promotions, pas de coordonnées de contact).",
  tiktok_shop: 'Description TikTok Shop : ton jeune et dynamique, phrases courtes, orientée émotion et usage au quotidien.',
  own_site: 'Description site propre : ton chaleureux et rassurant pour des parents, peut être plus longue et storytelling.',
};

const SYSTEM_PROMPT = `Tu es rédacteur e-commerce spécialisé jouets et articles pour enfants pour la marque Megalomarket.
Réponds UNIQUEMENT avec un objet JSON valide : {"description": "texte de la description"}
La description doit être en français, sans emoji, sans superlatifs non justifiés, et respecter les consignes du canal fournies.`;

export async function generateDescription(productId, channel) {
  const product = await dbGet('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw new Error(`Produit introuvable (id=${productId}).`);
  const guidance = CHANNEL_GUIDANCE[channel];
  if (!guidance) throw new Error(`Canal inconnu : ${channel}`);

  const prompt = `Produit : ${product.name}
Description de base (site propre ou fiche produit interne) : ${product.description || '(aucune description existante)'}

Consigne du canal ${channel} : ${guidance}

Rédige une description adaptée à ce canal.`;

  const raw = await askClaude({ system: SYSTEM_PROMPT, prompt, maxTokens: 600 });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Réponse IA non exploitable (JSON invalide) : ${raw.slice(0, 200)}`);
  }
  if (!parsed.description) throw new Error('La réponse IA ne contient pas de description.');

  const info = await dbRun(
    'INSERT INTO recommendations (type, channel, product_id, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['description', channel, productId, JSON.stringify(parsed), 'pending', Date.now()],
  );

  await logActivity('RECOMMANDATION_DESCRIPTION', `Nouvelle description proposée pour "${product.name}" (${channel})`);
  return { id: info.lastInsertRowid, ...parsed };
}
