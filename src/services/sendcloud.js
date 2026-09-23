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
