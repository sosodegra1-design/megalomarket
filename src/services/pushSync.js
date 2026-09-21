import { dbGet, dbRun, logActivity } from '../db/database.js';
import { connectors } from '../connectors/index.js';

/*
 * Propagation d'une valeur INTERNE vers un canal de vente.
 *
 * Jusqu'ici le hub ne savait que LIRE les canaux (stockSync, orderSync) :
 * `updateOfferPrice` existait côté connecteurs mais n'était appelé nulle part,
 * si bien que valider une recommandation de prix ne changeait rien sur les
 * places de marché. Ce service est l'autre moitié de la promesse
 * « synchroniser automatiquement stock et prix » : le hub fait autorité, le
 * canal reçoit.
 *
 * Deux principes gouvernent ce fichier :
 *  - un canal qui n'implémente pas une opération est ignoré, jamais en échec :
 *    tous les canaux ne se ressemblent pas (le site propre n'a aucune notion de
 *    stock), et faire échouer le cycle entier pour cette raison rendrait les
 *    vraies erreurs illisibles ;
 *  - une erreur de connecteur n'est jamais avalée : elle est journalisée ET
 *    remontée à l'appelant, sinon le bouton « appliquer » du tableau de bord
 *    redeviendrait décoratif, en silence cette fois.
 */

/** Libellés d'opération utilisés dans les messages et les résultats. */
const PRICE_OPERATION = 'prix';
const STOCK_OPERATION = 'stock';

/**
 * Le connecteur expose-t-il l'opération demandée ? Amazon, TikTok Shop et
 * Allegro publient bien un `updateOfferPrice`, mais il lève « pas encore
 * actif » tant que les clés manquent : ce n'est pas la même chose que ne pas
 * savoir faire l'opération, et les deux cas sont donc distingués plus bas.
 */
function supports(connector, method) {
  return connector && typeof connector[method] === 'function';
}

/**
 * Un connecteur encore en attente d'habilitation expose bien la méthode
 * (Amazon, TikTok Shop, Allegro), mais elle lève « pas encore actif » avant
 * toute tentative. Ce n'est pas un échec de synchronisation : l'opération
 * n'existe pas encore pour ce canal, elle doit donc être signalée comme
 * ignorée, comme un canal sans la méthode, sous peine de remplir le journal
 * d'une fausse erreur à chaque clic.
 */
function isUnsupported(error) {
  return typeof error?.message === 'string' && error.message.includes('pas encore actif');
}

/** Résultat normalisé d'un canal ignoré, avec la raison exacte pour le journal. */
function skipped(channel, reason, operation = PRICE_OPERATION) {
  return { channel, ok: false, skipped: true, operation, reason };
}

/**
 * Vérifie qu'un canal est utilisable avant tout appel réseau et renvoie son
 * connecteur. Un canal inconnu (faute de frappe, canal retiré du registre) est
 * une vraie erreur d'appel, pas un canal à ignorer.
 */
function resolveConnector(channel) {
  const connector = connectors[channel];
  if (!connector) {
    throw new Error(`Canal inconnu : « ${channel} ».`);
  }
  return connector;
}

function requirePrice(price) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('Prix invalide.');
  return price;
}

/**
 * Verrou anti-vente à perte, aligné sur `computeSuggestedPrice` (import) et sur
 * le filtre de `generatePriceRecommendations` : le hub a le droit de baisser un
 * prix, jamais sous le prix de revient. On refuse AVANT tout appel réseau, pour
 * qu'aucun canal ne reçoive un prix voué à être rejeté.
 */
function assertNotBelowCost(product, price) {
  if (price < product.cost_price) {
    throw new Error(
      `Prix refusé : ${price.toFixed(2)} € est inférieur au prix de revient (${product.cost_price.toFixed(2)} €) du produit « ${product.name} ». Vente à perte.`,
    );
  }
  return price;
}

