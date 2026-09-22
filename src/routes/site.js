import { Router } from 'express';
import { connectors } from '../connectors/index.js';
import { logActivity } from '../db/database.js';
import { config } from '../config/env.js';
import { generateSiteArticleDescription } from '../ai/descriptionWriter.js';

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

/* Lien direct vers la fiche produit sur le site (page de catégorie + deep
   link `?product=<id>` géré côté site, voir js/script.js de BBhappy) — le
   site n'a pas de page dédiée par produit, seulement des modales ouvertes
   par ce paramètre, donc c'est le lien le plus direct qu'on puisse donner. */
function siteBaseUrl() {
  return config.ownSite.apiUrl ? String(config.ownSite.apiUrl).replace(/\/+$/, '') : null;
}

function withProductUrl(product) {
  if (!product || typeof product !== 'object') return product;
  const base = siteBaseUrl();
  const url = base && product.category && product.id
    ? `${base}/${product.category}.html?product=${encodeURIComponent(product.id)}`
    : null;
  return { ...product, url };
}

function requireOwnSite() {
  const connector = connectors.own_site;
  if (!connector?.isConfigured?.()) {
    throw new Error("Connecteur site propre non configuré — renseigne OWN_SITE_API_URL et OWN_SITE_API_KEY.");
  }
  return connector;
}

/* Les libellés anglais sont exigés par le site (ses filtres reposent dessus),
   mais imposer une saisie bilingue à quelqu'un qui gère sa boutique seul au
   quotidien découragerait l'usage. On reprend donc automatiquement le texte
   français quand le champ anglais est laissé vide — l'utilisateur peut
   toujours le corriger ensuite s'il veut une vraie traduction. */
function fallbackToFrench(value, frenchValue) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || (typeof frenchValue === 'string' ? frenchValue.trim() : '');
}

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Champ « ${label} » obligatoire.`);
  }
  return value.trim();
}

function parsePrice(value, { required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('Prix obligatoire.');
    return undefined;
  }
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Prix invalide : un nombre strictement supérieur à 0 est attendu.');
  }
  return price;
}

function parseImages(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('images doit être un tableau d\'URLs.');
  return value.map((url) => String(url).trim()).filter(Boolean);
}

/* Vérifie catégorie/univers/icône contre les listes fermées du site, quand
   elles sont fournies. Une valeur absente n'est jamais forcée ici — c'est au
   type d'appel (création ou modification) de dire ce qui est obligatoire. */
async function checkTaxonomy(connector, { category, universe, iconKey }) {
  if (category === undefined && universe === undefined && iconKey === undefined) return;
  const taxonomy = await connector.getTaxonomy();
  if (category !== undefined && !taxonomy.categories.includes(category)) {
    throw new Error(`Catégorie "${category}" inconnue du site. Valeurs autorisées : ${taxonomy.categories.join(', ')}.`);
  }
  if (universe !== undefined && universe !== null && universe !== '' && !taxonomy.universes.includes(universe)) {
    throw new Error(`Univers "${universe}" inconnu du site. Valeurs autorisées : ${taxonomy.universes.join(', ')}.`);
  }
  if (iconKey !== undefined && !taxonomy.iconKeys.includes(iconKey)) {
    throw new Error(`Clé d'icône "${iconKey}" inconnue du site. Valeurs autorisées : ${taxonomy.iconKeys.join(', ')}.`);
  }
}

// --- Catalogue complet du site (route publique côté site, pas besoin de clé site) ---
siteRouter.get(
  '/products',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    const products = await connector.listProducts();
    res.json(Array.isArray(products) ? products.map(withProductUrl) : products);
  }),
);

// --- Listes fermées (catégories, univers, icônes) pour les menus déroulants du formulaire ---
siteRouter.get(
  '/taxonomy',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    res.json(await connector.getTaxonomy());
  }),
);

// --- Détail d'un produit (pour pré-remplir le formulaire de modification) ---
siteRouter.get(
  '/products/:id',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    res.json(withProductUrl(await connector.getProduct(req.params.id)));
  }),
);

