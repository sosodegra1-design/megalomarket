import { config } from '../config/env.js';

const BASE_URL = {
  production: 'https://api.ebay.com',
  sandbox: 'https://api.sandbox.ebay.com',
};

let cachedToken = null; // { accessToken, expiresAt }

function requireConfigured() {
  if (!config.ebay.ready) {
    throw new Error(
      "Connecteur eBay non configuré — renseigne EBAY_APP_ID, EBAY_CERT_ID, EBAY_DEV_ID et EBAY_REFRESH_TOKEN dans .env.",
    );
  }
}

function baseUrl() {
  return BASE_URL[config.ebay.env] || BASE_URL.production;
}

/**
 * Échange le refresh token contre un access token de courte durée (OAuth2, User Access Token).
 * EBAY_DEV_ID n'est pas utilisé par ce flux REST (Sell API) — il n'intervient que pour l'ancienne
 * API XML "Trading API" — mais on le garde en config au cas où un connecteur futur en ait besoin.
 */
async function getAccessToken() {
  requireConfigured();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const credentials = Buffer.from(`${config.ebay.appId}:${config.ebay.certId}`).toString('base64');
  const response = await fetch(`${baseUrl()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.ebay.refreshToken,
      scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Échec du rafraîchissement du token eBay (${response.status}) : ${body}`);
  }

  const data = await response.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

