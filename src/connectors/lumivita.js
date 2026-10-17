
import { config } from '../config/env.js';

/**
 * LumiVita — connecteur en attente d'une API officielle.
 * Le site actuel est statique : aucune route produit n'a été confirmée.
 * Aucune donnée, commande ou quantité de stock n'est simulée.
 */

function unavailable() {
  throw new Error(
    'LumiVita n’est pas encore connecté : son site doit exposer une API produit avant la synchronisation ou la publication automatique.',
  );
}

export async function listProducts() {
  return unavailable();
}

export async function listInventoryItems() {
  return [];
}

export async function listOrders() {
  return unavailable();
}

export async function createListing() {
  return unavailable();
}

export async function updateOfferPrice() {
  return unavailable();
}

export async function deleteListing() {
  return unavailable();
}

export function isConfigured() {
  return false;
}

