import cron from 'node-cron';
import { syncStockFromAllChannels } from './stockSync.js';
import { syncOrdersFromAllChannels } from './orderSync.js';
import { logActivity } from '../db/database.js';

/** Démarre les tâches périodiques. Ne fait rien si aucun canal n'est configuré (rien à synchroniser). */
export function startScheduler() {
  // Stock : toutes les 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      await syncStockFromAllChannels();
    } catch (error) {
      logActivity('ERREUR_SYNC', `Échec de la synchronisation stock planifiée : ${error.message}`);
    }
  });

  // Commandes : toutes les 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await syncOrdersFromAllChannels();
    } catch (error) {
      logActivity('ERREUR_SYNC', `Échec de la synchronisation commandes planifiée : ${error.message}`);
    }
  });

  logActivity('DEMARRAGE', 'Planificateur de synchronisation démarré (stock: 15 min, commandes: 5 min).');
}
