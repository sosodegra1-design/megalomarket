import { config } from '../config/env.js';

/**
 * Connecteur TikTok Shop (Partner API) — EN ATTENTE.
 * L'accès partenaire TikTok Shop est en cours d'approbation. Même interface que les
 * autres connecteurs pour un branchement sans friction une fois les clés obtenues.
 *
 * À implémenter une fois TIKTOKSHOP_APP_KEY / TIKTOKSHOP_APP_SECRET /
 * TIKTOKSHOP_ACCESS_TOKEN / TIKTOKSHOP_SHOP_ID disponibles : signature des requêtes
 * (HMAC) puis appels à l'API Orders et Products de TikTok Shop Partner Center.
 */

function notReady() {
  throw new Error(
    "Connecteur TikTok Shop pas encore actif — en attente d'approbation de l'accès Partner API.",
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

export function isConfigured() {
  return config.tiktokShop.ready;
}
