import crypto from 'node:crypto';
import { config } from '../config/env.js';

/*
 * Tarifs transporteurs réels via l'API Sendcloud.
 *
 * Remplace la comparaison manuelle de services/shipping.js (coûts saisis à
 * la main dans l'onglet Transporteurs) par de vrais tarifs, pour les
 * méthodes d'expédition que le compte Sendcloud a effectivement activées
 * (Sendcloud n'est pas une marketplace universelle de transporteurs : seuls
 * les contrats que l'utilisateur a connectés dans son propre dashboard
 * Sendcloud apparaissent ici).
 *
 * Authentification : Basic Auth, clé publique en nom d'utilisateur, clé
 * secrète en mot de passe — pas de jeton Bearer, c'est la convention de
 * cette API.
 *
 * AVERTISSEMENT — forme exacte de la réponse non vérifiée en conditions
 * réelles : ce module a été écrit à partir de la documentation publique de
 * Sendcloud, sans compte pour tester contre l'API réelle. Si le format
 * diffère de ce qui est attendu ici, l'erreur inclut un extrait de la
 * réponse brute pour corriger précisément plutôt que de deviner à nouveau.
 */

const API_BASE = 'https://panel.sendcloud.sc/api/v2';
const REQUEST_TIMEOUT_MS = 15000;

export function isSendcloudConfigured() {
  return config.sendcloud.ready;
}

function authHeader() {
  const token = Buffer.from(`${config.sendcloud.publicKey}:${config.sendcloud.secretKey}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Retourne la méthode d'expédition la moins chère parmi celles éligibles
 * (destination + poids couverts), ou null si aucune ne l'est. Ne lève une
 * exception QUE pour une vraie panne (réseau, auth, réponse illisible) —
 * "aucune méthode éligible" est une réponse normale (null), pas une erreur.
 */
export async function cheapestSendcloudMethod({ toCountry = 'FR', weightKg, fromCountry = 'FR' } = {}) {
  if (!isSendcloudConfigured()) {
    throw new Error('Sendcloud non configuré (SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY manquantes).');
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new Error('Poids du colis invalide : un nombre de kilogrammes strictement supérieur à 0 est attendu.');
  }

  const url = `${API_BASE}/shipping_methods?from_country=${encodeURIComponent(fromCountry)}&to_country=${encodeURIComponent(toCountry)}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: authHeader() },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('Sendcloud injoignable (délai dépassé).');
    }
    throw new Error(`Impossible de contacter Sendcloud : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Sendcloud a refusé la requête (HTTP ${response.status}) : ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const methods = Array.isArray(data?.shipping_methods) ? data.shipping_methods : (Array.isArray(data) ? data : null);
  if (!methods) {
    throw new Error(`Réponse Sendcloud inattendue (pas de liste de méthodes reconnaissable) : ${JSON.stringify(data).slice(0, 300)}`);
  }

  const eligible = [];
  for (const method of methods) {
    const minWeight = Number(method.min_weight);
    const maxWeight = Number(method.max_weight);
    if (Number.isFinite(minWeight) && weightKg < minWeight) continue;
    if (Number.isFinite(maxWeight) && weightKg > maxWeight) continue;

    // Le prix dépend de la destination : il est niché par pays dans
    // method.countries, pas un champ plat sur la méthode elle-même.
    const countryEntry = Array.isArray(method.countries)
      ? method.countries.find((c) => c.iso_2 === toCountry)
      : null;
    const price = countryEntry ? Number(countryEntry.price) : Number(method.price);
    if (!Number.isFinite(price)) continue;

    eligible.push({
      id: method.id,
      name: method.name,
      carrier: method.carrier || null,
      price,
      minWeight: Number.isFinite(minWeight) ? minWeight : null,
      maxWeight: Number.isFinite(maxWeight) ? maxWeight : null,
    });
  }

  if (!eligible.length) return null;
  eligible.sort((a, b) => a.price - b.price);
  return eligible[0];
}

/**
 * Retourne TOUTES les méthodes d'expédition éligibles pour une destination
 * (pas seulement la moins chère), triées par prix croissant — pour
 * consultation directe des tarifs plutôt que via l'intérieur d'un rapport
 * Pipeline IA. Même logique d'extraction que cheapestSendcloudMethod : le
 * filtrage par poids est ignoré si aucun poids n'est fourni (on veut alors
 * voir toutes les méthodes disponibles pour la destination, quel que soit
 * leur tranche de poids).
 */
export async function listSendcloudMethods({ toCountry = 'FR', fromCountry = 'FR', weightKg = null } = {}) {
  if (!isSendcloudConfigured()) {
    throw new Error('Sendcloud non configuré (SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY manquantes).');
  }

  const url = `${API_BASE}/shipping_methods?from_country=${encodeURIComponent(fromCountry)}&to_country=${encodeURIComponent(toCountry)}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: authHeader() },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('Sendcloud injoignable (délai dépassé).');
    }
    throw new Error(`Impossible de contacter Sendcloud : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Sendcloud a refusé la requête (HTTP ${response.status}) : ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const methods = Array.isArray(data?.shipping_methods) ? data.shipping_methods : (Array.isArray(data) ? data : null);
  if (!methods) {
    throw new Error(`Réponse Sendcloud inattendue (pas de liste de méthodes reconnaissable) : ${JSON.stringify(data).slice(0, 300)}`);
  }

  const list = [];
  for (const method of methods) {
    const minWeight = Number(method.min_weight);
    const maxWeight = Number(method.max_weight);
    if (Number.isFinite(weightKg)) {
      if (Number.isFinite(minWeight) && weightKg < minWeight) continue;
      if (Number.isFinite(maxWeight) && weightKg > maxWeight) continue;
    }

    const countryEntry = Array.isArray(method.countries)
      ? method.countries.find((c) => c.iso_2 === toCountry)
      : null;
    const price = countryEntry ? Number(countryEntry.price) : Number(method.price);
    if (!Number.isFinite(price)) continue;

    list.push({
      id: method.id,
      name: method.name,
      carrier: method.carrier || null,
      price,
      minWeight: Number.isFinite(minWeight) ? minWeight : null,
      maxWeight: Number.isFinite(maxWeight) ? maxWeight : null,
    });
  }

  list.sort((a, b) => a.price - b.price);
  return list;
}

/**
 * Requête générique vers l'API Parcels, factorisant l'auth/le timeout/la
 * gestion d'erreur partagés par createParcel et createReturnParcel.
 */
async function sendcloudPost(path, body) {
  if (!isSendcloudConfigured()) {
    throw new Error('Sendcloud non configuré (SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY manquantes).');
  }
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('Sendcloud injoignable (délai dépassé).');
    }
    throw new Error(`Impossible de contacter Sendcloud : ${error?.message ?? error}`);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Sendcloud a refusé la requête (HTTP ${response.status}) : ${raw.slice(0, 500)}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Réponse Sendcloud illisible (pas du JSON) : ${raw.slice(0, 300)}`);
  }
  return data;
}

