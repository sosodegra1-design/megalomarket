import { config } from '../config/env.js';

/*
 * Connecteur Rewix — grossiste dropshipping.
 *
 * Documentation : https://developer.rewixecommerce.com
 *
 * POURQUOI CE CONNECTEUR EXISTE
 * ----------------------------
 * Le hub importait des produits en scrapant des pages fournisseur. Alibaba bloque
 * ce scraping, et un produit chinois déclenche en plus le droit forfaitaire de
 * 3 € par colis de moins de 150 €, entré en vigueur le 1er juillet 2026 — sur une
 * affiche à 0,69 €, cela représente 432 % du prix de la marchandise.
 *
 * Rewix est un grossiste DANS L'UNION EUROPÉENNE : pas de douane, pas de forfait,
 * pas de TVA à l'import, pas d'EORI. Et il expose un catalogue par API qui donne
 * exactement les trois données que le hub devait estimer à la main : le coût
 * (`taxable`), le poids (`weight`) et le code douanier (`hs`).
 *
 * LE CONTRAT, TEL QU'IL EST DOCUMENTÉ
 * -----------------------------------
 *   GET /restful/export/api/products.json?acceptedlocales=fr_FR,en_US&v=TEAL
 *   GET /restful/export/api/products.json?...&since=<ISO8601>   (incrémental)
 *
 *   Authentification : Basic <clé API>:<mot de passe du compte fournisseur>
 *   Réponse : { pageItems[], totalItems, lastUpdate, query }
 *
 * Trois pièges documentés par Rewix lui-même, encodés ici plutôt que laissés à
 * l'appelant :
 *
 * 1. `totalPages` / `pageSize` valent toujours 1 et le total : la pagination est
 *    un vestige. Un seul appel renvoie donc tout le catalogue — mais un jour
 *    qu'il grossisse, c'est le genre de limite qui casse sans prévenir.
 *    On lit `totalItems` et on le compare à ce qui est arrivé.
 *
 * 2. L'incrémental (`since`) n'est valable que **4 heures** ; au-delà, Rewix
 *    répond **412**. Ce n'est pas une erreur de programmation, c'est une règle :
 *    le message doit le dire, sinon on cherche un bug inexistant.
 *
 * 3. Si on demande plus que le stock disponible, Rewix **n'erre pas** : il
 *    ajoute silencieusement ce qu'il peut. D'où le conseil de réserver avant de
 *    commander — hors du périmètre de ce connecteur, mais noté pour la suite.
 */

const TIMEOUT_MS = 30000;

function requireConfigured() {
  if (!config.rewix.ready) {
    throw new Error(
      'Connecteur Rewix non configuré — renseigne REWIX_API_URL, REWIX_API_KEY et REWIX_PASSWORD. '
      + "L'URL de base est celle du site de TON fournisseur : chaque grossiste Rewix a son propre domaine, "
      + "il n'existe pas d'URL commune.",
    );
  }
}

/** En-tête Basic : la clé API sert de nom d'utilisateur, le mot de passe du compte de mot de passe. */
function authorizationHeader() {
  const paire = `${config.rewix.apiKey}:${config.rewix.password}`;
  return 'Basic ' + Buffer.from(paire, 'utf8').toString('base64');
}

/**
 * Construit l'URL du catalogue. `since` est facultatif ; quand il est fourni, on
 * demande seulement les modifications depuis cet instant.
 *
 * L'encodage compte : Rewix signale que « + » est un caractère réservé dans le
 * décalage horaire ISO 8601 (par exemple « +02:00 ») et qu'il doit être encodé,
 * sinon il est lu comme une espace. `URLSearchParams` s'en charge.
 */
export function buildCatalogUrl({ since, baseUrl = config.rewix.baseUrl, locales = config.rewix.locales } = {}) {
  if (!baseUrl) throw new Error("URL Rewix manquante (REWIX_API_URL).");
  const url = new URL('/restful/export/api/products.json', baseUrl);
  url.searchParams.set('acceptedlocales', locales);
  url.searchParams.set('v', 'TEAL');
  if (since) url.searchParams.set('since', since);
  return url.toString();
}

/**
 * Récupère le catalogue.
 *
 * Lève avec un message qui distingue les causes, parce qu'elles n'appellent pas
 * le même geste : 401 = clé ou mot de passe ; 412 = instantané trop ancien ;
 * 406 = format refusé.
 */
