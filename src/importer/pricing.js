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
/*
 * D'OÙ VIENT LE TRANSPORT — et combien.
 *
 * TROIS ORIGINES, UNE SEULE RETENUE, dans cet ordre :
 *
 *   1. la FICHE fournisseur (`shippingPrice`, écrit sur la page) ;
 *   2. le TRANSPORTEUR (`carrierCostEur`) — la règle demandée : à défaut
 *      d'indication sur la page, c'est au hub d'estimer avec NOS transporteurs ;
 *   3. le FORFAIT DE LOT (`lotFees` réparti sur `lotQuantity`), pour les imports
 *      saisis avant l'existence des deux premiers ;
 *   4. sinon 0, et l'appelant DOIT le signaler : un prix calculé sans transport
 *      ne couvre pas l'achat.
 *
 * Jamais de cumul : additionner deux origines compterait le port deux fois.
 *
 * La source est renvoyée pour que l'écran puisse la dire. Un transport LU sur la
 * page et un transport ESTIMÉ au tarif d'un transporteur n'ont pas la même
 * valeur de preuve, et l'utilisateur doit pouvoir faire la différence.
 */
export function resolveTransport({
  currency,
  shippingPrice = 0,
  carrierCostEur = 0,
  lotQuantity = 1,
  lotFees = 0,
  rates = {},
} = {}) {
  if (Number.isFinite(shippingPrice) && shippingPrice > 0) {
    return { perPieceEur: round2(convertToEur(shippingPrice, currency, rates)), source: 'fiche' };
  }
  if (Number.isFinite(carrierCostEur) && carrierCostEur > 0) {
    return { perPieceEur: round2(carrierCostEur), source: 'transporteur' };
  }
  if (Number.isFinite(lotFees) && lotFees > 0) {
    return { perPieceEur: round2(lotFees / lotQuantity), source: 'lot' };
  }
  return { perPieceEur: 0, source: 'aucun' };
}

