import { readFile } from 'node:fs/promises';
import { config } from '../config/env.js';

/**
 * LumiVita — catalogue professionnel (lumivita-design.ch).
 *
 * Le site est statique : il n'a ni API, ni stock, ni commandes (les demandes de
 * devis arrivent par Netlify Forms, hors de ce hub). Ce connecteur lit donc le
 * catalogue versionné dans `data/lumivita-catalogue.json` et rien d'autre.
 * Les produits n'ont aucun prix : il n'en est jamais inventé, et toute
 * écriture (publication, prix, retrait) est refusée avec un message explicite.
 */

function requireConfigured() {
  if (!config.lumivita.ready) {
    throw new Error(
      `Connecteur LumiVita non configuré — fichier catalogue introuvable (${config.lumivita.catalogPath}). ` +
      'Renseigne LUMIVITA_CATALOG_PATH dans .env ou restaure data/lumivita-catalogue.json.',
    );
  }
}

function readOnly() {
  throw new Error(
    'LumiVita est un catalogue statique en lecture seule : publication, modification de prix et retrait ' +
    'se font en éditant le site, pas depuis Megalomarket.',
  );
}

/** Produits du catalogue, tels que déclarés dans le fichier. */
export async function listProducts() {
  requireConfigured();
  const raw = JSON.parse(await readFile(config.lumivita.catalogPath, 'utf8'));
  const products = Array.isArray(raw?.products) ? raw.products : [];
  return products.map((product) => ({ ...product, source_url: raw.source || null }));
}

/** Le site n'a aucune notion de stock : la liste vide est exacte, rien n'est simulé. */
export async function listInventoryItems() {
  return [];
}

/** Aucune commande en ligne : les demandes de devis ne passent pas par ce hub. */
export async function listOrders() {
  return [];
}

export async function createListing() {
  return readOnly();
}

export async function updateOfferPrice() {
  return readOnly();
}

export async function deleteListing() {
  return readOnly();
}

export function isConfigured() {
  return config.lumivita.ready;
}

