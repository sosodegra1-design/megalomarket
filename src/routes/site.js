import { Router } from 'express';
import { connectors } from '../connectors/index.js';
import { logActivity } from '../db/database.js';

/*
 * Catalogue du site propre (BBVOLTEX), indépendamment de Megalomarket.
 *
 * Les produits déjà en ligne sur le site (créés avant Megalomarket, ou
 * ajoutés directement) n'ont pas forcément de fiche import_listings associée
 * — le module d'import (src/routes/imports.js) ne peut donc pas les gérer.
 * Ces routes exposent le catalogue réel du site pour qu'on puisse le
 * parcourir et retirer un article, quelle que soit son origine.
 */

export const siteRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

function requireOwnSite() {
  const connector = connectors.own_site;
  if (!connector?.isConfigured?.()) {
    throw new Error("Connecteur site propre non configuré — renseigne OWN_SITE_API_URL et OWN_SITE_API_KEY.");
  }
  return connector;
}

// --- Catalogue complet du site (route publique côté site, pas besoin de clé site) ---
siteRouter.get(
  '/products',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    res.json(await connector.listProducts());
  }),
);

// --- Retire un produit du site, quelle que soit son origine ---
siteRouter.delete(
  '/products/:id',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    if (!connector.deleteListing) {
      throw new Error('Suppression non supportée par ce connecteur.');
    }
    await connector.deleteListing(req.params.id);
    await logActivity('SITE_PRODUIT_SUPPRIME', `Produit retiré du site : ${req.params.id}.`);
    res.json({ ok: true });
  }),
);