export async function fetchCatalog({ since, fetchImpl = fetch } = {}) {
  requireConfigured();

  const url = buildCatalogUrl({ since });
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: authorizationHeader(),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`Rewix : aucune réponse en ${TIMEOUT_MS / 1000} s.`);
    }
    throw new Error(`Rewix injoignable : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new Error(
        'Rewix a refusé l’authentification (HTTP 401). Vérifie REWIX_API_KEY et REWIX_PASSWORD — '
        + 'le mot de passe est celui de ton compte sur le site du fournisseur, et il doit rester synchronisé avec lui. '
        + `Réponse : ${detail.slice(0, 200)}`,
      );
    }
    if (response.status === 412) {
      // Règle métier de Rewix, pas un bug : la fenêtre d'incrémental est de 4 h.
      throw new Error(
        'Rewix refuse la demande incrémentale (HTTP 412) : l’instantané de référence a plus de 4 heures. '
        + 'Relance une synchronisation COMPLÈTE (sans « since »).',
      );
    }
    if (response.status === 406) {
      throw new Error('Rewix a refusé le format demandé (HTTP 406) : l’en-tête Accept attend application/json.');
    }
    throw new Error(`Rewix a répondu HTTP ${response.status} : ${detail.slice(0, 200)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Rewix : la réponse n’était pas du JSON valide.');
  }

  const items = Array.isArray(payload?.pageItems) ? payload.pageItems : [];
  return {
    items,
    totalItems: Number(payload?.totalItems) || items.length,
    lastUpdate: payload?.lastUpdate || null,
    // Signalé plutôt que masqué : si Rewix annonce 500 produits et en envoie 300,
    // la synchronisation est incomplète et l'appelant doit pouvoir le dire.
    truncated: Number(payload?.totalItems) > items.length,
  };
}

/** Choisit la valeur localisée la plus utile : français d'abord, puis anglais, puis la première. */
function localizedValue(bloc, ordre = ['fr_FR', 'en_US']) {
  if (!bloc || typeof bloc !== 'object') return null;
  for (const locale of ordre) {
    const valeur = bloc[locale];
    if (typeof valeur === 'string' && valeur.trim()) return valeur.trim();
    if (valeur && typeof valeur.value === 'string' && valeur.value.trim()) return valeur.value.trim();
  }
  const premiere = Object.values(bloc)[0];
  if (typeof premiere === 'string' && premiere.trim()) return premiere.trim();
  if (premiere && typeof premiere.value === 'string' && premiere.value.trim()) return premiere.value.trim();
  return null;
}

/** Retire les balises d'un texte de description Rewix (le champ contient du HTML). */
function texteBrut(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Traduit un produit Rewix vers la forme du hub.
 *
 * `taxable` est retenu comme prix d'achat : c'est ce que Rewix appelle « your
 * cost » — le prix HT que paie le dropshippeur. `bestTaxable` peut être plus bas
 * (promotion temporaire) ; on garde `taxable` pour la stabilité du calcul de
 * prix, et on expose `bestTaxable` à part pour que rien ne soit perdu.
 *
 * Le poids est converti en GRAMMES : la table `products` stocke un entier, et un
 * flottant en kilos (2.0) finirait arrondi à 2 g par une colonne entière mal
 * interprétée. L'unité est donc explicite dans le nom de la colonne.
 */
export function mapProduct(item) {
  if (!item || typeof item !== 'object') return null;

  const code = String(item.code || '').trim();
  if (!code) return null;

  const nom = (item.productLocalizations && localizedValue({ fr_FR: item.productLocalizations.productName?.fr_FR, en_US: item.productLocalizations.productName?.en_US }))
    || String(item.name || '').trim();
  if (!nom) return null;

  const description = localizedValue(item.productLocalizations?.description) || '';

  const poidsKilos = Number(item.weight);
  const poidsGrammes = Number.isFinite(poidsKilos) && poidsKilos > 0
    ? Math.round(poidsKilos * 1000)
    : null;

  const prixAchat = Number(item.taxable);
  const modelePrincipal = Array.isArray(item.models) && item.models.length === 1 ? item.models[0] : null;

  return {
    sku: code,
    name: nom,
    description: texteBrut(description),
    costPrice: Number.isFinite(prixAchat) && prixAchat > 0 ? prixAchat : 0,
    currency: String(item.currency || 'EUR').toUpperCase(),
    weightGrams: poidsGrammes,
    hsCode: item.hs ? String(item.hs) : null,
    // Référence de la source : permet de relier un produit du hub à sa fiche
    // Rewix sans dépendre du code, qui peut être modifié côté fournisseur.
    sourceRef: item.id != null ? String(item.id) : null,
    availability: Number(item.availability) || 0,
    bestTaxable: Number(item.bestTaxable) || null,
    streetPrice: Number(item.streetPrice) || null,
    modelCount: Array.isArray(item.models) ? item.models.length : 0,
    // Le `stock_id` du modèle est ce qu'il faut pour commander : on le conserve
    // pour que la commande puisse être envoyée sans re-télécharger le catalogue.
    modelIds: Array.isArray(item.models) ? item.models.map((m) => m?.id).filter((id) => id != null) : [],
  };
}
