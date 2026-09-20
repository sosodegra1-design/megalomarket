import { dbGet, dbRun, logActivity } from '../db/database.js';
import { connectors, activeChannels } from '../connectors/index.js';

/** Récupère les commandes récentes de chaque canal configuré et les enregistre localement. */
export async function syncOrdersFromAllChannels() {
  const results = { created: 0, errors: [] };

  for (const channel of activeChannels()) {
    try {
      const orders = await connectors[channel].listOrders();
      for (const order of orders) {
        const firstItem = order.lineItems?.[0];
        const product = firstItem ? await dbGet('SELECT id FROM products WHERE sku = ?', [firstItem.sku]) : null;
        const info = await dbRun(
          `INSERT OR IGNORE INTO orders (channel, external_order_id, product_id, quantity, amount, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            channel,
            order.externalOrderId,
            product?.id ?? null,
            firstItem?.quantity ?? 1,
            order.amount,
            order.status || 'pending',
            order.createdAt ? new Date(order.createdAt).getTime() : Date.now(),
          ],
        );
        if (info.changes > 0) results.created += 1;
      }
    } catch (error) {
      results.errors.push({ channel, message: error.message });
    }
  }

  await logActivity(
    'SYNC_COMMANDES',
    `Synchronisation commandes : ${results.created} nouvelle(s)${results.errors.length ? `, ${results.errors.length} erreur(s)` : ''}.`,
  );
  return results;
}
