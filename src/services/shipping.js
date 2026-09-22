import { dbAll } from '../db/database.js';

/*
 * Comparaison automatique des transporteurs (voir src/routes/pipeline.js).
 *
 * IMPORTANT — nature des données : aucune API de cotation en temps réel n'est
 * branchée ici (ni sur les transporteurs, ni sur les fournisseurs). Le coût et
 * le délai comparés viennent des colonnes suppliers.shipping_cost /
 * shipping_days, renseignées à la main dans l'onglet Transporteurs. C'est une
 * VRAIE comparaison automatique — sur des données réelles que quelqu'un a
 * entrées — pas une estimation inventée par un modèle de langage.
 */

/**
 * Retourne le transporteur actif le moins cher, dont le délai (s'il est
 * renseigné) respecte maxDays. Un transporteur sans shipping_cost renseigné
 * est ignoré : un coût inconnu n'est jamais traité comme gratuit.
 */
export async function cheapestCarrier({ maxDays } = {}) {
  const carriers = await dbAll(
    `SELECT * FROM suppliers WHERE kind = 'transporteur' AND status = 'actif' AND shipping_cost IS NOT NULL`,
  );
  const eligible = carriers.filter((c) => {
    if (maxDays == null) return true;
    return c.shipping_days != null && Number(c.shipping_days) <= Number(maxDays);
  });
  if (!eligible.length) return null;
  eligible.sort((a, b) => Number(a.shipping_cost) - Number(b.shipping_cost));
  const best = eligible[0];
  return {
    id: best.id,
    name: best.name,
    shippingCost: Number(best.shipping_cost),
    shippingDays: best.shipping_days != null ? Number(best.shipping_days) : null,
  };
}
