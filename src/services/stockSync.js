import { dbRun, logActivity } from '../db/database.js';
import { connectors, activeChannels } from '../connectors/index.js';

/**
 * Récupère le stock actuel depuis chaque canal configuré et met à jour channel_listings.
 * Un canal non configuré (clés manquantes) est simplement ignoré, sans faire échouer les autres.
 */
export async function syncStockFromAllChannels() {
  const results = { updated: 0, errors: [] };

  for (const channel of activeChannels()) {
    try {
      const items = await connectors[channel].listInventoryItems();
      for (const item of items) {
        const info = await dbRun(
          `INSERT INTO channel_listings (product_id, channel, external_id, price, stock, status, updated_at)
           SELECT id, ?, ?, 0, ?, 'active', ?
           FROM products WHERE sku = ?
           ON CONFLICT(product_id, channel) DO UPDATE SET stock = excluded.stock, updated_at = excluded.updated_at`,
          [channel, item.sku, item.quantity, Date.now(), item.sku],
        );
        if (info.changes > 0) results.updated += 1;
      }
    } catch (error) {
      results.errors.push({ channel, message: error.message });
    }
  }

  await logActivity(
    'SYNC_STOCK',
    `Synchronisation stock : ${results.updated} ligne(s) mise(s) à jour${results.errors.length ? `, ${results.errors.length} erreur(s)` : ''}.`,
  );
  return results;
}
