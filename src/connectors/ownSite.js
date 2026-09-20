import { config } from '../config/env.js';

/**
 * Connecteur générique pour le site propre Megalomarket.
 *
 * Hypothèse de contrat API (à adapter au vrai backend du site une fois connu) :
 *   GET  {OWN_SITE_API_URL}/products                — liste des produits {sku, name, price, stock}
 *   POST {OWN_SITE_API_URL}/products/:sku/price      — body {price} met à jour le prix
 *   POST {OWN_SITE_API_URL}/products/:sku/stock      — body {stock} met à jour le stock
 * Authentification : en-tête "Authorization: Bearer OWN_SITE_API_KEY".
 *
 * Si le site n'expose pas encore ces routes, il faudra soit les ajouter côté site,
 * soit adapter les chemins ci-dessous à ce qui existe réellement.
 */

function requireConfigured() {
  if (!config.ownSite.ready) {
    throw new Error(
      "Connecteur site propre non configuré — renseigne OWN_SITE_API_URL et OWN_SITE_API_KEY dans .env.",
    );
  }
}

async function ownSiteFetch(path, options = {}) {
  requireConfigured();
  const response = await fetch(`${config.ownSite.apiUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.ownSite.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Erreur API site propre ${options.method || 'GET'} ${path} (${response.status}) : ${body}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function listProducts() {
  return ownSiteFetch('/products');
}

/** Alias au format commun aux autres connecteurs, pour la synchronisation de stock. */
export async function listInventoryItems() {
  const products = await listProducts();
  return (products || []).map((p) => ({ sku: p.sku, quantity: p.stock, title: p.name }));
}

export async function updatePrice(sku, price) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('Prix invalide.');
  return ownSiteFetch(`/products/${encodeURIComponent(sku)}/price`, {
    method: 'POST',
    body: JSON.stringify({ price }),
  });
}

export async function updateStock(sku, stock) {
  if (!Number.isInteger(stock) || stock < 0) throw new Error('Stock invalide.');
  return ownSiteFetch(`/products/${encodeURIComponent(sku)}/stock`, {
    method: 'POST',
    body: JSON.stringify({ stock }),
  });
}

export function isConfigured() {
  return config.ownSite.ready;
}
