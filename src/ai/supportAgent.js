import { askClaude, parseJsonFromModel } from './client.js';
import { dbGet, dbRun, logActivity } from '../db/database.js';

const SYSTEM_PROMPT = `Tu es agent de support client pour Megalomarket, une boutique d'articles pour enfants vendant sur eBay, Amazon, TikTok Shop et son site propre.
Tu reçois un message client concernant une commande. Réponds UNIQUEMENT avec un objet JSON valide :
{
  "category": "retard_livraison" | "produit_defectueux" | "remboursement" | "question_produit" | "autre",
  "urgency": "faible" | "normale" | "haute",
  "draftReply": "réponse proposée en français, polie et concrète, sans promettre ce que tu ne peux pas garantir"
}
Ne jamais promettre un remboursement automatique ou un geste commercial précis dans la réponse : propose plutôt les prochaines étapes, et laisse la décision finale à un humain pour les cas de remboursement ou litige.`;

export async function qualifySupportMessage({ orderId, customerMessage }) {
  if (!customerMessage || !customerMessage.trim()) {
    throw new Error('Le message client est vide.');
  }

  let order = null;
  let product = null;
  if (orderId) {
    order = await dbGet('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) throw new Error(`Commande introuvable (id=${orderId}).`);
    if (order.product_id) {
      product = await dbGet('SELECT * FROM products WHERE id = ?', [order.product_id]);
    }
  }

  const contextLines = order
    ? `Commande #${order.external_order_id} (${order.channel}) — produit : ${product?.name ?? 'inconnu'}, montant ${order.amount.toFixed(2)} €, statut ${order.status}.`
    : 'Aucune commande précise associée à ce message.';

  const prompt = `${contextLines}

Message du client :
"""
${customerMessage.trim()}
"""`;

  const raw = await askClaude({ system: SYSTEM_PROMPT, prompt, maxTokens: 700 });
  let parsed;
  try {
    parsed = parseJsonFromModel(raw);
  } catch {
    throw new Error(`Réponse IA non exploitable (JSON invalide) : ${raw.slice(0, 200)}`);
  }

  const info = await dbRun(
    'INSERT INTO recommendations (type, channel, product_id, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      'support',
      order?.channel ?? null,
      order?.product_id ?? null,
      JSON.stringify({ ...parsed, orderId, customerMessage }),
      'pending',
      Date.now(),
    ],
  );

  await logActivity('SUPPORT_QUALIFIE', `Message client qualifié : ${parsed.category} (urgence ${parsed.urgency})`);
  return { id: info.lastInsertRowid, ...parsed };
}
