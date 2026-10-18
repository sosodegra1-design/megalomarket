import { Router } from 'express';
import { connectors } from '../connectors/index.js';
import { syncLumivitaCatalogue } from '../services/lumivitaSync.js';

/*
 * Rubrique LumiVita (GET/POST /api/lumivita).
 * Catalogue statique en lecture seule : on peut le lire et l'inscrire en base,
 * jamais y publier (voir connectors/lumivita.js).
 */

export const lumivitaRouter = Router();

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  };
}

lumivitaRouter.get('/products', asyncRoute(async (req, res) => {
  res.json(await connectors.lumivita.listProducts());
}));

lumivitaRouter.post('/sync', asyncRoute(async (req, res) => {
  res.json(await syncLumivitaCatalogue());
}));
