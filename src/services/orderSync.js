import { db, logActivity } from '../db/database.js';
import { connectors, activeChannels } from '../connectors/index.js';

/** Récupère les commandes récentes de chaque canal configuré et les enregistre localement. */
export async function syncOrdersFromAllChannels() {
  const results = { created: 0, errors: [] };

  const findProductBySku = db.prepare('SELECT id FROM products WHERE sku = ?');
  const insertOrder = db.prepare(`
    INSERT OR IGNORE INTO orders (channel, external_order_id, product_id, quantity, amount, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const channel of activeChannels()) {
    try {
      const orders = await connectors[channel].listOrders();
      for (const order of orders) {
        const firstItem = order.lineItems?.[0];
        const product = firstItem ? findProductBySku.get(firstItem.sku) : null;
        const info = insertOrder.run(
          channel,
          order.externalOrderId,
          product?.id ?? null,
          firstItem?.quantity ?? 1,
          order.amount,
          order.status || 'pending',
          order.createdAt ? new Date(order.createdAt).getTime() : Date.now(),
        );
        if (info.changes > 0) results.created += 1;
      }
    } catch (error) {
      results.errors.push({ channel, message: error.message });
    }
  }

  logActivity(
    'SYNC_COMMANDES',
    `Synchronisation commandes : ${results.created} nouvelle(s)${results.errors.length ? `, ${results.errors.length} erreur(s)` : ''}.`,
  );
  return results;
}
