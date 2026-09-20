import { config } from '../config/env.js';

/**
 * Connecteur Allegro (REST API) — EN ATTENTE.
 * Nécessite l'enregistrement d'une application développeur sur apps.developer.allegro.pl,
 * puis un flux OAuth2 (device code ou authorization code) pour obtenir un refresh token.
 * Même interface que les autres connecteurs pour un branchement sans friction une fois les
 * clés obtenues : authentification OAuth2 puis appels à l'API Offer Management d'Allegro.
 */

function notReady() {
  throw new Error(
    "Connecteur Allegro pas encore actif — renseigne ALLEGRO_CLIENT_ID, ALLEGRO_CLIENT_SECRET et ALLEGRO_REFRESH_TOKEN dans .env (inscription développeur Allegro requise).",
  );
}

export async function listOrders() {
  notReady();
}

export async function listInventoryItems() {
  notReady();
}

export async function updateOfferPrice() {
  notReady();
}

export async function createListing() {
  notReady();
}

export function isConfigured() {
  return config.allegro.ready;
}
