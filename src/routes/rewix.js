import { Router } from 'express';
import { config } from '../config/env.js';
import { syncRewixCatalog, rewixStatus } from '../services/rewixSync.js';

/*
 * Routes du connecteur Rewix.
 *
 * L'état est séparé de la synchronisation : on veut pouvoir savoir si le
 * connecteur est configuré SANS lancer un appel réseau. C'est ce qui évite de
 * cliquer sur « Synchroniser » pour découvrir qu'il manque une variable.
 */

export const rewixRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

rewixRouter.get(
  '/status',
  asyncRoute(async (req, res) => {
    const etat = await rewixStatus();
    res.json({
      configured: config.rewix.ready,
      // On ne renvoie jamais la clé ni le mot de passe — seulement s'ils sont là.
      // L'URL de base non plus : elle identifie le fournisseur.
      baseUrlConfiguree: Boolean(config.rewix.baseUrl),
      locales: config.rewix.locales,
      ...etat,
    });
  }),
);

rewixRouter.post(
  '/sync',
  asyncRoute(async (req, res) => {
    // `complet: true` force une synchronisation sans curseur : c'est la sortie
    // de secours quand Rewix répond 412 (instantané de plus de 4 heures).
    const complet = req.body?.complet === true || String(req.query.complet || '') === '1';
    const resultat = await syncRewixCatalog({ incremental: !complet });
    res.json(resultat);
  }),
);