/** Transforme la fiche colis brute de Sendcloud en forme exploitable par le reste de l'app. */
function normalizeParcel(parcel) {
  if (!parcel || typeof parcel !== 'object') {
    throw new Error("Réponse Sendcloud inattendue : pas d'objet « parcel » reconnaissable.");
  }
  const label = parcel.label || {};
  const labelUrl =
    (Array.isArray(label.label_printer) && label.label_printer[0]) ||
    (Array.isArray(label.normal_printer) && label.normal_printer[0]) ||
    null;
  return {
    id: parcel.id,
    carrier: parcel.carrier?.name || parcel.shipment?.name || null,
    trackingNumber: parcel.tracking_number || null,
    trackingUrl: parcel.tracking_url || null,
    labelUrl,
    status: parcel.status?.message || null,
  };
}

/**
 * Crée un vrai colis (et demande son étiquette dans le même appel) pour
 * l'expédition d'une commande — c'est CE qui rend l'e-mail « Expédition »
 * honnête : le transporteur et le lien de suivi renvoyés viennent de cet
 * appel, jamais inventés.
 *
 * AVERTISSEMENT — non vérifié en conditions réelles (même limite que
 * cheapestSendcloudMethod : ce bac à sable ne peut pas atteindre
 * panel.sendcloud.sc). Le payload suit la documentation publique de
 * l'endpoint POST /parcels (paramètre request_label pour obtenir l'étiquette
 * immédiatement) ; si la forme réelle diffère, l'erreur contient un extrait
 * de la réponse brute pour corriger précisément.
 */