/** Recharge le produit en base : c'est lui qui fait autorité pour le coût. */
async function requireProduct(productId) {
  const product = await dbGet('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw new Error(`Produit introuvable (id=${productId}).`);
  return product;
}

/**
 * Identifiant attendu par le connecteur pour CE canal.
 *
 * `external_id` est le plus souvent le SKU posé par la synchro de stock, ce que
 * les connecteurs attendent — sauf eBay, dont les méthodes d'écriture exigent
 * un offerId distinct du SKU. On ne résout l'offerId que dans ce cas précis,
 * pour ne pas payer un appel réseau inutile sur les autres canaux.
 */
async function channelIdentifier(channel, product, listing) {
  const externalId = listing?.external_id || null;
  if (channel !== 'ebay') return externalId || product.sku || null;

  const looksLikeSku = !externalId || externalId === product.sku;
  if (!looksLikeSku) return externalId;

  const ebay = connectors.ebay;
  if (!supports(ebay, 'getOfferIdForSku')) return product.sku || null;
  return ebay.getOfferIdForSku(product.sku);
}

/** Reflète côté hub ce qui vient d'être accepté par le canal (prix et/ou stock). */
async function recordChannelListing(productId, channel, externalId, { price, stock }) {
  await dbRun(
    `INSERT INTO channel_listings (product_id, channel, external_id, price, stock, status, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(product_id, channel) DO UPDATE SET
       external_id = COALESCE(excluded.external_id, channel_listings.external_id),
       price = excluded.price,
       stock = excluded.stock,
       updated_at = excluded.updated_at`,
    [productId, channel, externalId, price, stock, Date.now()],
  );
}

/**
 * Exécute réellement la mise à jour sur un canal, en classant l'issue :
 *  - succès : journal de push et `ok: true` ;
 *  - canal pas encore actif : ignoré, sans ligne d'erreur ;
 *  - tout autre échec : journalisé en ERREUR_PUSH et renvoyé dans `error`.
 * Aucune exception ne remonte d'ici, sinon un canal en panne empêcherait les
 * suivants d'être tentés.
 */
async function pushThrough(channel, operation, run) {
  try {
    await run();
    await logActivity(
      operation === STOCK_OPERATION ? 'PUSH_STOCK' : 'PUSH_PRIX',
      `Canal ${channel} : ${operation} mis à jour.`,
    );
    return { channel, ok: true, operation };
  } catch (error) {
    const message = error?.message ?? String(error);
    if (isUnsupported(error)) {
      return { channel, ok: false, skipped: true, operation, reason: message };
    }
    await logActivity(
      'ERREUR_PUSH',
      `Échec de la mise à jour du ${operation} sur ${channel} : ${message}`,
    );
    return { channel, ok: false, operation, error: message };
  }
}

/**
 * Pousse le prix interne d'un produit vers UN canal.
 *
 * Renvoie `{ channel, ok, skipped?, error?, reason? }` : un canal qui ne sait
 * pas faire l'opération (ou pas encore actif) ressort en `ok: false, skipped:
 * true` avec sa raison, un vrai échec en `ok: false` avec `error`.
 * Les erreurs de programmation (canal inconnu, prix sous le coût, prix
 * invalide) lèvent, elles : elles doivent apparaître immédiatement au
 * développeur et non se fondre dans une liste de résultats.
 */
export async function pushPriceToChannel(productId, channel, price) {
  const connector = resolveConnector(channel);
  requirePrice(price);

  const product = await requireProduct(productId);
  assertNotBelowCost(product, price);

  if (!supports(connector, 'updateOfferPrice')) {
    return skipped(channel, `Le canal ${channel} ne permet pas la mise à jour de prix.`);
  }

  const listing = await dbGet(
    'SELECT * FROM channel_listings WHERE product_id = ? AND channel = ?',
    [productId, channel],
  );
  const externalId = await channelIdentifier(channel, product, listing);

  const result = await pushThrough(channel, PRICE_OPERATION, async () => {
    await connector.updateOfferPrice(externalId, price);
    await recordChannelListing(productId, channel, externalId, {
      price,
      stock: listing?.stock ?? 0,
    });
  });
  // Le prix et l'identifiant effectivement utilisés complètent le compte rendu :
  // c'est ce qui permet de vérifier qu'un SKU a bien été traduit en offerId.
  return { ...result, price, externalId };
}

/**
 * Certains connecteurs nomment la mise à jour de stock autrement ; on accepte
 * les deux appellations plutôt que d'imposer une refonte des connecteurs.
 * Aucun canal ne l'implémente aujourd'hui : la fonction reste prête pour le
 * jour où l'un d'eux l'exposera, sans jamais lever pour autant.
 */
function stockMethod(connector) {
  if (supports(connector, 'updateStock')) return 'updateStock';
  if (supports(connector, 'updateStockQuantity')) return 'updateStockQuantity';
  return null;
}

/**
 * Pousse une quantité vers un canal qui gère le stock. Le site propre n'a
 * aucune notion de stock et eBay n'expose pas de route de quantité dans ce
 * connecteur : ces canaux sont ignorés, pas mis en erreur.
 */
export async function pushStockToChannel(productId, channel, quantity) {
  const connector = resolveConnector(channel);
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error('Quantité de stock invalide (entier positif ou nul attendu).');
  }

  const product = await requireProduct(productId);
  const method = stockMethod(connector);
  if (!method) {
    return skipped(channel, `Le canal ${channel} ne permet pas la mise à jour de stock.`, STOCK_OPERATION);
  }

  const listing = await dbGet(
    'SELECT * FROM channel_listings WHERE product_id = ? AND channel = ?',
    [productId, channel],
  );
  const externalId = await channelIdentifier(channel, product, listing);

  const result = await pushThrough(channel, STOCK_OPERATION, async () => {
    await connector[method](externalId, quantity);
    await recordChannelListing(productId, channel, externalId, {
      price: listing?.price ?? 0,
      stock: quantity,
    });
  });
  return { ...result, quantity, externalId };
}

