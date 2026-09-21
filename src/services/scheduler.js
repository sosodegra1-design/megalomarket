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

  await logSafely('DEMARRAGE', 'Planificateur de synchronisation démarré (stock: 15 min, commandes: 5 min).');
}
