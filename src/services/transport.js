import { dbAll, dbGet } from '../db/database.js';

/*
 * À DÉFAUT D'INDICATION SUR LA PAGE, C'EST AU HUB D'ESTIMER LE TRANSPORT.
 *
 * Une fiche fournisseur n'écrit pas toujours ses frais de port. Le prix calculé
 * sans transport ne couvre alors pas l'achat : on vend à perte en croyant
 * marger. Ce module fournit le transport à partir de NOS transporteurs.
 *
 * LE CALCUL, ET SA LIMITE. Un transporteur porte un coût par ENVOI
 * (`suppliers.shipping_cost`) et un délai (`shipping_days`). On divise ce coût
 * par la quantité du lot : un envoi de 500 pièces répartit son forfait sur 500
 * pièces, un envoi d'une pièce le supporte seul. C'est grossier — le vrai tarif
 * dépend du poids et de la destination — mais c'est EXPLICITE, vérifiable, et
 * modifiable par l'utilisateur. Une estimation annoncée vaut mieux qu'un zéro
 * silencieux.
 *
 * CE QUE CE MODULE NE FAIT PAS : inventer un tarif. Si aucun transporteur ne
 * porte de coût, il le dit (`source: 'aucun'`) et l'appelant doit prévenir.
 */

/** Le transporteur à utiliser : celui de l'import, sinon le premier tarifé. */
export async function carrierForImport(importRow) {
  if (importRow && importRow.carrier_id != null) {
    const choisi = await dbGet(
      'SELECT id, name, shipping_cost, shipping_days FROM suppliers WHERE id = ? AND kind = ?',
      [importRow.carrier_id, 'transporteur'],
    );
    if (choisi) return { ...choisi, implicite: false };
  }

  /* Aucun transporteur désigné : on prend le premier transporteur ACTIF qui
     porte un tarif. C'est un défaut assumé, pas un choix de l'utilisateur — d'où
     `implicite: true`, que l'écran peut signaler. */
  const defaut = await dbGet(
    `SELECT id, name, shipping_cost, shipping_days FROM suppliers
     WHERE kind = 'transporteur' AND status = 'actif'
       AND shipping_cost IS NOT NULL AND shipping_cost > 0
     ORDER BY shipping_cost ASC, id ASC LIMIT 1`,
  );
  return defaut ? { ...defaut, implicite: true } : null;
}

/**
 * Coût transporteur par pièce, en euros — ou 0 avec la raison.
 *
 * Renvoie `{ carrierCostEur, carrierName, implicite, raison }`.
 * `raison` explique pourquoi c'est 0 : « aucun transporteur tarifé », ce qui est
 * très différent de « transport gratuit ».
 */
export async function carrierCostForImport(importRow) {
  const porteur = await carrierForImport(importRow);

  if (!porteur) {
    return {
      carrierCostEur: 0,
      carrierName: null,
      implicite: false,
      raison: 'Aucun transporteur ne porte de tarif : renseigne un coût dans Transporteurs, sinon le prix ne couvre pas le port.',
    };
  }

  const cout = Number(porteur.shipping_cost);
  if (!Number.isFinite(cout) || cout <= 0) {
    return {
      carrierCostEur: 0,
      carrierName: porteur.name,
      implicite: porteur.implicite,
      raison: `Le transporteur « ${porteur.name} » n'a pas de coût renseigné.`,
    };
  }

  const quantite = Number.isInteger(importRow?.lot_quantity) && importRow.lot_quantity > 0
    ? importRow.lot_quantity
    : 1;

  return {
    carrierCostEur: Math.round((cout / quantite) * 100) / 100,
    carrierName: porteur.name,
    implicite: porteur.implicite,
    raison: null,
  };
}

/** Liste des transporteurs utilisables comme tarif (pour l'écran). */
export async function carriersWithRates() {
  const rows = await dbAll(
    `SELECT id, name, shipping_cost, shipping_days FROM suppliers
     WHERE kind = 'transporteur' AND status = 'actif'
     ORDER BY name COLLATE NOCASE`,
  );
  return rows;
}