async function ebayFetch(path, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Erreur API eBay ${options.method || 'GET'} ${path} (${response.status}) : ${body}`);
  }
  return response.status === 204 ? null : response.json();
}

/**
 * eBay ne rend qu'une page à la fois, et les syncs tournent en boucle : sans
 * pagination, toute commande au-delà de la première page était perdue
 * définitivement (le sync suivant repartait du même offset 0) et l'inventaire
 * restait partiel dès le 51e SKU, sans erreur ni avertissement. On suit donc
 * `offset`/`limit` jusqu'à une page incomplète.
 *
 * Le plafond de 20 pages évite une boucle infinie si l'API renvoyait toujours
 * des pages pleines (bug ou données incohérentes côté eBay) : 20 × 20 = 400
 * commandes et 20 × 50 = 1000 SKU couvrent largement le volume de la boutique,
 * tout en bornant le nombre d'appels par cycle.
 */
const MAX_PAGES = 20;

/** Parcourt toutes les pages d'un endpoint eBay en suivant offset/limit. */
async function fetchAllPages(buildPath, limit, extractItems) {
  const items = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await ebayFetch(buildPath(limit, page * limit));
    const batch = extractItems(data) || [];
    items.push(...batch);
    // Une page incomplète signale la dernière page : inutile d'en demander une
    // autre, qui renverrait un tableau vide au prix d'un appel réseau.
    if (batch.length < limit) break;
  }
  return items;
}

/**
 * Normalise l'option `since` (date ISO ou timestamp en ms) en une date UTC au
 * format `...Z`, seul format accepté par le filtre eBay. On normalise au lieu
 * d'injecter la chaîne brute : sans cela, un `since` contenant `&` ou `]`
 * casserait la query string, et un `since` invalide serait silencieusement
 * envoyé à eBay qui répondrait une erreur 400 opaque.
 */
function toIsoSince(since) {
  if (since === undefined || since === null || since === '') return null;
  const ms = typeof since === 'number' ? since : Date.parse(since);
  if (!Number.isFinite(ms)) {
    throw new Error(`Option « since » invalide (date ISO ou timestamp en ms attendu) : ${since}`);
  }
  return new Date(ms).toISOString();
}

/**
 * Liste les commandes récentes (Fulfillment API).
 *
 * `since` restreint le résultat aux commandes créées après cette date, via le
 * filtre `creationdate` d'eBay. C'est ce qui évite de re-parcourir tout
 * l'historique récent à chaque cycle : sans curseur temporel, les 20 pages du
 * plafond pouvaient être redemandées toutes les 5 minutes et épuiser le quota
 * quotidien des Sell APIs. eBay ne documente ce filtre que sur les 90 derniers
 * jours : au-delà, il faut retomber sur une synchronisation complète.
 *
 * Forme du filtre vérifiée dans le guide officiel « Discovering unfulfilled
 * orders » : `filter=creationdate:%5B2016-09-29T15:05:43.026Z..%5D`. Les crochets
 * DOIVENT être percent-encodés (%5B / %5D) — on les code à la main plutôt que
 * via URLSearchParams, qui encoderait aussi les `:` et ne reproduirait pas la
 * forme documentée. Le reste de la valeur vient de `toISOString()`, donc ne
 * contient que des caractères sûrs dans une query string.
 */
export async function listOrders({ limit = 20, since } = {}) {
  const sinceIso = toIsoSince(since);
  const filter = sinceIso ? `&filter=creationdate:%5B${sinceIso}..%5D` : '';
  const orders = await fetchAllPages(
    (pageLimit, offset) => `/sell/fulfillment/v1/order?limit=${pageLimit}&offset=${offset}${filter}`,
    limit,
    (data) => data.orders,
  );
  return orders.map((order) => ({
    externalOrderId: order.orderId,
    status: order.orderFulfillmentStatus,
    amount: Number(order.pricingSummary?.total?.value || 0),
    createdAt: order.creationDate,
    lineItems: (order.lineItems || []).map((li) => ({
      sku: li.sku,
      quantity: li.quantity,
      title: li.title,
    })),
  }));
}

/** Liste les articles d'inventaire (Inventory API). */
export async function listInventoryItems({ limit = 50 } = {}) {
  const items = await fetchAllPages(
    (pageLimit, offset) => `/sell/inventory/v1/inventory_item?limit=${pageLimit}&offset=${offset}`,
    limit,
    (data) => data.inventoryItems,
  );
  return items.map((item) => ({
    sku: item.sku,
    quantity: item.availability?.shipToLocationAvailability?.quantity ?? 0,
    title: item.product?.title,
  }));
}

/**
 * Retrouve l'offerId eBay à partir du SKU.
 *
 * Le SKU et l'offerId sont deux identifiants distincts chez eBay : le SKU est
 * celui que le hub connaît (et que `listInventoryItems` renvoie), l'offerId est
 * l'identifiant interne de l'offre publiée, seul accepté par
 * `PUT /sell/inventory/v1/offer/{offerId}`. `channel_listings.external_id` est
 * rempli par la synchro de stock avec le SKU : le confondre avec un offerId
 * ferait échouer toute mise à jour de prix. On interroge donc l'Inventory API
 * (`GET /sell/inventory/v1/offer?sku=…`) à chaque push plutôt que de stocker un
 * offerId, qui changerait silencieusement si l'offre était recréée ou republiée.
 *
 * Un même SKU peut porter plusieurs offres (une par place de marché) : on
 * privilégie celle d'EBAY_FR, la seule que le hub publie, et on retombe sur la
 * première offre publiée pour ne pas rester bloqué si la réponse ne mentionne
 * pas la place de marché.
 */
export async function getOfferIdForSku(sku) {
  if (!sku) throw new Error('SKU manquant pour retrouver l’offre eBay.');

  const data = await ebayFetch(`/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`);
  const offers = data?.offers || [];
  const published = offers.filter((offer) => offer.status === 'PUBLISHED' || offer.listing?.listingId);
  // Si aucune offre n'est marquée publiée on garde la liste complète : le statut
  // peut être absent selon les comptes, et l'offerId reste le bon identifiant.
  const candidates = published.length ? published : offers;
  const preferred = candidates.find((offer) => offer.marketplaceId === 'EBAY_FR');
  const offerId = preferred?.offerId || candidates[0]?.offerId;

  if (!offerId) throw new Error(`Aucune offre eBay trouvée pour le SKU « ${sku} ».`);
  return offerId;
}

/** Met à jour le prix d'une offre publiée (nécessite l'offerId eBay, distinct du SKU interne). */
export async function updateOfferPrice(offerId, newPrice) {
  if (!offerId) throw new Error('offerId eBay manquant.');
  if (!Number.isFinite(newPrice) || newPrice <= 0) throw new Error('Prix invalide.');

  await ebayFetch(`/sell/inventory/v1/offer/${offerId}`, {
    method: 'PUT',
    body: JSON.stringify({
      pricingSummary: { price: { value: newPrice.toFixed(2), currency: 'EUR' } },
    }),
  });
  return { offerId, newPrice };
}

/**
 * Crée (ou remplace) une fiche complète sur eBay et la publie : inventory item (titre, description,
 * images, stock), offre (prix), puis publication. Le SKU doit être unique côté eBay.
 * Nécessite un compte vendeur eBay avec ses "business policies" (paiement/livraison/retours) déjà
 * configurées — sans quoi eBay refusera la publication avec un message d'erreur explicite.
 */
export async function createListing({ sku, title, description, imageUrls, price, quantity = 1, categoryId }) {
  if (!sku) throw new Error('SKU manquant pour la publication eBay.');
  if (!title || !description) throw new Error('Titre et description requis pour la publication eBay.');
  if (!Number.isFinite(price) || price <= 0) throw new Error('Prix invalide.');

  await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    body: JSON.stringify({
      product: {
        title: title.slice(0, 80),
        description,
        imageUrls: (imageUrls || []).slice(0, 12),
      },
      condition: 'NEW',
      availability: { shipToLocationAvailability: { quantity } },
    }),
  });

  const offer = await ebayFetch('/sell/inventory/v1/offer', {
    method: 'POST',
    body: JSON.stringify({
      sku,
      marketplaceId: 'EBAY_FR',
      format: 'FIXED_PRICE',
      categoryId,
      listingDescription: description,
      pricingSummary: { price: { value: price.toFixed(2), currency: 'EUR' } },
      availableQuantity: quantity,
      merchantLocationKey: config.ebay.merchantLocationKey || undefined,
    }),
  });

  const published = await ebayFetch(`/sell/inventory/v1/offer/${offer.offerId}/publish`, {
    method: 'POST',
  });

  return { offerId: offer.offerId, listingId: published?.listingId };
}

export function isConfigured() {
  return config.ebay.ready;
}
