import { Router } from 'express';
import { huntNiches, latestFinds } from '../ai/nicheHunter.js';

/*
 * Rubrique « Dénicheur » (GET/POST /api/niches).
 * Les résultats sont des suggestions générées par IA, jamais des données de
 * ventes vérifiées — voir l'avertissement dans src/ai/nicheHunter.js.
 */

export const nichesRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

// --- Dernier lot de suggestions ---
nichesRouter.get(
  '/latest',
  asyncRoute(async (req, res) => {
    res.json(await latestFinds());
  }),
);

// --- Lance une nouvelle chasse ---
nichesRouter.post(
  '/hunt',
  asyncRoute(async (req, res) => {
    const { focus } = req.body || {};
    res.json(await huntNiches({ focus }));
  }),
);
