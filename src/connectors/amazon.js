import { config } from '../config/env.js';

/**
 * Connecteur Amazon (SP-API) — EN ATTENTE.
 * L'accès développeur Amazon est en cours d'approbation. Ce module respecte la même
 * interface que les autres connecteurs (listOrders, listInventoryItems, updateOfferPrice)
 * pour pouvoir être branché sans changer le reste du code une fois les clés obtenues.
 *
 * À implémenter une fois AMAZON_REFRESH_TOKEN / AMAZON_CLIENT_ID / AMAZON_CLIENT_SECRET /
 * AMAZON_SELLER_ID disponibles : authentification LWA (Login with Amazon) puis appels
 * SP-API (Orders API, Listings Items API).
 */

function notReady() {
  throw new Error(
    "Connecteur Amazon pas encore actif — en attente d'approbation de l'accès développeur SP-API.",
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
  return config.amazon.ready;
}
