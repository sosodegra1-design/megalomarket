/**
 * Calcul du prix de vente conseillé, en deux étapes chaînées.
 *
 *   1. `computeLandedCost`     — prix fournisseur → euros → + frais du lot répartis
 *   2. `computeSuggestedPrice` — coût rendu × coefficient + frais fixes
 *
 * Pourquoi la conversion a été ajoutée : le hub multipliait un prix en DOLLARS
 * par un coefficient, puis appelait le résultat des euros. Sur un produit à
 * 0,75 $ avec un coefficient de 1,8, il annonçait « 1,35 € » — un prix faux, et
 * faux en silence. Il ignorait aussi le transport : sur ce même produit, le port
 * coûte plus de trois fois le prix de la marchandise.
 *
 * Ce module reste PUR : il ne lit ni la base ni le réseau. Les taux lui sont
 * passés en argument, ce qui le rend testable sans rien monter.
 */

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Convertit un montant d'une devise vers l'euro.
 *
 * `rates` associe un code de devise à sa valeur en euros (EUR → 1).
 *
 * LÈVE si la devise est inconnue, et c'est délibéré : supposer un taux de 1
 * reviendrait à confondre des yuans avec des euros, donc à publier un prix de
 * vente plusieurs fois trop bas. Un prix absent se voit et se corrige ; un prix
 * faux se vend.
 */
export function convertToEur(amount, currency, rates = {}) {
  if (!Number.isFinite(amount)) throw new Error('Montant à convertir invalide.');

  const code = String(currency || '').trim().toUpperCase();
  if (!code) throw new Error('Devise manquante.');

  const rate = rates[code];
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(
      `Devise « ${code} » inconnue : aucun taux enregistré. `
      + 'Renseigne-la dans Paramètres avant de calculer un prix — deviner le taux publierait un prix faux.',
    );
  }

  return amount * rate;
}

/**
 * Coût rendu unitaire : ce qu'une pièce coûte réellement, transport et douane
 * compris, exprimé en euros.
 *
 * Les frais se connaissent par LOT (un envoi de 500 pièces coûte un forfait de
 * transport), pas par pièce : c'est la division qui donne le coût unitaire.
 * D'où `lotQuantity` et `lotFees` — et non « frais par unité », qui obligerait
 * à refaire la division à chaque saisie.
 */
export function computeLandedCost({
  purchasePrice,
  currency,
  lotQuantity = 1,
  lotFees = 0,
  rates = {},
} = {}) {
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
    throw new Error("Prix d'achat invalide.");
  }
  if (!Number.isInteger(lotQuantity) || lotQuantity < 1) {
    throw new Error('Quantité du lot invalide (doit être un entier supérieur ou égal à 1).');
  }
  if (!Number.isFinite(lotFees) || lotFees < 0) {
    throw new Error('Frais du lot invalides.');
  }

  const unitPriceEur = convertToEur(purchasePrice, currency, rates);
  const feesPerUnit = lotFees / lotQuantity;
  return round2(unitPriceEur + feesPerUnit);
}

/**
 * Calcule le prix de vente conseillé à partir du COÛT RENDU (en euros).
 * Verrou anti-vente à perte : le résultat n'est jamais inférieur à
 * (coût rendu + frais fixes), quel que soit le coefficient de marge fourni.
 *
 * L'arithmétique et les refus sont INCHANGÉS par rapport à la version
 * précédente : seule la nature de l'entrée change (un coût rendu au lieu d'un
 * prix fournisseur brut). C'est ce qui garantit qu'aucun appelant existant ne
 * se met à calculer autre chose à son insu — ce sont les appelants qui sont
 * mis à jour, un par un, pour lui passer un coût rendu.
 */
export function computeSuggestedPrice(landedCost, { marginCoefficient = 1.8, fixedFee = 0 } = {}) {
  if (!Number.isFinite(landedCost) || landedCost < 0) {
    throw new Error('Coût rendu invalide.');
  }
  if (!Number.isFinite(marginCoefficient) || marginCoefficient <= 1) {
    throw new Error('Coefficient de marge invalide (doit être supérieur à 1).');
  }
  if (!Number.isFinite(fixedFee) || fixedFee < 0) {
    throw new Error('Frais fixes invalides.');
  }

  const floor = landedCost + fixedFee;
  const raw = landedCost * marginCoefficient + fixedFee;
  return round2(Math.max(raw, floor));
}

/**
 * Chaîne complète, pour les appelants qui ont toutes les données sous la main :
 * prix fournisseur en devise → coût rendu → prix de vente conseillé.
 *
 * Renvoie aussi le DÉTAIL du calcul. Un prix de vente qu'on ne peut pas
 * justifier six mois plus tard est un prix qu'on ne peut pas défendre : le
 * détail permet de retrouver le taux appliqué et la part exacte du transport.
 */
export function computePriceFromSupplier({
  purchasePrice,
  currency,
  lotQuantity = 1,
  lotFees = 0,
  rates = {},
  marginCoefficient,
  fixedFee,
} = {}) {
  const landedCost = computeLandedCost({ purchasePrice, currency, lotQuantity, lotFees, rates });
  const suggestedPrice = computeSuggestedPrice(landedCost, { marginCoefficient, fixedFee });

  const code = String(currency || '').trim().toUpperCase();
  return {
    landedCost,
    suggestedPrice,
    detail: {
      purchasePrice,
      currency: code,
      rate: rates[code] ?? null,
      priceInEur: round2(convertToEur(purchasePrice, currency, rates)),
      lotQuantity,
      lotFees,
      feesPerUnit: round2(lotFees / lotQuantity),
    },
  };
}
