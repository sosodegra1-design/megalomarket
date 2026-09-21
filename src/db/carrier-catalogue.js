import { dbAll, dbRun } from './database.js';

/*
 * Catalogue de départ des transporteurs internationaux.
 *
 * Le propriétaire source en Chine et vend en France et sur les marketplaces :
 * la logistique est la moitié de son métier. Les transporteurs, transitaires et
 * agents d'achat ne sont pourtant pas des marchandises : ils vendent un service.
 *
 * NOTE IMPORTANTE SUR `marginCoefficient` :
 * un transporteur ne s'achète pas pour être revendu avec une marge — le
 * coefficient multiplicateur n'a donc AUCUN sens métier ici. La colonne existe
 * uniquement parce que la fiche vit dans la même table `suppliers` que les
 * fournisseurs et les distributeurs, et l'API exige une valeur strictement
 * supérieure à 1 quand elle est fournie. On met donc 1,5 partout : c'est un
 * simple remplissage technique, à ne jamais lire comme une marge réelle.
 *
 * Comme le catalogue des partenaires, c'est un point de départ et non un jardin
 * fermé : il est installé une seule fois pour que le hub soit utilisable dès le
 * premier démarrage, puis chacun ajoute, modifie ou supprime ses transporteurs
 * depuis l'écran Partenaires — la table `suppliers` reste la seule source de
 * vérité.
 */
export const CARRIER_CATALOGUE = [
  // --- Express international (porte-à-porte) ---
  {
    kind: 'transporteur',
    name: 'DHL Express',
    siteUrl: 'https://www.dhl.com/fr-fr/home.html',
    marginCoefficient: 1.5,
    notes: 'Express international. Rapide et cher, suivi fiable, dédouanement inclus.',
  },
  {
    kind: 'transporteur',
    name: 'FedEx',
    siteUrl: 'https://www.fedex.com/fr-fr/home.html',
    marginCoefficient: 1.5,
    notes: 'Express international. Bon pour les envois lourds et urgents.',
  },
  {
    kind: 'transporteur',
    name: 'UPS',
    siteUrl: 'https://www.ups.com/fr/fr/Home.page',
    marginCoefficient: 1.5,
    notes: 'Express international. Réseau large, tarifs négociables en volume.',
  },
  {
    kind: 'transporteur',
    name: 'Chronopost',
    siteUrl: 'https://www.chronopost.fr',
    marginCoefficient: 1.5,
    notes: "Express français, intégré à La Poste. Bon pour l'Europe.",
  },
  {
    kind: 'transporteur',
    name: 'DPD',
    siteUrl: 'https://www.dpd.com/fr/fr/',
    marginCoefficient: 1.5,
    notes: 'Réseau européen de colis, bon rapport prix/délai.',
  },
  {
    kind: 'transporteur',
    name: 'GLS',
    siteUrl: 'https://gls-group.com/FR/fr/',
    marginCoefficient: 1.5,
    notes: "Réseau européen, très présent en Allemagne et en Europe de l'Est.",
  },
  {
    kind: 'transporteur',
    name: 'Colissimo',
    siteUrl: 'https://www.laposte.fr/colissimo',
    marginCoefficient: 1.5,
    notes: 'Colis international de La Poste. Économique, dépôt en bureau.',
  },

  // --- Fret et transit (Asie → Europe) ---
  {
    kind: 'transporteur',
    name: 'Freightos',
    siteUrl: 'https://www.freightos.com',
    marginCoefficient: 1.5,
    notes: 'Comparateur de fret international. Devis maritime et aérien en ligne.',
  },
  {
    kind: 'transporteur',
    name: 'Flexport',
    siteUrl: 'https://www.flexport.com',
    marginCoefficient: 1.5,
    notes: 'Transitaire numérique. Fret maritime et aérien, dédouanement.',
  },
  {
    kind: 'transporteur',
    name: 'Kuehne+Nagel',
    siteUrl: 'https://www.kuehne-nagel.com',
    marginCoefficient: 1.5,
    notes: 'Gros transitaire mondial. Aérien, maritime, terrestre.',
  },
  {
    kind: 'transporteur',
    name: 'DSV',
    siteUrl: 'https://www.dsv.com',
    marginCoefficient: 1.5,
    notes: 'Transitaire mondial. Fret et logistique contractuelle.',
  },
  {
    kind: 'transporteur',
    name: 'Maersk',
    siteUrl: 'https://www.maersk.com',
    marginCoefficient: 1.5,
    notes: 'Armateur. Conteneurs complets ou groupage maritime.',
  },
  {
    kind: 'transporteur',
    name: 'CMA CGM',
    siteUrl: 'https://www.cma-cgm.com',
    marginCoefficient: 1.5,
    notes: 'Armateur français. Fret maritime mondial.',
  },
  {
    kind: 'transporteur',
    name: 'Bolloré Logistics',
    siteUrl: 'https://www.bollore-logistics.com',
    marginCoefficient: 1.5,
    notes: 'Transitaire français, forte présence en Afrique et en Asie.',
  },

  // --- Agents d'achat en Chine (indispensables pour 1688 et Taobao) ---
  {
    kind: 'transporteur',
    name: 'Superbuy',
    siteUrl: 'https://www.superbuy.com',
    marginCoefficient: 1.5,
    notes: "Agent d'achat chinois. Achète sur 1688 et Taobao, contrôle et réexpédie.",
  },
  {
    kind: 'transporteur',
    name: 'Sugargoo',
    siteUrl: 'https://www.sugargoo.com',
    marginCoefficient: 1.5,
    notes: "Agent d'achat chinois. Consolidation de colis, photos de contrôle.",
  },
  {
    kind: 'transporteur',
    name: 'CNFans',
    siteUrl: 'https://cnfans.com',
    marginCoefficient: 1.5,
    notes: "Agent d'achat chinois. Bon pour les petites commandes.",
  },
  {
    kind: 'transporteur',
    name: 'Yoybuy',
    siteUrl: 'https://www.yoybuy.com',
    marginCoefficient: 1.5,
    notes: "Agent d'achat chinois. Ancien et fiable, frais clairs.",
  },
  {
    kind: 'transporteur',
    name: 'Basetao',
    siteUrl: 'https://www.basetao.com',
    marginCoefficient: 1.5,
    notes: "Agent d'achat chinois. Contrôle qualité et réexpédie.",
  },

  // --- Plateformes d'expédition (multi-transporteurs) ---
  {
    kind: 'transporteur',
    name: 'Sendcloud',
    siteUrl: 'https://www.sendcloud.com/fr/',
    marginCoefficient: 1.5,
    notes: "Plateforme d'expédition multi-transporteurs. Comparaison et étiquettes.",
  },
  {
    kind: 'transporteur',
    name: 'Shippo',
    siteUrl: 'https://goshippo.com',
    marginCoefficient: 1.5,
    notes: "Plateforme d'expédition multi-transporteurs, orientée e-commerce.",
  },
  {
    kind: 'transporteur',
    name: 'Easyship',
    siteUrl: 'https://www.easyship.com',
    marginCoefficient: 1.5,
    notes: 'Expédition internationale multi-transporteurs, taxes estimées.',
  },
  {
    kind: 'transporteur',
    name: 'Boxtal',
    siteUrl: 'https://www.boxtal.com/fr/fr',
    marginCoefficient: 1.5,
    notes: 'Expédition française multi-transporteurs, tarifs négociés.',
  },
];

