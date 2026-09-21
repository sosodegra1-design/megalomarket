import { askModel, parseJsonFromModel } from './client.js';
import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';

const SYSTEM_PROMPT = `Tu es un expert en tarification e-commerce multicanal pour Megalomarket, une boutique pour enfants.
Tu reçois les prix actuels d'un produit sur plusieurs canaux de vente ainsi que son historique de ventes récent.
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, au format :
{"suggestions": [{"channel": "ebay", "suggestedPrice": 19.90, "rationale": "explication courte en français"}]}
Règles :
- Le prix suggéré ne doit jamais être inférieur au prix de revient (cost_price) fourni.
- Propose une suggestion uniquement pour les canaux où un changement est justifié ; n'invente pas de canal absent des données fournies.
- Sois concret : mentionne le chiffre qui motive ta suggestion (volume de ventes, écart de prix entre canaux, etc.).`;

function buildPrompt(product, listings, recentOrders) {
  const listingLines = listings
    .map((l) => `- ${l.channel} : prix ${l.price.toFixed(2)} €, stock ${l.stock}, statut ${l.status}`)
    .join('\n');
  const orderLines = recentOrders.length
    ? recentOrders.map((o) => `- ${o.channel} : ${o.quantity} unité(s) à ${o.amount.toFixed(2)} € le ${new Date(o.created_at).toLocaleDateString('fr-FR')}`).join('\n')
    : 'Aucune vente enregistrée récemment.';

  return `Produit : ${product.name} (SKU ${product.sku})
Prix de revient : ${product.cost_price.toFixed(2)} €

Prix actuels par canal :
${listingLines || 'Aucun canal actif.'}

Ventes récentes :
${orderLines}`;
}

export async function generatePriceRecommendations(productId) {
  const product = await dbGet('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw new Error(`Produit introuvable (id=${productId}).`);

  const listings = await dbAll('SELECT * FROM channel_listings WHERE product_id = ?', [productId]);
  const recentOrders = await dbAll(
    'SELECT * FROM orders WHERE product_id = ? ORDER BY created_at DESC LIMIT 20',
    [productId],
  );

  const prompt = buildPrompt(product, listings, recentOrders);
  const raw = await askModel({ system: SYSTEM_PROMPT, prompt, maxTokens: 800 });

  let parsed;
  try {
    parsed = parseJsonFromModel(raw);
  } catch {
    throw new Error(`Réponse IA non exploitable (JSON invalide) : ${raw.slice(0, 200)}`);
  }

  const saved = [];
  for (const suggestion of parsed.suggestions || []) {
    if (typeof suggestion.suggestedPrice !== 'number' || suggestion.suggestedPrice < product.cost_price) {
      continue; // ignore une suggestion incohérente plutôt que de la stocker aveuglément
    }
    const info = await dbRun(
      'INSERT INTO recommendations (type, channel, product_id, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['price', suggestion.channel, productId, JSON.stringify(suggestion), 'pending', Date.now()],
    );
    saved.push({ id: info.lastInsertRowid, ...suggestion });
  }

  await logActivity('RECOMMANDATION_PRIX', `${saved.length} suggestion(s) de prix générée(s) pour "${product.name}"`);
  return saved;
}