export function computeLandedCost({
  purchasePrice,
  currency,
  shippingPrice = 0,
  carrierCostEur = 0,
  lotQuantity = 1,
  lotFees = 0,
  rates = {},
} = {}) {
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
    throw new Error("Prix d'achat invalide.");
  }
  if (!Number.isFinite(shippingPrice) || shippingPrice < 0) {
    throw new Error('Transport invalide.');
  }
  if (!Number.isInteger(lotQuantity) || lotQuantity < 1) {
    throw new Error('Quantité du lot invalide (doit être un entier supérieur ou égal à 1).');
  }
  if (!Number.isFinite(lotFees) || lotFees < 0) {
    throw new Error('Frais du lot invalides.');
  }

  const unitPriceEur = convertToEur(purchasePrice, currency, rates);

  /* LE TRANSPORT, DE DEUX FAÇONS — ET UNE SEULE À LA FOIS.
   *
   * `shippingPrice` est le transport PAR PIÈCE, tel qu'il est souvent écrit sur
   * la fiche fournisseur (« Shipping: US$1.20/piece »). C'est la forme que
   * l'agent d'extraction remplit, et la plus simple à comprendre.
   *
   * `lotFees` / `lotQuantity` reste la forme « forfait pour un envoi de N
   * pièces ». Elle est conservée pour les imports déjà saisis, et n'est utilisée
   * QUE si aucun transport par pièce n'est renseigné : additionner les deux
   * compterait le transport deux fois — l'erreur la plus coûteuse du calcul.
   */
  const { perPieceEur } = resolveTransport({
    currency, shippingPrice, carrierCostEur, lotQuantity, lotFees, rates,
  });

  return round2(unitPriceEur + perPieceEur);
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
export function computeSuggestedPrice(landedCost, {
  marginCoefficient = 1.8,
  fixedFee = 0,
  marketPrice = null,
} = {}) {
  if (!Number.isFinite(landedCost) || landedCost < 0) {
    throw new Error('Coût rendu invalide.');
  }
  if (!Number.isFinite(marginCoefficient) || marginCoefficient <= 1) {
    throw new Error('Coefficient de marge invalide (doit être supérieur à 1).');
  }
  if (!Number.isFinite(fixedFee) || fixedFee < 0) {
    throw new Error('Frais fixes invalides.');
  }

  /* LE PRIX SE CALCULE SUR LE COÛT, SE PLAFONNE AU MARCHÉ, ET NE PASSE JAMAIS
   * SOUS LE COÛT RENDU.
   *
   * Trois bornes, dans cet ordre :
   *   1. le calcul : coût rendu × coefficient + frais fixes — notre marge voulue ;
   *   2. le marché : quand le prix de vente constaté est connu, il PLAFONNE. Une
   *      trottinette à 940 € était « correcte » au sens du calcul et absurde sur
   *      le marché : ce plafond manquait ;
   *   3. le verrou : jamais sous coût rendu + frais fixes, quel que soit le
   *      plafond. Un plafond trop bas signale un produit non viable — il ne doit
   *      pas se transformer en vente à perte.
   */
  const plancher = landedCost + fixedFee;
  const calcule = landedCost * marginCoefficient + fixedFee;
  const plafond = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : null;
  const retenu = plafond === null ? calcule : Math.min(calcule, plafond);
  return round2(Math.max(retenu, plancher));
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
  shippingPrice = 0,
  carrierCostEur = 0,
  lotQuantity = 1,
  lotFees = 0,
  rates = {},
  marginCoefficient,
  fixedFee,
  marketPrice = null,
} = {}) {
  const transport = resolveTransport({ currency, shippingPrice, carrierCostEur, lotQuantity, lotFees, rates });
  /* Deux repères pour le diagnostic : le prix calculé SANS plafond (pour savoir
     si le marché a réellement rogné), et le plafond retenu. */
  const plafondConnu = Number.isFinite(marketPrice) && marketPrice > 0 ? round2(marketPrice) : null;
  const landedCost = computeLandedCost({ purchasePrice, currency, shippingPrice, carrierCostEur, lotQuantity, lotFees, rates });
  const calculeSansPlafond = computeSuggestedPrice(landedCost, { marginCoefficient, fixedFee });
  const suggestedPrice = computeSuggestedPrice(landedCost, { marginCoefficient, fixedFee, marketPrice });

  const code = String(currency || '').trim().toUpperCase();
  const transportParPiece = shippingPrice > 0
    ? round2(convertToEur(shippingPrice, currency, rates))
    : round2(lotFees / lotQuantity);

  return {
    landedCost,
    suggestedPrice,
    detail: {
      purchasePrice,
      currency: code,
      rate: rates[code] ?? null,
      priceInEur: round2(convertToEur(purchasePrice, currency, rates)),
      shippingPrice,
      carrierCostEur,
      transportEur: transport.perPieceEur,
      /* Part du transport dans le coût rendu, en pourcentage. Au-delà de 50 %,
         le produit se vend surtout du port : ce n'est PAS une erreur de calcul,
         c'est le signal qu'il n'est pas viable à cette quantité. L'écran peut
         alors proposer un lot plus grand, sans jamais fausser le prix. */
      /* LE PRIX EST-IL SEULEMENT VENDABLE ?
       *
       * Quand le coût rendu dépasse le prix du marché, le produit ne peut pas se
       * vendre : ce n'est pas le coefficient qui est en cause, c'est le transport
       * (ou le lot) qui coûte plus cher que ce que le client paie.
       *
       * On le DIT au lieu de renvoyer silencieusement un prix trop haut —
       * constaté sur une brosse à dents calculée 28,37 € quand le marché est à 7. */
      marketPrice: plafondConnu,
      marketCapped: plafondConnu !== null && plafondConnu >= landedCost && plafondConnu < calculeSansPlafond,
      viable: plafondConnu === null || plafondConnu >= landedCost,
      partTransport: landedCost > 0
        ? round2((transport.perPieceEur / landedCost) * 100)
        : 0,
      // D'où vient le transport : 'fiche', 'transporteur', 'lot' ou 'aucun'.
      transportSource: transport.source,
      lotQuantity,
      lotFees,
      feesPerUnit: transportParPiece,
      // Le multiplicateur est conservé dans le détail : sans lui, impossible de
      // justifier un prix six mois plus tard.
      marginCoefficient,
    },
  };
}
