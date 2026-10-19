import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';
import { fetchCatalog, mapProduct } from '../connectors/rewix.js';

/*
 * Synchronisation du catalogue Rewix vers la table `products` du hub.
 *
 * LE PRINCIPE : Rewix est la source de vérité pour SES produits. Le hub garde
 * son propre catalogue, et la synchronisation ne touche qu'aux produits qui
 * viennent de Rewix.
 *
 * POURQUOI CETTE PRÉCAUTION. Un produit créé à la main dans le hub peut porter
 * le même SKU qu'un produit Rewix — par hasard, ou parce qu'on a saisi la même
 * référence. Écraser une fiche écrite à la main par une fiche fournisseur serait
 * une perte silencieuse : l'utilisateur découvrirait son titre remplacé sans
 * comprendre. On repère donc l'origine par `source_ref` (l'identifiant Rewix) :
 *   - absent  → produit local, on ne touche pas, on le SIGNALE ;
 *   - présent → produit Rewix, on met à jour.
 *
 * LE CURSEUR. La synchronisation incrémentale s'appuie sur `lastUpdate` renvoyé
 * par Rewix, conservé dans `app_state`. S'il n'y a pas de curseur, on fait une
 * synchronisation complète.
 */

const CURSOR_KEY = 'rewix_last_sync';

/** Lit le curseur de synchronisation, ou null s'il n'y en a jamais eu. */
export async function getSyncCursor() {
  const ligne = await dbGet('SELECT value FROM app_state WHERE key = ?', [CURSOR_KEY]);
  return ligne ? ligne.value : null;
}

async function setSyncCursor(value) {
  if (!value) return;
  await dbRun(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [CURSOR_KEY, value, Date.now()],
  );
}

/**
 * Synchronise le catalogue Rewix.
 *
 * `incremental` : quand un curseur existe, on ne demande que les changements.
 * Mettre `false` force une synchronisation complète — nécessaire quand Rewix
 * répond 412 (instantané de plus de 4 heures).
 *
 * Renvoie un compte rendu plutôt qu'un simple succès : « 0 produit » et
 * « 300 produits » ne veulent pas dire la même chose selon qu'on attendait une
 * mise à jour ou un catalogue entier.
 */
export async function syncRewixCatalog({ fetchImpl = fetch, incremental = true } = {}) {
  const curseur = incremental ? await getSyncCursor() : null;

  const { items, totalItems, lastUpdate, truncated } = await fetchCatalog({ since: curseur, fetchImpl });

  const compteRendu = {
    mode: curseur ? 'incrémental' : 'complet',
    depuis: curseur,
    recus: items.length,
    annonces: totalItems,
    tronque: truncated,
    crees: 0,
    misAJour: 0,
    ignores: 0,
    sansPrix: 0,
    // Les produits locaux portant le même SKU : signalés, jamais écrasés.
    conflits: [],
    erreurs: [],
  };

  const maintenant = Date.now();

  for (const item of items) {
    let produit;
    try {
      produit = mapProduct(item);
    } catch (error) {
      compteRendu.erreurs.push(`${item?.code || '?'} : ${error.message}`);
      continue;
    }
    if (!produit) continue;

    if (!(produit.costPrice > 0)) compteRendu.sansPrix += 1;

    const existant = await dbGet('SELECT id, source_ref FROM products WHERE sku = ?', [produit.sku]);

    if (existant && !existant.source_ref) {
      // Produit local : on ne l'écrase pas, on le signale.
      compteRendu.ignores += 1;
      compteRendu.conflits.push(produit.sku);
      continue;
    }

    try {
      await dbRun(
        `INSERT INTO products (sku, name, description, cost_price, created_at, weight_g, hs_code, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sku) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           cost_price = excluded.cost_price,
           weight_g = excluded.weight_g,
           hs_code = excluded.hs_code,
           source_ref = excluded.source_ref`,
        [
          produit.sku,
          produit.name,
          produit.description,
          produit.costPrice,
          maintenant,
          produit.weightGrams,
          produit.hsCode,
          produit.sourceRef,
        ],
      );
      if (existant) compteRendu.misAJour += 1;
      else compteRendu.crees += 1;
    } catch (error) {
      compteRendu.erreurs.push(`${produit.sku} : ${error.message}`);
    }
  }

  // Le curseur n'avance QUE si la synchronisation n'a pas été tronquée : avancer
  // sur un catalogue incomplet ferait manquer définitivement les produits non
  // reçus, puisqu'on ne les redemanderait jamais.
  if (lastUpdate && !truncated && compteRendu.erreurs.length === 0) {
    await setSyncCursor(lastUpdate);
    compteRendu.curseur = lastUpdate;
  } else {
    compteRendu.curseur = curseur;
  }

  const resume = `Rewix (${compteRendu.mode}) : ${compteRendu.crees} créé(s), `
    + `${compteRendu.misAJour} mis à jour, ${compteRendu.ignores} ignoré(s), `
    + `${compteRendu.sansPrix} sans prix.`;
  await logActivity('REWIX_SYNC', resume);

  return compteRendu;
}

/** État lisible du connecteur, pour l'écran Paramètres. */
export async function rewixStatus() {
  const curseur = await getSyncCursor();
  const { n } = await dbGet('SELECT COUNT(*) AS n FROM products WHERE source_ref IS NOT NULL') || { n: 0 };
  return {
    curseur,
    produitsSynchronises: n,
  };
}