// --- Agent marketing : écrit une description vendeur pour le formulaire
//     « Ajouter un article », à partir de ce qui y est déjà saisi. N'exige
//     pas le connecteur site propre (juste l'IA) : l'article n'existe pas
//     encore, rien à publier ni à valider contre la taxonomie du site ici. ---
siteRouter.post(
  '/products/describe',
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const description = await generateSiteArticleDescription({
      name: body.name,
      category: body.category,
      universe: body.universe,
      ageLabel: body.ageLabel,
      price: body.price,
    });
    res.json({ description });
  }),
);

// --- Ajoute un nouvel article, saisi à la main (pas d'URL fournisseur) ---
siteRouter.post(
  '/products',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    const body = req.body || {};

    const name = requireNonEmpty(body.name, 'Nom');
    const category = requireNonEmpty(body.category, 'Catégorie');
    const age = requireNonEmpty(body.age, 'Âge');
    const ageLabel = requireNonEmpty(body.ageLabel, 'Âge (libellé)');
    const iconKey = requireNonEmpty(body.iconKey, 'Icône');
    const universe = body.universe && body.universe.trim() ? body.universe.trim() : null;

    await checkTaxonomy(connector, { category, universe, iconKey });

    const payload = {
      name,
      name_en: fallbackToFrench(body.nameEn, name) || name,
      description: typeof body.description === 'string' ? body.description.trim() : '',
      description_en: fallbackToFrench(body.descriptionEn, body.description) || '',
      category,
      universe,
      age,
      ageLabel,
      ageLabel_en: fallbackToFrench(body.ageLabelEn, ageLabel) || ageLabel,
      iconKey,
      price: parsePrice(body.price, { required: true }),
      images: parseImages(body.images) || [],
    };

    const created = await connector.createListing(payload);
    const base = siteBaseUrl();
    const url = base && created?.offerId ? `${base}/${category}.html?product=${encodeURIComponent(created.offerId)}` : null;
    await logActivity('SITE_PRODUIT_CREE', `Article ajouté sur le site : ${name}${created?.offerId ? ` (${created.offerId})` : ''}.`);
    res.status(201).json({ ...created, url });
  }),
);

// --- Modifie un article existant (textes, prix, photos) ---
siteRouter.patch(
  '/products/:id',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    const body = req.body || {};
    const fields = {};

    if (body.name !== undefined) fields.name = requireNonEmpty(body.name, 'Nom');
    if (body.nameEn !== undefined) fields.name_en = requireNonEmpty(body.nameEn, 'Nom (anglais)');
    if (body.description !== undefined) fields.description = String(body.description).trim();
    if (body.descriptionEn !== undefined) fields.description_en = String(body.descriptionEn).trim();
    if (body.category !== undefined) fields.category = requireNonEmpty(body.category, 'Catégorie');
    if (body.universe !== undefined) fields.universe = body.universe && body.universe.trim() ? body.universe.trim() : null;
    if (body.iconKey !== undefined) fields.iconKey = requireNonEmpty(body.iconKey, 'Icône');
    if (body.age !== undefined) fields.age = requireNonEmpty(body.age, 'Âge');
    if (body.ageLabel !== undefined) fields.ageLabel = requireNonEmpty(body.ageLabel, 'Âge (libellé)');
    if (body.ageLabelEn !== undefined) fields.ageLabel_en = requireNonEmpty(body.ageLabelEn, 'Âge (libellé anglais)');
    if (body.price !== undefined) fields.price = parsePrice(body.price, { required: false });
    if (body.images !== undefined) fields.images = parseImages(body.images);

    if (!Object.keys(fields).length) throw new Error('Aucune modification fournie.');

    await checkTaxonomy(connector, {
      category: fields.category,
      universe: fields.universe,
      iconKey: fields.iconKey,
    });

    const updated = await connector.updateProduct(req.params.id, fields);
    await logActivity('SITE_PRODUIT_MODIFIE', `Article modifié sur le site : ${req.params.id}.`);
    res.json(withProductUrl(updated));
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
