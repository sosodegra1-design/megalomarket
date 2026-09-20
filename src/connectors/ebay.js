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

/** Liste les commandes récentes (Fulfillment API). */
export async function listOrders({ limit = 20 } = {}) {
  const data = await ebayFetch(`/sell/fulfillment/v1/order?limit=${limit}`);
  return (data.orders || []).map((order) => ({
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
  const data = await ebayFetch(`/sell/inventory/v1/inventory_item?limit=${limit}`);
  return (data.inventoryItems || []).map((item) => ({
    sku: item.sku,
    quantity: item.availability?.shipToLocationAvailability?.quantity ?? 0,
    title: item.product?.title,
  }));
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
