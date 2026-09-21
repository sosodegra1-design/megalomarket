import { dbAll, dbRun } from './database.js';

/*
 * Catalogue de départ des partenaires (plateformes de gros et distributeurs).
 *
 * Le hub avait un registre de partenaires… vide : sur un déploiement neuf, le
 * propriétaire devait retaper à la main chaque plateforme qu'il connaît déjà, et
 * l'écran d'import n'avait personne à proposer dans sa liste. C'est un catalogue
 * de départ, pas un jardin fermé : on l'installe une fois pour que le hub soit
 * utilisable dès le premier démarrage, puis chacun ajoute, modifie ou supprime
 * ses partenaires comme avant — la table `suppliers` reste la seule source de
 * vérité, ce module ne fait que la remplir quand elle est vide.
 *
 * Les coefficients de marge sont des POINTS DE DÉPART, pas une vérité : ils
 * correspondent à l'ordre de grandeur constaté sur ce type de plateforme, et
 * doivent être ajustés au prix réellement négocié avec chacun. Un coefficient
 * trop optimiste ferait vendre à perte ; c'est au propriétaire de le corriger
 * depuis l'écran Partenaires.
 */
export const SUPPLIER_CATALOGUE = [
  // --- Fournisseurs : plateformes de sourcing (le plus souvent à l'étranger) ---
  {
    kind: 'fournisseur',
    name: 'Alibaba',
    siteUrl: 'https://www.alibaba.com',
    marginCoefficient: 2.2,
    notes: 'Marketplace B2B mondial. Gros volumes, MOQ souvent élevés.',
  },
  {
    kind: 'fournisseur',
    name: 'AliExpress',
    siteUrl: 'https://fr.aliexpress.com',
    marginCoefficient: 2.0,
    notes: 'Petits lots, pas de minimum. Entrepôts européens disponibles.',
  },
  {
    kind: 'fournisseur',
    name: 'Made-in-China',
    siteUrl: 'https://fr.made-in-china.com',
    marginCoefficient: 2.2,
    notes: 'Usines chinoises en direct, devis sur mesure.',
  },
  {
    kind: 'fournisseur',
    name: '1688 (Chine)',
    siteUrl: 'https://www.1688.com',
    marginCoefficient: 2.6,
    notes: 'Le gros chinois, prix les plus bas. Nécessite un agent ou un transitaire.',
  },
  {
    kind: 'fournisseur',
    name: 'Global Sources',
    siteUrl: 'https://www.globalsources.com',
    marginCoefficient: 2.2,
    notes: 'Fournisseurs asiatiques vérifiés, salons de Canton.',
  },
  {
    kind: 'fournisseur',
    name: 'DHgate',
    siteUrl: 'https://fr.dhgate.com',
    marginCoefficient: 2.3,
    notes: 'Petits lots sans minimum, idéal pour tester un produit.',
  },
  {
    kind: 'fournisseur',
    name: 'Banggood',
    siteUrl: 'https://www.banggood.com',
    marginCoefficient: 2.0,
    notes: 'Dropshipping, entrepôts européens.',
  },
  {
    kind: 'fournisseur',
    name: 'Temu',
    siteUrl: 'https://www.temu.com',
    marginCoefficient: 1.9,
    notes: 'Prix très agressifs. Vérifier la qualité avant revente.',
  },
  {
    kind: 'fournisseur',
    name: 'Taobao',
    siteUrl: 'https://www.taobao.com',
    marginCoefficient: 2.6,
    notes: 'Marché intérieur chinois. Passe par un agent.',
  },
  {
    kind: 'fournisseur',
    name: 'Yiwugo',
    siteUrl: 'https://www.yiwugo.com',
    marginCoefficient: 2.4,
    notes: 'Marché de Yiwu : petite marchandise, jouets, accessoires.',
  },
  {
    kind: 'fournisseur',
    name: 'Alibaba France (revendeurs)',
    siteUrl: 'https://www.alibaba.com/countrysearch/FR-suppliers.html',
    marginCoefficient: 2.0,
    notes: "Fournisseurs basés en France : délais courts, TVA dans l'UE.",
  },

  // --- Distributeurs : grossistes et dropshipping, souvent en Europe ---
  {
    kind: 'distributeur',
    name: 'BigBuy',
    siteUrl: 'https://www.bigbuy.eu',
    marginCoefficient: 2.0,
    notes: "Grossiste espagnol, dropshipping, TVA dans l'UE, stock réel.",
  },
  {
    kind: 'distributeur',
    name: 'Spocket',
    siteUrl: 'https://www.spocket.co',
    marginCoefficient: 2.2,
    notes: 'Fournisseurs européens et américains pour le dropshipping.',
  },
  {
    kind: 'distributeur',
    name: 'Syncee',
    siteUrl: 'https://syncee.com',
    marginCoefficient: 2.2,
    notes: 'Annuaire de grossistes et de dropshippers.',
  },
  {
    kind: 'distributeur',
    name: 'Modalyst',
    siteUrl: 'https://www.modalyst.co',
    marginCoefficient: 2.2,
    notes: 'Marques et grossistes, dropshipping.',
  },
  {
    kind: 'distributeur',
    name: 'Faire',
    siteUrl: 'https://www.faire.com',
    marginCoefficient: 2.2,
    notes: 'Marques indépendantes en gros, Europe et États-Unis.',
  },
  {
    kind: 'distributeur',
    name: 'Ankorstore',
    siteUrl: 'https://www.ankorstore.com',
    marginCoefficient: 2.2,
    notes: 'Grossistes européens, petites séries.',
  },
  {
    kind: 'distributeur',
    name: 'Orderchamp',
    siteUrl: 'https://www.orderchamp.com',
    marginCoefficient: 2.2,
    notes: 'Grossistes européens, commandes minimum basses.',
  },
  {
    kind: 'distributeur',
    name: 'Tundra',
    siteUrl: 'https://www.tundra.com',
    marginCoefficient: 2.2,
    notes: 'Grossistes et fabricants, livraison directe.',
  },
  {
    kind: 'distributeur',
    name: 'Printful',
    siteUrl: 'https://www.printful.com',
    marginCoefficient: 2.4,
    notes: 'Impression à la demande : aucun stock, aucun risque.',
  },
  {
    kind: 'distributeur',
    name: 'Printify',
    siteUrl: 'https://printify.com',
    marginCoefficient: 2.4,
    notes: "Impression à la demande, réseau d'ateliers.",
  },
  {
    kind: 'distributeur',
    name: 'Gelato',
    siteUrl: 'https://www.gelato.com',
    marginCoefficient: 2.4,
    notes: 'Impression à la demande, production locale dans de nombreux pays.',
  },
  {
    kind: 'distributeur',
    name: 'Cdiscount Pro',
    siteUrl: 'https://pro.cdiscount.com',
    marginCoefficient: 1.8,
    notes: 'Gros français : électroménager, high-tech, maison.',
  },
  {
    kind: 'distributeur',
    name: 'ManoMano Pro',
    siteUrl: 'https://pro.manomano.fr',
    marginCoefficient: 1.9,
    notes: 'Gros français : maison, bricolage, jardin.',
  },
  {
    kind: 'distributeur',
    name: 'Amazon Business',
    siteUrl: 'https://business.amazon.fr',
    marginCoefficient: 1.8,
    notes: 'Achats professionnels, facturation TVA, livraison rapide.',
  },
];

