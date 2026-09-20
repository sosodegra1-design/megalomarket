/**
 * Calcule le prix de vente conseillé à partir du prix d'achat fournisseur.
 * Verrou anti-vente à perte : le résultat n'est jamais inférieur à
 * (prix d'achat + frais fixes), quel que soit le coefficient de marge fourni.
 */
export function computeSuggestedPrice(purchasePrice, { marginCoefficient = 1.8, fixedFee = 0 } = {}) {
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
    throw new Error("Prix d'achat invalide.");
  }
  if (!Number.isFinite(marginCoefficient) || marginCoefficient <= 1) {
    throw new Error('Coefficient de marge invalide (doit être supérieur à 1).');
  }
  if (!Number.isFinite(fixedFee) || fixedFee < 0) {
    throw new Error('Frais fixes invalides.');
  }

  const floor = purchasePrice + fixedFee;
  const raw = purchasePrice * marginCoefficient + fixedFee;
  return Math.round(Math.max(raw, floor) * 100) / 100;
}
