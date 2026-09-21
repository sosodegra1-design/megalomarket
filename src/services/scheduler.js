import cron from 'node-cron';
import { syncStockFromAllChannels } from './stockSync.js';
import { syncOrdersFromAllChannels } from './orderSync.js';
import { logActivity } from '../db/database.js';

/**
 * Journalise sans jamais laisser remonter l'échec de la journalisation.
 * `logActivity` écrit en base : si cette écriture échoue, la promesse rejetée
 * ferait terminer le processus (comportement par défaut de Node depuis la v15)
 * pour une simple ligne de log. Perdre le log est préférable à perdre le
 * service, donc l'erreur est seulement tracée sur la console.
 * `logger` est injectable pour rendre ce comportement testable sans base.
 */
async function logSafely(kind, message, logger = logActivity) {
  try {
    await logger(kind, message);
  } catch (logError) {
    console.error(`[scheduler] Échec de la journalisation (${kind}) : ${logError?.message ?? logError}`);
  }
}

/**
 * Exécute une tâche planifiée en isolant totalement ses échecs.
 * Ni l'échec de la tâche, ni celui de sa journalisation ne doivent s'échapper :
 * un callback cron qui rejette sans être attendu déclenche un rejet non géré,
 * et Node termine alors le processus au lieu de se contenter de logger.
 * `logger` est injectable pour tester ce filet de sécurité sans base de données.
 */
export async function runSafely(label, fn, logger = logActivity) {
  try {
    await fn();
  } catch (error) {
    await logSafely('ERREUR_SYNC', `Échec de la synchronisation ${label} planifiée : ${error?.message ?? error}`, logger);
  }
}

/** Démarre les tâches périodiques. Ne fait rien si aucun canal n'est configuré (rien à synchroniser). */
export async function startScheduler() {
  // Stock : toutes les 15 minutes
  cron.schedule('*/15 * * * *', () => runSafely('stock', syncStockFromAllChannels));

  // Commandes : toutes les 5 minutes
  cron.schedule('*/5 * * * *', () => runSafely('commandes', syncOrdersFromAllChannels));

  /*
   * Pas de tâche périodique de PUSH.
   *
   * Le stock est la seule valeur qui dérive toute seule, mais aucun canal ne
   * sait encore la recevoir : le site propre n'a aucune notion de stock (voir
   * ownSite.js) et `listInventoryItems` y renvoie une liste vide, tandis
   * qu'ebay.js n'expose pas de mise à jour de quantité. Une tâche planifiée
   * n'aurait donc rien à pousser et se contenterait d'écrire un journal
   * « ignoré » toutes les 15 minutes — du bruit qui masquerait les vraies
   * erreurs. Le push reste déclenché par une action explicite (bouton
   * « appliquer » d'une recommandation, POST /api/products/:id/price), ce qui
   * est le bon modèle tant qu'un canal ne publie pas son stock.
   * À rebrancher le jour où un connecteur exposera updateStock.
   */

  await logSafely('DEMARRAGE', 'Planificateur de synchronisation démarré (stock: 15 min, commandes: 5 min).');
}
