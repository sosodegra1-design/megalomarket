import { dbGet, dbRun, logActivity } from '../db/database.js';
import { connectors, activeChannels } from '../connectors/index.js';

/**
 * Curseur temporel du sync commandes, en mémoire du processus.
 *
 * eBay n'offre pas de curseur côté API : sans repère, chaque cycle de 5 minutes
 * repartait de zéro et re-paginait tout l'historique récent, jusqu'à 20 appels
 * par cycle (≈ 5 760/jour), au-delà de l'enveloppe quotidienne d'environ 5 000
 * appels des Sell APIs. On mémorise donc l'heure de DÉBUT du dernier cycle
 * réussi, et on la repasse en `since` au cycle suivant.
 *
 * Objet (et non simple `let`) pour rester injectable dans les tests : chaque
 * test fournit son propre état et n'hérite pas du curseur d'un autre.
 */
const orderSyncState = { lastSuccessfulSyncStartedAt: null };

/**
 * Marge de recouvrement appliquée au curseur. Elle ne coûte rien : les
 * commandes déjà vues sont ignorées par `INSERT OR IGNORE`, donc les relire est
 * gratuit côté base. En revanche elle protège contre une commande dont la date
 * de création est publiée avec du retard côté eBay, et contre une légère
 * dérive d'horloge entre le serveur et eBay — sans elle, une commande à cheval
 * sur la frontière du curseur serait perdue définitivement.
 */
export const SYNC_OVERLAP_MS = 5 * 60 * 1000;

/**
 * Fenêtre de repli au démarrage à froid (redémarrage du process, curseur perdu).
 * On ne repart pas de tout l'historique : eBay ne documente le filtre que sur
 * 90 jours, et re-paginer l'historique complet à chaque redémarrage est
 * exactement le coût qu'on cherche à supprimer. 24 h couvrent largement le
 * temps d'un redémarrage/déploiement, et le reste est de toute façon déjà en
 * base (idempotence).
 */
export const COLD_START_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Récupère les commandes récentes de chaque canal configuré et les enregistre localement.
 *
 * Toutes les dépendances sont injectables (comme le `logger` de scheduler.js)
 * pour pouvoir tester le curseur temporel sans base de données, sans réseau et
 * sans horloge réelle.
 */
export async function syncOrdersFromAllChannels({
  channels = activeChannels(),
  registry = connectors,
  db = { get: dbGet, run: dbRun },
  log = logActivity,
  now = Date.now,
  state = orderSyncState,
} = {}) {
  const results = { created: 0, errors: [] };
  const startedAt = now();

  const since = new Date(
    state.lastSuccessfulSyncStartedAt == null
      ? startedAt - COLD_START_WINDOW_MS
      : state.lastSuccessfulSyncStartedAt - SYNC_OVERLAP_MS,
  ).toISOString();

  for (const channel of channels) {
    // Un canal n'a pas forcément de commandes à lire : le site propre, par
    // exemple, n'expose aucune route de commandes. Sans ce garde-fou, chaque
    // cycle enregistrait un échec « listOrders is not a function » qui masquait
    // les vraies erreurs dans le journal.
    if (typeof registry[channel]?.listOrders !== 'function') continue;

    try {
      const orders = await registry[channel].listOrders({ since });
      for (const order of orders) {
        const firstItem = order.lineItems?.[0];
        const product = firstItem ? await db.get('SELECT id FROM products WHERE sku = ?', [firstItem.sku]) : null;
        const info = await db.run(
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

  // Le curseur n'avance que si TOUS les canaux ont réussi. Si eBay a échoué, on
  // réessaiera la même fenêtre au prochain cycle plutôt que de sauter
  // définitivement les commandes vues pendant la panne.
  if (results.errors.length === 0) state.lastSuccessfulSyncStartedAt = startedAt;

  await log(
    'SYNC_COMMANDES',
    `Synchronisation commandes : ${results.created} nouvelle(s)${results.errors.length ? `, ${results.errors.length} erreur(s)` : ''}.`,
  );
  return results;
}