/**
 * Pousse une valeur vers TOUS les canaux du registre, y compris ceux qui ne
 * savent pas faire l'opération : le résultat par canal est justement ce qui
 * permet à l'utilisateur de voir qui a été mis à jour, qui est ignoré et
 * pourquoi. Aucun échec de canal n'interrompt la boucle.
 */
async function pushToAllChannels(productId, push, operation) {
  const results = [];
  for (const channel of Object.keys(connectors)) {
    try {
      results.push(await push(channel));
    } catch (error) {
      // Une validation refusée (prix sous le coût, canal inconnu) concerne tous
      // les canaux de la même façon : la ligne le dit au lieu de faire échouer
      // l'ensemble et de perdre l'information.
      results.push({ channel, ok: false, operation, error: error?.message ?? String(error) });
    }
  }
  return results;
}

/** Pousse le prix vers tous les canaux et renvoie `{ channel, ok, error }` pour chacun. */
export async function pushPriceToAllChannels(productId, price) {
  return pushToAllChannels(
    productId,
    (channel) => pushPriceToChannel(productId, channel, price),
    PRICE_OPERATION,
  );
}

/** Pousse le stock vers tous les canaux qui le gèrent. */
export async function pushStockToAllChannels(productId, quantity) {
  return pushToAllChannels(
    productId,
    (channel) => pushStockToChannel(productId, channel, quantity),
    STOCK_OPERATION,
  );
}

/**
 * Le canal a-t-il réellement accepté la valeur ? `skipped` est un refus
 * volontaire, pas un succès : s'en servir pour marquer une recommandation
 * « appliquée » ferait croire à une mise à jour qui n'a pas eu lieu.
 */
export function hasSuccessfulPush(results) {
  return results.some((result) => result && result.ok);
}
