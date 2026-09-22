/*
 * Tarification automatique de la chaîne autonome (voir src/routes/pipeline.js).
 * Volontairement du calcul PUR, sans IA : la règle « toujours x3 minimum » est
 * une garantie mathématique, pas une suggestion qu'un modèle de langage
 * pourrait interpréter ou arrondir dans le mauvais sens.
 */

export const MIN_MARGIN_COEFFICIENT = 3;

/**
 * Prix de vente conseillé à partir d'un coût d'achat : coût x3 minimum,
 * arrondi stratégique au .99 supérieur (jamais en dessous du x3 exact).
 * Tout le calcul se fait en centimes (entiers) pour éviter le bruit des
 * flottants (2.1667 x 3 x 100 ...).
 *
 * Exemples : 2,00 € -> 6,99 € (6,00 € arrondi au .99 supérieur)
 *            2,33 € -> 6,99 € (6,99 € tombe déjà pile sur le x3)
 *            1,50 € -> 4,99 €
 */
export function computeSellPrice(purchasePrice) {
  const cost = Number(purchasePrice);
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error('Coût d\'achat invalide : un nombre strictement supérieur à 0 est attendu.');
  }
  const rawCents = Math.round(cost * MIN_MARGIN_COEFFICIENT * 100);
  const ceilEuroCents = Math.ceil(rawCents / 100) * 100;
  let priceCents = ceilEuroCents - 1; // X,99
  if (priceCents < rawCents) priceCents = ceilEuroCents + 99; // (X+1),99 — le .99 du dessous ne couvre pas le x3
  return Math.round(priceCents) / 100;
}

/** Marge nette réelle : prix de vente - coût d'achat - frais de livraison retenus. */
export function computeNetMargin({ sellPrice, purchasePrice, shippingCost }) {
  const sell = Number(sellPrice);
  const cost = Number(purchasePrice);
  const shipping = Number.isFinite(Number(shippingCost)) ? Number(shippingCost) : 0;
  return Math.round((sell - cost - shipping) * 100) / 100;
}