/**
 * Installe le catalogue des transporteurs, uniquement si AUCUN transporteur
 * n'existe déjà.
 *
 * Le garde-fou est la présence de transporteurs, et non la vacuité de la table
 * `suppliers` : celle-ci contient déjà les 25 fournisseurs et distributeurs du
 * catalogue précédent, et ces deux catalogues ne doivent jamais se bloquer
 * l'un l'autre. Symétriquement, une base où le propriétaire a déjà saisi ses
 * transporteurs (renommés, complétés, ou simplement choisis parmi d'autres)
 * ne reçoit rien : un second appel ne peut donc rien insérer.
 *
 * Les lignes sont insérées une par une, comme le fait la route POST, pour que
 * le style de la base soit identique qu'un transporteur vienne du catalogue ou
 * du formulaire.
 */
export async function seedCarriersIfEmpty() {
  const existing = await dbAll("SELECT COUNT(*) AS total FROM suppliers WHERE kind = 'transporteur'");
  if (Number(existing[0]?.total ?? 0) > 0) return { seeded: 0 };

  for (const entry of CARRIER_CATALOGUE) {
    const now = new Date().toISOString();
    await dbRun(
      `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'actif', ?, ?, ?)`,
      [entry.kind, entry.name, entry.siteUrl, entry.marginCoefficient, entry.notes, now, now],
    );
  }

  return { seeded: CARRIER_CATALOGUE.length };
}
