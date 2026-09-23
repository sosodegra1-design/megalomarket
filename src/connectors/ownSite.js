import { config } from '../config/env.js';

/**
 * Connecteur du site propre (BBVOLTEX).
 *
 * Le contrat ci-dessous a été vérifié contre l'API réellement en ligne, et il
 * diffère de l'hypothèse d'origine sur trois points qui empêchaient tout
 * fonctionnement : les produits vivent sous `/api/products` (et non
 * `/products`), ils sont identifiés par `id` (« p1 », « bj1 »…) et non par un
 * `sku`, et le site n'a **aucune notion de stock** — aucun de ses produits ne
 * porte de champ `stock`.
 *
 *   GET    /api/products              public  — catalogue complet
 *   GET    /api/admin/taxonomy        clé     — catégories / univers / icônes autorisés
 *   GET    /api/admin/products/:id    clé     — un produit
 *   POST   /api/admin/products        clé     — publier un produit
 *   PATCH  /api/admin/products/:id    clé     — modifier prix et champs
 *   DELETE /api/admin/products/:id    clé     — retirer un produit
 *   GET    /api/admin/orders          clé     — commandes du site (statut réel, jamais simulé)
 *   GET    /api/admin/orders/:id      clé     — une commande
 *   PATCH  /api/admin/orders/:id/ship clé      — marque expédiée (transporteur + suivi réels requis)
 *   PATCH  /api/admin/orders/:id/deliver clé   — marque livrée (idempotent)
 *   PATCH  /api/admin/orders/:id/return  clé   — fait avancer un retour déjà demandé par le client
 *
 * Authentification des routes d'administration : en-tête `X-Admin-Key`,
 * alimenté par OWN_SITE_API_KEY (doit correspondre à ADMIN_API_KEY côté site).
 */

function requireConfigured() {
  if (!config.ownSite.ready) {
    throw new Error(
      "Connecteur site propre non configuré — renseigne OWN_SITE_API_URL et OWN_SITE_API_KEY dans .env.",
    );
  }
}

/** Les routes d'écriture exigent la clé ; la lecture du catalogue est publique. */
function requireWritable() {
  requireConfigured();
  if (!config.ownSite.apiKey) {
    throw new Error(
      "Publication sur le site propre impossible — OWN_SITE_API_KEY manquante. " +
      "Elle doit correspondre à ADMIN_API_KEY configurée côté site.",
    );
  }
}

function baseUrl() {
  return String(config.ownSite.apiUrl).replace(/\/+$/, '');
}

async function ownSiteFetch(path, { method = 'GET', body, auth = true } = {}) {
  requireConfigured();

  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    requireWritable();
    headers['X-Admin-Key'] = config.ownSite.apiKey;
  }

  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Erreur API site propre ${method} ${path} (${response.status}) : ${detail.slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

/** Catalogue du site (route publique : aucune clé requise). */
export async function listProducts() {
  const products = await ownSiteFetch('/api/products', { auth: false });
  return Array.isArray(products) ? products : [];
}

/**
 * Le site BBVOLTEX ne gère pas de stock : aucun de ses produits ne porte ce
 * champ et son API n'expose aucune route pour le modifier. Renvoyer la liste
 * vide est donc exact — la synchronisation de stock ignore ce canal au lieu
 * d'inventer des quantités à zéro.
 */
export async function listInventoryItems() {
  return [];
}

/** Listes fermées du site, indispensables pour générer une fiche publiable. */
export async function getTaxonomy() {
  return ownSiteFetch('/api/admin/taxonomy');
}

export async function getProduct(id) {
  if (!id) throw new Error('Identifiant de produit manquant.');
  return ownSiteFetch(`/api/admin/products/${encodeURIComponent(id)}`);
}

/** Modifie un produit existant (prix, promotion, textes…). */
export async function updateProduct(id, fields) {
  if (!id) throw new Error('Identifiant de produit manquant.');
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    throw new Error('Aucun champ à modifier.');
  }
  return ownSiteFetch(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: fields });
}

export async function updatePrice(id, price) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('Prix invalide.');
  return updateProduct(id, { price });
}

/**
 * Alias au nom commun aux autres connecteurs, pour qu'un appelant générique
 * puisse mettre à jour un prix sans connaître le canal.
 */
export const updateOfferPrice = updatePrice;

/**
 * Publie un produit sur le site.
 *
 * Le payload attendu est celui de l'API d'administration du site — bien plus
 * riche que celui des marketplaces : catégorie, univers, âge, libellés
 * bilingues, clé d'icône. Le champ `id` est retiré pour laisser le site
 * attribuer le sien (son préfixe suit une convention par catégorie).
 */
export async function createListing(payload) {
  requireWritable();
  if (!payload || typeof payload !== 'object') {
    throw new Error('Fiche produit manquante pour la publication sur le site.');
  }
  const { id, ...fields } = payload;
  const created = await ownSiteFetch('/api/admin/products', { method: 'POST', body: fields });
  return { offerId: created?.id, listingId: created?.id, product: created };
}

/** Retire un produit du site. */
export async function deleteListing(id) {
  if (!id) throw new Error('Identifiant de produit manquant.');
  return ownSiteFetch(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function isConfigured() {
  return config.ownSite.ready;
}

/**
 * Commandes du site propre — la donnée d'origine des 3 e-mails post-achat.
 * `since` (ISO) permet au planificateur de ne relire que ce qui a changé
 * depuis son dernier passage, comme les autres connecteurs (voir
 * services/orderSync.js), même si les commandes du site propre ne
 * transitent PAS par cette synchronisation générique : leur forme (adresse,
 * statut réel, retours) est trop différente de celle des marketplaces pour
 * partager la même table `orders`.
 */
export async function listOrders({ since, status } = {}) {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (status) params.set('status', status);
  const query = params.toString() ? `?${params.toString()}` : '';
  const orders = await ownSiteFetch(`/api/admin/orders${query}`);
  return Array.isArray(orders) ? orders : [];
}

export async function getOrder(orderId) {
  if (!orderId) throw new Error('Identifiant de commande manquant.');
  return ownSiteFetch(`/api/admin/orders/${encodeURIComponent(orderId)}`);
}

/** Marque une commande expédiée — exige un transporteur et un suivi réels (voir server/orders-repo.js côté site, qui refuse sinon). */
export async function markOrderShipped(orderId, { carrier, trackingNumber, trackingUrl, labelUrl }) {
  if (!orderId) throw new Error('Identifiant de commande manquant.');
  return ownSiteFetch(`/api/admin/orders/${encodeURIComponent(orderId)}/ship`, {
    method: 'PATCH',
    body: { carrier, trackingNumber, trackingUrl, labelUrl },
  });
}

/** Marque une commande livrée. Idempotent côté site : un second appel (webhook rejoué) ne provoque pas d'erreur. */
export async function markOrderDelivered(orderId) {
  if (!orderId) throw new Error('Identifiant de commande manquant.');
  return ownSiteFetch(`/api/admin/orders/${encodeURIComponent(orderId)}/deliver`, { method: 'PATCH' });
}

/** Fait avancer un retour déjà demandé par le client (jamais l'inverse — le site seul décide qu'un retour démarre). */
export async function markReturnHandled(orderId, { returnStatus, returnLabelUrl } = {}) {
  if (!orderId) throw new Error('Identifiant de commande manquant.');
  return ownSiteFetch(`/api/admin/orders/${encodeURIComponent(orderId)}/return`, {
    method: 'PATCH',
    body: { returnStatus, returnLabelUrl },
  });
}
