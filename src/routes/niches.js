import { Router } from 'express';
import { huntNiches, latestFinds } from '../ai/nicheHunter.js';
import { refineFocus } from '../ai/nicheCoach.js';
import { reviewBatch } from '../ai/nicheSupervisor.js';
import { findSupplierLinks } from '../ai/supplierFinder.js';
import { dbRun } from '../db/database.js';

/*
 * Rubrique « Dénicheur » (GET/POST /api/niches).
 * Les résultats sont des suggestions générées par IA, jamais des données de
 * ventes vérifiées — voir l'avertissement dans src/ai/nicheHunter.js.
 *
 * Deux agents encadrent le chasseur (huntNiches), chacun appelé séparément
 * et jamais enchaîné en silence, pour que l'utilisateur garde la main à
 * chaque étape :
 *   - le coach (nicheCoach.js) affine l'axe de recherche AVANT une chasse ;
 *   - le superviseur (nicheSupervisor.js) relit un lot déjà généré APRÈS coup.
 *
 * La recherche fournisseur (supplierFinder.js, Perplexity Agent API) est un
 * troisième appel séparé, à la demande (par ligne), pas un enchaînement
 * automatique : elle coûte une vraie requête payante par appel.
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

// --- Agent coach : affine un axe de recherche avant de lancer une chasse ---
nichesRouter.post(
  '/coach',
  asyncRoute(async (req, res) => {
    const { focus } = req.body || {};
    res.json(await refineFocus(focus));
  }),
);

// --- Agent superviseur : relit un lot déjà généré ---
nichesRouter.post(
  '/:batchId/review',
  asyncRoute(async (req, res) => {
    res.json(await reviewBatch(req.params.batchId));
  }),
);

// --- Recherche fournisseur réelle (Perplexity Agent API) pour une suggestion ---
nichesRouter.post(
  '/supplier-search',
  asyncRoute(async (req, res) => {
    const { title, sourcingHint, findId } = req.body || {};
    const resultat = await findSupplierLinks({ title, sourcingHint });

    /* ON ENREGISTRE LE MEILLEUR LIEN quand la piste est identifiée.
     *
     * Sans cela, recharger la page perdait le résultat et il fallait recliquer
     * sur chaque piste — vingt recherches pour vingt produits. Le premier lien
     * est retenu : c'est celui que le chercheur a vérifié en premier. */
    const premier = (resultat?.links || [])[0];
    if (findId != null && premier?.url) {
      await dbRun(
        'UPDATE trend_finds SET supplier_url = ?, supplier_label = ?, supplier_searched_at = ? WHERE id = ?',
        [premier.url, premier.label || premier.url, Date.now(), Number(findId)],
      );
    }
    res.json(resultat);
  }),
);
