import { dbGet, dbRun, logActivity } from '../db/database.js';
import { connectors } from '../connectors/index.js';

/**
 * Inscrit le catalogue LumiVita dans la base de Megalomarket.
 *
 * Jusqu'ici le connecteur lisait le catalogue mais rien ne l'utilisait. Cette
 * synchronisation crée, pour chaque produit, une ligne `products` (SKU LV-xxx)
 * et une fiche canal `lumivita` en pause. Idempotente : relancée, elle ne
 * duplique rien et ne touche JAMAIS à un prix d'achat déjà saisi.
 *
 * Le catalogue n'a aucun prix : `cost_price` reste à 0 tant que l'administrateur
 * ne l'a pas renseigné — le verrou anti-vente à perte bloque alors tout prix
 * conseillé, rien n'est inventé.
 */
export async function syncLumivitaCatalogue({ connector = connectors.lumivita } = {}) {
  const products = await connector.listProducts();
  const result = { created: 0, existing: 0, total: products.length };

  for (const item of products) {
    if (!item.sku || !item.name) continue;

    let row = await dbGet('SELECT id FROM products WHERE sku = ?', [item.sku]);
    if (row) {
      result.existing += 1;
    } else {
      const info = await dbRun(
        'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, 0, ?)',
        [item.sku, item.name, item.description || '', Date.now()],
      );
      row = { id: Number(info.lastInsertRowid) };
      result.created += 1;
    }

    await dbRun(
      `INSERT OR IGNORE INTO channel_listings (product_id, channel, external_id, price, description, stock, status, updated_at)
       VALUES (?, 'lumivita', ?, 0, ?, 0, 'paused', ?)`,
      [row.id, item.sku, item.description || '', Date.now()],
    );
  }

  if (result.created > 0) {
    await logActivity('LUMIVITA_SYNC', `Catalogue LumiVita : ${result.created} produit(s) ajouté(s), prix d'achat à renseigner.`);
  }
  return result;
}