export async function createParcel({
  toName, toCompany, toAddress, toCity, toPostalCode, toCountry = 'FR', toEmail, toPhone,
  shippingMethodId, weightKg, orderNumber,
}) {
  if (!toName || !toAddress || !toCity || !toPostalCode) {
    throw new Error('Adresse du destinataire incomplète (nom, adresse, ville, code postal requis).');
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new Error('Poids du colis invalide : un nombre de kilogrammes strictement supérieur à 0 est attendu.');
  }
  if (!shippingMethodId) {
    throw new Error('Méthode d\'expédition manquante (shippingMethodId) — choisis un tarif Sendcloud avant de créer le colis.');
  }

  const parcel = {
    name: toName,
    company_name: toCompany || null,
    address: toAddress,
    city: toCity,
    postal_code: toPostalCode,
    country: toCountry,
    email: toEmail || null,
    telephone: toPhone || null,
    weight: weightKg.toFixed(3),
    order_number: orderNumber || null,
    shipment: { id: shippingMethodId },
    request_label: true,
  };
  if (config.sendcloud.senderAddressId) {
    parcel.sender_address = Number(config.sendcloud.senderAddressId);
  }

  const data = await sendcloudPost('/parcels', { parcel });
  return normalizeParcel(data.parcel);
}

/**
 * Crée un colis retour (client -> entrepôt) pour la marche à suivre envoyée
 * dans l'e-mail SAV. C'est le point le MOINS vérifiable de toute
 * l'intégration Sendcloud : la doc publique décrit `is_return: true` sur le
 * même endpoint /parcels, adresse du CLIENT en champs `name`/`address`/...,
 * mais sans compte réel pour l'essayer, la forme exacte attendue par
 * Sendcloud pour un retour reste une hypothèse. Un échec ici ne doit jamais
 * bloquer l'envoi de l'e-mail SAV lui-même — voir l'appelant (job de retours)
 * qui traite cette fonction comme « best effort ».
 */
export async function createReturnParcel({
  fromName, fromAddress, fromCity, fromPostalCode, fromCountry = 'FR', fromEmail, fromPhone,
  shippingMethodId, weightKg, orderNumber,
}) {
  if (!fromName || !fromAddress || !fromCity || !fromPostalCode) {
    throw new Error('Adresse du client incomplète (nom, adresse, ville, code postal requis) pour créer un retour.');
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new Error('Poids du colis invalide : un nombre de kilogrammes strictement supérieur à 0 est attendu.');
  }
  if (!shippingMethodId) {
    throw new Error('Méthode d\'expédition manquante (shippingMethodId) pour le retour.');
  }

  const parcel = {
    name: fromName,
    address: fromAddress,
    city: fromCity,
    postal_code: fromPostalCode,
    country: fromCountry,
    email: fromEmail || null,
    telephone: fromPhone || null,
    weight: weightKg.toFixed(3),
    order_number: orderNumber || null,
    shipment: { id: shippingMethodId },
    request_label: true,
    is_return: true,
  };
  if (config.sendcloud.senderAddressId) {
    parcel.sender_address = Number(config.sendcloud.senderAddressId);
  }

  const data = await sendcloudPost('/parcels', { parcel });
  return normalizeParcel(data.parcel);
}

/**
 * Vérifie la signature d'un webhook Sendcloud : HMAC-SHA256 du corps brut
 * avec la clé secrète du compte, comparée en hexadécimal (en-tête
 * `Sendcloud-Signature`) — c'est la convention documentée par Sendcloud pour
 * prouver qu'un appel entrant vient bien d'eux plutôt que d'un tiers qui
 * devinerait l'URL du webhook. AVERTISSEMENT — non vérifié en conditions
 * réelles, même limite réseau que le reste de ce module ; si Sendcloud
 * rejette systématiquement, comparer avec la documentation à jour de leur
 * compte (le format a pu changer).
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!isSendcloudConfigured() || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', config.sendcloud.secretKey).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const gotBuf = Buffer.from(String(signatureHeader).trim(), 'hex');
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}
