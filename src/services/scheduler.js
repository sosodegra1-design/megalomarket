import cron from 'node-cron';
import { syncStockFromAllChannels } from './stockSync.js';
import { syncOrdersFromAllChannels } from './orderSync.js';
import { huntNiches } from '../ai/nicheHunter.js';
import { processPendingReturns } from './returnFulfillment.js';
import { runQualitySupervision } from './qualitySupervisor.js';
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

/**
 * Démarre les tâches périodiques. Ne fait rien si aucun canal n'est configuré (rien à synchroniser).
 *
 * Les dépendances sont injectables — mêmes raisons que le `logger` de `runSafely` :
 * les tests doivent pouvoir vérifier les expressions enregistrées, l'option
 * `noOverlap` et le filet de sécurité sans planifier de vrai timer, sans base de
 * données et sans réseau. Les valeurs par défaut reproduisent exactement le
 * comportement de production, donc `startScheduler()` reste l'appel unique de
 * server.js.
 */
export async function startScheduler({
  schedule = cron.schedule,
  stockJob = syncStockFromAllChannels,
  ordersJob = syncOrdersFromAllChannels,
  nicheJob = huntNiches,
  returnsJob = processPendingReturns,
  qualityJob = runQualitySupervision,
  logger = logActivity,
} = {}) {
  /*
   * `noOverlap: true` sur les deux tâches. Elles sont périodiques et
   * idempotentes : deux exécutions simultanées n'apportent aucun résultat
   * supplémentaire, mais doublent les écritures en base et surtout la
   * consommation du quota d'appels eBay (≈ 5 000/jour, voir orderSync.js). Si un
   * cycle dépasse son intervalle, node-cron 4 saute donc le tick suivant au lieu
   * d'empiler une seconde synchronisation. Contrepartie assumée : un cycle qui
   * ne se terminerait jamais gèlerait les ticks suivants — c'est préférable à des
   * requêtes suspendues qui s'accumulent sans limite, et node-cron journalise
   * l'événement `execution:overlap` à chaque tick sauté.
   */
  // Stock : toutes les 15 minutes
  schedule('*/15 * * * *', () => runSafely('stock', stockJob, logger), { noOverlap: true });

  // Commandes : toutes les 5 minutes
  schedule('*/5 * * * *', () => runSafely('commandes', ordersJob, logger), { noOverlap: true });

  /*
   * DÉNICHEUR : PLUS DE CRON INTERNE — ET C'EST VOLONTAIRE.
   *
   * Il y avait ici `schedule('0 3 *\/2 * *', ...)`. Ce rendez-vous ne se
   * déclenchait jamais : un cron vit À L'INTÉRIEUR du processus, et l'offre
   * gratuite Render endort le service. Relevé en production : dernier lot de
   * pépites vieux de 7 jours, 32 redémarrages en 30 heures.
   *
   * Le laisser en place serait pire que de le retirer : il donnerait
   * l'illusion d'une actualisation automatique, et le jour où le service
   * resterait éveillé par hasard, il lancerait une chasse EN PLUS du
   * déclencheur externe — deux lots concurrents pour la même semaine.
   *
   * La chasse est désormais déclenchée de l'extérieur :
   *   POST /api/cron/denicheur  (voir routes/cron.js)
   *   .github/workflows/denicheur.yml  — chaque lundi 6 h UTC.
   *
   * `nicheJob` reste un paramètre d'injection (les tests s'en servent), mais il
   * n'est plus planifié ici.
   */

  /*
   * Retours (e-mail SAV) : toutes les 10 minutes. Idempotent — chaque retour
   * traité avance son statut ('requested' -> 'label_sent'/'instructions_sent'),
   * donc un cycle qui tomberait sur une demande déjà traitée au tour précédent
   * ne la retraite pas et n'envoie pas un second e-mail.
   */
  schedule('*/10 * * * *', () => runSafely('retours', returnsJob, logger), { noOverlap: true });

  /*
   * Contrôle qualité (photos des fiches publiées) : toutes les 30 minutes,
   * par lot borné (voir BATCH_LIMIT dans qualitySupervisor.js) — chaque
   * fiche n'est relue qu'une fois, donc un cycle qui tomberait sur un lot
   * déjà entièrement relu ne fait rien (comportement idempotent, comme les
   * autres tâches planifiées).
   */
  schedule('*/30 * * * *', () => runSafely('controle_qualite', qualityJob, logger), { noOverlap: true });

  /*
   * Pas de tâche périodique de PUSH.
   *
   * Le stock est la seule valeur qui dérive toute seule, mais aucun canal ne
   * sait encore la recevoir : le site propre n'a aucune notion de stock (voir
   * ownSite.js) et `listInventoryItems` y renvoie une liste vide, tandis
   * qu'aucun connecteur actif n'expose de mise à jour de quantité. Une tâche planifiée
   * n'aurait donc rien à pousser et se contenterait d'écrire un journal
   * « ignoré » toutes les 15 minutes — du bruit qui masquerait les vraies
   * erreurs. Le push reste déclenché par une action explicite (bouton
   * « appliquer » d'une recommandation, POST /api/products/:id/price), ce qui
   * est le bon modèle tant qu'un canal ne publie pas son stock.
   * À rebrancher le jour où un connecteur exposera updateStock.
   */

  // Le message doit dire la VÉRITÉ sur ce qui est planifié. Il annonçait encore un
  // « Dénicheur : tous les 2 jours » alors que ce cron est retiré (déclencheur
  // externe) : un journal qui décrit une tâche inexistante fait chercher au
  // mauvais endroit le jour où elle ne tourne pas.
  await logSafely(
    'DEMARRAGE',
    'Planificateur de synchronisation démarré (stock: 15 min, commandes: 5 min, retours: 10 min, contrôle qualité: 30 min). Dénicheur : déclencheur externe, voir /api/cron/denicheur.',
    logger,
  );
}
