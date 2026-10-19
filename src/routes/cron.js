import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { dbGet } from '../db/database.js';
import { huntNiches } from '../ai/nicheHunter.js';

/*
 * Déclencheur externe du Dénicheur.
 *
 * POURQUOI CETTE ROUTE EXISTE. La chasse était planifiée en interne par
 * `node-cron` (`0 3 * /2 * *`). Or un cron vit À L'INTÉRIEUR du processus : sur
 * l'offre gratuite Render, le service s'endort après quelques minutes
 * d'inactivité, et plus personne ne compte les minutes. Relevé en production :
 * dernier lot vieux de 7 jours, et 32 redémarrages en 30 heures.
 *
 * Un rendez-vous à 3 h du matin n'a donc presque aucune chance de tomber juste.
 * La solution n'est pas de « réparer le cron » : c'est de SORTIR le déclencheur
 * du processus. Un planificateur externe (GitHub Actions) appelle cette route à
 * l'heure dite ; il réveille le service au passage.
 *
 * LE JETON EST DISTINCT DE LA CLÉ ADMIN, à dessein. Il est stocké dans les
 * secrets d'un dépôt Git : s'il fuitait, il ne pourrait que lancer une chasse.
 * Pas de lecture des commandes, des prix ou des clients.
 */

export const cronRouter = Router();

/* Comparaison à durée constante, comme pour la clé admin : un `===` laisserait
   fuir par le temps de réponse le nombre de caractères corrects. */
function safeEqual(presented, expected) {
  const left = Buffer.from(String(presented));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/* Délai minimal entre deux chasses déclenchées de l'extérieur.
   Une chasse coûte DEUX appels au modèle (chasse + supervision). Un jeton
   dérobé pourrait brûler le quota en boucle ; dix minutes suffisent à rendre
   l'abus inintéressant sans gêner un déclencheur hebdomadaire. Pour forcer une
   chasse immédiate, le bouton du tableau de bord passe par la clé admin. */
const COOLDOWN_MS = 10 * 60 * 1000;

cronRouter.post('/denicheur', async (req, res) => {
  /* Échec en fermé : pas de jeton configuré = déclencheur désactivé. Le défaut
     dangereux serait « pas de secret, donc pas de contrôle ». */
  if (!config.cron.secret) {
    return res.status(503).json({
      error: "Déclencheur désactivé : CRON_SECRET n'est pas configurée sur le serveur.",
    });
  }

  const presente = req.get('x-cron-token');
  if (!presente || !safeEqual(presente, config.cron.secret)) {
    return res.status(401).json({ error: 'Jeton de déclenchement absent ou invalide.' });
  }

  const dernier = await dbGet('SELECT MAX(created_at) AS dernier FROM trend_finds');
  const ilYa = dernier?.dernier ? Date.now() - Number(dernier.dernier) : null;
  if (ilYa != null && ilYa < COOLDOWN_MS) {
    const minutes = Math.ceil((COOLDOWN_MS - ilYa) / 60000);
    return res.status(429).json({
      ok: false,
      error: `Une chasse a déjà eu lieu il y a ${Math.round(ilYa / 60000)} min. Réessaie dans ${minutes} min.`,
      dernierLotIlYaMinutes: Math.round(ilYa / 60000),
    });
  }

  try {
    const resultat = await huntNiches({});
    return res.json({
      ok: true,
      batchId: resultat.batchId,
      pistes: resultat.finds.length,
      // `null` = supervision réussie ; une chaîne = elle a échoué mais le lot
      // est conservé (voir le commentaire dans nicheHunter.js).
      supervision: resultat.supervision,
      signalees: resultat.finds.filter((f) => f.reviewOk === false).length,
    });
  } catch (error) {
    // 500 et non 400 : le déclencheur externe doit voir un ÉCHEC, sinon un
    // GitHub Actions vert masquerait une chasse qui n'a jamais eu lieu.
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/** État du déclencheur, pour vérifier la configuration sans lancer de chasse. */
cronRouter.get('/denicheur', async (req, res) => {
  if (!config.cron.secret) {
    return res.status(503).json({ configured: false });
  }
  const presente = req.get('x-cron-token');
  if (!presente || !safeEqual(presente, config.cron.secret)) {
    return res.status(401).json({ error: 'Jeton de déclenchement absent ou invalide.' });
  }

  const dernier = await dbGet('SELECT MAX(created_at) AS dernier FROM trend_finds');
  const ilYa = dernier?.dernier ? Date.now() - Number(dernier.dernier) : null;
  return res.json({
    configured: true,
    dernierLotIlYaMinutes: ilYa == null ? null : Math.round(ilYa / 60000),
    cooldownMinutes: COOLDOWN_MS / 60000,
    pret: ilYa == null || ilYa >= COOLDOWN_MS,
  });
});