/**
 * Installe le catalogue de départ, uniquement si la table `suppliers` est
 * entièrement vide.
 *
 * Le garde-fou est la vacuité de la table, et non la présence de tel ou tel
 * nom : c'est ce qui rend l'opération sûre à rejouer. Une base de production
 * contient déjà des partenaires — saisis à la main, renommés, complétés de
 * marges négociées — et le seed ne doit jamais y toucher, même si certains
 * noms du catalogue y figurent déjà ou si d'autres manquent. Seule une table
 * vide (déploiement neuf, ou base réinitialisée volontairement) reçoit le
 * catalogue. Un second appel ne peut donc rien insérer : après le premier, la
 * table n'est plus vide.
 *
 * Les lignes sont insérées une par une, comme le fait la route POST, pour que
 * le style de la base reste identique qu'un partenaire vienne du catalogue ou
 * du formulaire.
 */
export async function seedSuppliersIfEmpty() {
  const existing = await dbAll('SELECT COUNT(*) AS total FROM suppliers');
  if (Number(existing[0]?.total ?? 0) > 0) return { seeded: 0 };

  for (const entry of SUPPLIER_CATALOGUE) {
    const now = new Date().toISOString();
    await dbRun(
      `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'actif', ?, ?, ?)`,
      [entry.kind, entry.name, entry.siteUrl, entry.marginCoefficient, entry.notes, now, now],
    );
  }

  return { seeded: SUPPLIER_CATALOGUE.length };
}
