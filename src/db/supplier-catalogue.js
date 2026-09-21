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

  /*
   * --- Ajouts sectoriels ---
   *
   * Les 25 entrées ci-dessus sont le catalogue d'origine : elles restent
   * inchangées, car elles sont déjà semées dans la base de production et un
   * renommage désynchroniserait la fiche installée du code.
   *
   * Les entrées qui suivent couvrent les familles de produits réellement
   * vendues par la boutique. Chaque adresse a été ouverte et vérifiée le jour de
   * l'ajout ; une adresse vivante aujourd'hui ne garantit rien pour demain, un
   * domaine pouvant fermer ou changer de propriétaire sans préavis. Les marges
   * restent des points de départ, à corriger depuis l'écran Partenaires.
   */

  // --- Jouets et jeux ---
  {
    kind: 'distributeur',
    name: 'Heutink International (jouets éducatifs)',
    siteUrl: 'https://www.heutink.com',
    marginCoefficient: 2.3,
    notes: "Jouets et jeux. Grossiste néerlandais de matériel éducatif et de jeux d'éveil, petites séries.",
  },
  {
    kind: 'distributeur',
    name: 'Keel Toys (peluches)',
    siteUrl: 'https://www.keeltoys.com',
    marginCoefficient: 2.3,
    notes: "Jouets et jeux. Peluches et doudous en gros, distributeur britannique présent dans toute l'Europe.",
  },
  {
    kind: 'distributeur',
    name: 'small foot (jouets en bois)',
    siteUrl: 'https://www.small-foot.de',
    marginCoefficient: 2.3,
    notes: 'Jouets et jeux. Jouets en bois allemands, marque du groupe Legler, réseau de revendeurs.',
  },
  {
    kind: 'distributeur',
    name: 'Djeco (jeux et jouets)',
    siteUrl: 'https://www.djeco.com',
    marginCoefficient: 2.3,
    notes: 'Jouets et jeux. Marque française de jeux et de loisirs créatifs, commandes via son réseau de distributeurs.',
  },
  {
    kind: 'distributeur',
    name: "Janod (jouets d'éveil)",
    siteUrl: 'https://www.janod.com',
    marginCoefficient: 2.3,
    notes: "Jouets et jeux. Marque française de jouets en bois et d'éveil, espace professionnel revendeurs.",
  },

  // --- Puériculture et bébé ---
  {
    kind: 'distributeur',
    name: 'Babymoov (puériculture)',
    siteUrl: 'https://babymoov.com',
    marginCoefficient: 2.4,
    notes: 'Puériculture et bébé. Marque française, compte professionnel pour revendeurs et boutiques.',
  },
  {
    kind: 'distributeur',
    name: "Noukie's (puériculture)",
    siteUrl: 'https://www.noukies.com',
    marginCoefficient: 2.4,
    notes: 'Puériculture et bébé. Doudous, textiles et accessoires pour bébés, ventes en gros aux revendeurs.',
  },
  {
    kind: 'distributeur',
    name: 'Lilliputiens (puériculture et éveil)',
    siteUrl: 'https://www.lilliputiens.com',
    marginCoefficient: 2.4,
    notes: "Puériculture et bébé. Jouets d'éveil et textiles belges, distributeurs et boutiques spécialisées.",
  },

  // --- Vêtements enfants ---
  {
    kind: 'distributeur',
    name: 'Mayoral (vêtements enfants)',
    siteUrl: 'https://www.mayoral.com',
    marginCoefficient: 2.4,
    notes: 'Vêtements enfants. Marque espagnole de mode enfantine vendue en gros aux détaillants.',
  },
  {
    kind: 'distributeur',
    name: 'Tartine et Chocolat (vêtements enfants)',
    siteUrl: 'https://www.tartine-et-chocolat.com',
    marginCoefficient: 2.5,
    notes: 'Vêtements enfants. Marque française haut de gamme, collections en gros pour revendeurs.',
  },

  // --- Mode adulte et prêt-à-porter ---
  {
    kind: 'distributeur',
    name: 'FashionGo (mode en gros)',
    siteUrl: 'https://www.fashiongo.net',
    marginCoefficient: 2.4,
    notes: 'Mode adulte et prêt-à-porter. Marketplace B2B américaine, des milliers de grossistes en mode.',
  },
  {
    kind: 'distributeur',
    name: 'JOOR (mode en gros)',
    siteUrl: 'https://www.joor.com',
    marginCoefficient: 2.4,
    notes: 'Mode adulte et prêt-à-porter. Plateforme B2B entre marques et détaillants, commandes saisonnières.',
  },
  {
    kind: 'distributeur',
    name: 'Le New Black (mode en gros)',
    siteUrl: 'https://www.lenewblack.com',
    marginCoefficient: 2.4,
    notes: 'Mode adulte et prêt-à-porter. Plateforme française de ventes B2B pour marques et showrooms.',
  },
  {
    kind: 'fournisseur',
    name: 'Wholesale7 (mode en gros)',
    siteUrl: 'https://www.wholesale7.net',
    marginCoefficient: 2.5,
    notes: 'Mode adulte et prêt-à-porter. Grossiste asiatique de prêt-à-porter, petites quantités sans minimum.',
  },

  // --- Chaussures et maroquinerie ---
  {
    kind: 'distributeur',
    name: '1MODA (chaussures et maroquinerie)',
    siteUrl: 'https://www.1moda.fr',
    marginCoefficient: 2.5,
    notes: 'Chaussures et maroquinerie. Plateforme B2B française de grossistes en chaussures, sacs et bijoux.',
  },
  {
    kind: 'distributeur',
    name: 'Wortmann Group (chaussures)',
    siteUrl: 'https://wortmann-group.com',
    marginCoefficient: 2.4,
    notes: 'Chaussures et maroquinerie. Groupe allemand de chaussures, marques Tamaris et Caprice, réseau pro.',
  },

  // --- Électronique, high-tech et accessoires téléphone ---
  {
    kind: 'distributeur',
    name: 'PowerPlanetOnline (high-tech)',
    siteUrl: 'https://www.powerplanetonline.com',
    marginCoefficient: 1.7,
    notes: 'Électronique et high-tech. Grossiste espagnol, dropshipping et entrepôt européen.',
  },
  {
    kind: 'distributeur',
    name: 'Hama (accessoires high-tech)',
    siteUrl: 'https://www.hama.com',
    marginCoefficient: 1.8,
    notes: 'Électronique et accessoires téléphone. Grossiste allemand, câbles, chargeurs et supports.',
  },
  {
    kind: 'distributeur',
    name: 'Natec (accessoires téléphone)',
    siteUrl: 'https://natec-zone.com',
    marginCoefficient: 1.9,
    notes: 'Électronique et accessoires téléphone. Fabricant européen, périphériques et accessoires, tarifs pro.',
  },

  // --- Informatique ---
  {
    kind: 'distributeur',
    name: 'TD SYNNEX (informatique)',
    siteUrl: 'https://www.tdsynnex.com',
    marginCoefficient: 1.6,
    notes: 'Informatique et high-tech. Distributeur mondial, compte revendeur, stock et logistique.',
  },
  {
    kind: 'distributeur',
    name: 'ALSO (informatique)',
    siteUrl: 'https://www.also.com',
    marginCoefficient: 1.6,
    notes: 'Informatique et high-tech. Distributeur européen, matériel et logiciels pour revendeurs.',
  },
  {
    kind: 'distributeur',
    name: 'LDLC.pro (informatique)',
    siteUrl: 'https://www.ldlc.pro',
    marginCoefficient: 1.6,
    notes: "Informatique. Distributeur français, tarifs professionnels et facturation d'entreprise.",
  },
  {
    kind: 'distributeur',
    name: 'Westcoast (informatique)',
    siteUrl: 'https://www.westcoast.co.uk',
    marginCoefficient: 1.6,
    notes: 'Informatique et high-tech. Distributeur britannique, gros volumes et grandes marques informatiques.',
  },
  {
    kind: 'distributeur',
    name: 'Inter-Tech (informatique)',
    siteUrl: 'https://www.inter-tech.de',
    marginCoefficient: 1.7,
    notes: 'Informatique. Grossiste allemand de boîtiers, alimentations et accessoires pour assembleurs.',
  },

  // --- Maison, décoration, cuisine et literie ---
  {
    kind: 'distributeur',
    name: 'vidaXL (maison et jardin)',
    siteUrl: 'https://www.vidaxl.fr',
    marginCoefficient: 2.1,
    notes: 'Maison et jardin. Grossiste néerlandais, dropshipping et livraison directe sans stock.',
  },
  {
    kind: 'distributeur',
    name: 'GGM Gastro (cuisine professionnelle)',
    siteUrl: 'https://www.ggmgastro.com',
    marginCoefficient: 2.1,
    notes: "Maison et cuisine. Grossiste allemand de matériel de cuisine et d'équipement pour professionnels.",
  },
  {
    kind: 'distributeur',
    name: 'Paulmann (éclairage)',
    siteUrl: 'https://fr.paulmann.com',
    marginCoefficient: 2.1,
    notes: "Maison et décoration. Fabricant allemand d'éclairage, tarifs revendeurs et dropshipping.",
  },

  // --- Beauté, cosmétiques et soins ---
  {
    kind: 'distributeur',
    name: 'Aroma-Zone (beauté et soins)',
    siteUrl: 'https://www.aroma-zone.com',
    marginCoefficient: 2.6,
    notes: 'Beauté et soins. Aromathérapie et cosmétiques naturels français, espace professionnel.',
  },
  {
    kind: 'distributeur',
    name: 'Puressentiel (huiles essentielles)',
    siteUrl: 'https://www.puressentiel.com',
    marginCoefficient: 2.5,
    notes: 'Beauté et soins. Huiles essentielles et compléments, marque française distribuée aux revendeurs.',
  },
  {
    kind: 'distributeur',
    name: 'Salon Services (beauté et coiffure)',
    siteUrl: 'https://www.salon-services.com',
    marginCoefficient: 2.6,
    notes: 'Beauté et cosmétiques. Grossiste britannique pour salons, matériel et produits de soin.',
  },

  // --- Sport, plein air et fitness ---
  {
    kind: 'distributeur',
    name: 'Tradeinn (sport)',
    siteUrl: 'https://www.tradeinn.com',
    marginCoefficient: 2.2,
    notes: 'Sport et plein air. Distributeur espagnol, sport, mode et technologie, expédition européenne.',
  },
  {
    kind: 'distributeur',
    name: 'Decathlon Pro (sport)',
    siteUrl: 'https://www.decathlonpro.fr',
    marginCoefficient: 2.0,
    notes: 'Sport et fitness. Espace professionnel du groupe Decathlon, tarifs pro et facturation.',
  },
  {
    kind: 'distributeur',
    name: 'Nencini Sport (sport)',
    siteUrl: 'https://www.nencinisport.it',
    marginCoefficient: 2.2,
    notes: 'Sport et fitness. Grossiste italien de vêtements et de matériel de sport depuis 1985.',
  },

  // --- Bijoux, montres, accessoires, pierres et apprêts ---
  {
    kind: 'distributeur',
    name: 'Cooksongold (bijoux et apprêts)',
    siteUrl: 'https://www.cooksongold.com',
    marginCoefficient: 2.9,
    notes: 'Bijoux et apprêts. Grossiste britannique, métaux précieux, outillage et fournitures de joaillerie.',
  },
  {
    kind: 'distributeur',
    name: 'Kernowcraft (apprêts pour créateurs)',
    siteUrl: 'https://www.kernowcraft.com',
    marginCoefficient: 2.9,
    notes: 'Bijoux et apprêts. Fournitures pour créateurs, perles, métaux et outillage, ventes en gros.',
  },
  {
    kind: 'distributeur',
    name: 'Fire Mountain Gems (apprêts pour créateurs)',
    siteUrl: 'https://www.firemountaingems.com',
    marginCoefficient: 2.8,
    notes: 'Bijoux et apprêts. Grossiste américain de perles et de fournitures de bijouterie fantaisie.',
  },
  {
    kind: 'fournisseur',
    name: '8Seasons (apprêts pour créateurs)',
    siteUrl: 'https://www.8seasons.com',
    marginCoefficient: 3.0,
    notes: "Bijoux et apprêts. Grossiste asiatique d'apprêts et de bijoux inox, petits prix et gros volumes.",
  },

  // --- Emballage, packaging et fournitures d'expédition ---
  {
    kind: 'distributeur',
    name: 'RAJA (emballage)',
    siteUrl: 'https://www.raja.fr',
    marginCoefficient: 1.9,
    notes: "Emballage et expédition. Distributeur européen, cartons, calage et fournitures d'expédition.",
  },
  {
    kind: 'distributeur',
    name: 'Manutan (emballage et équipement)',
    siteUrl: 'https://www.manutan.fr',
    marginCoefficient: 1.8,
    notes: 'Emballage et équipement. Fournitures de bureau, emballage et manutention pour professionnels.',
  },
  {
    kind: 'distributeur',
    name: 'Bruneau (emballage et bureau)',
    siteUrl: 'https://www.bruneau.fr',
    marginCoefficient: 1.8,
    notes: 'Emballage et fournitures. Distributeur français, emballage, papier et consommables de bureau.',
  },

  // --- Destockage, lots, liquidation et dépôt-vente ---
  {
    kind: 'distributeur',
    name: 'Merkandi (destockage)',
    siteUrl: 'https://merkandi.fr',
    marginCoefficient: 2.6,
    notes: 'Destockage et lots. Place de marché B2B de lots, surplus et fins de séries européens.',
  },
  {
    kind: 'distributeur',
    name: 'DestockPlus (destockage)',
    siteUrl: 'https://www.destockplus.com',
    marginCoefficient: 2.6,
    notes: 'Destockage et liquidation. Grossiste français, lots et fins de stock pour revendeurs.',
  },
  {
    kind: 'distributeur',
    name: 'B-Stock (liquidation)',
    siteUrl: 'https://www.bstock.com',
    marginCoefficient: 2.4,
    notes: 'Destockage et liquidation. Place de marché de lots issus de retours et de surstocks.',
  },
  {
    kind: 'distributeur',
    name: 'Troostwijk Auctions (liquidation)',
    siteUrl: 'https://www.troostwijkauctions.com',
    marginCoefficient: 2.4,
    notes: 'Destockage et liquidation. Ventes aux enchères industrielles et lots de matériel en Europe.',
  },
  {
    kind: 'distributeur',
    name: 'Gem Wholesale (lots et liquidation)',
    siteUrl: 'https://www.gemwholesale.co.uk',
    marginCoefficient: 2.6,
    notes: 'Destockage et lots. Grossiste britannique de retours clients et de palettes de déstockage.',
  },

  // --- Papeterie et fournitures scolaires ---
  {
    kind: 'distributeur',
    name: 'Exacompta (papeterie)',
    siteUrl: 'https://www.exacompta.com',
    marginCoefficient: 2.0,
    notes: 'Papeterie et fournitures scolaires. Fabricant français, classement, agendas et papeterie.',
  },
  {
    kind: 'distributeur',
    name: 'Clairefontaine (papeterie)',
    siteUrl: 'https://www.clairefontaine.com',
    marginCoefficient: 2.0,
    notes: 'Papeterie et fournitures scolaires. Papetier français, cahiers et loisirs créatifs, réseau pro.',
  },

  // --- Animalerie ---
  {
    kind: 'distributeur',
    name: 'TRIXIE (animalerie)',
    siteUrl: 'https://www.trixie.de',
    marginCoefficient: 2.3,
    notes: 'Animalerie. Grossiste allemand, accessoires et soins pour animaux, réseau de revendeurs.',
  },
  {
    kind: 'distributeur',
    name: 'Ferplast (animalerie)',
    siteUrl: 'https://www.ferplast.com',
    marginCoefficient: 2.3,
    notes: 'Animalerie. Fabricant italien de cages, paniers et accessoires, vente aux distributeurs.',
  },
  {
    kind: 'distributeur',
    name: 'Zolux (animalerie)',
    siteUrl: 'https://www.zolux.com',
    marginCoefficient: 2.3,
    notes: 'Animalerie. Grossiste français, accessoires et hygiène pour animaux de compagnie.',
  },

  // --- Bricolage, jardin et outillage ---
  {
    kind: 'distributeur',
    name: 'Descours & Cabaud (bricolage et outillage)',
    siteUrl: 'https://www.descours-cabaud.com',
    marginCoefficient: 1.9,
    notes: 'Bricolage et outillage. Distributeur français pour les professionnels, quincaillerie et EPI.',
  },
  {
    kind: 'distributeur',
    name: 'Legallais (quincaillerie et outillage)',
    siteUrl: 'https://www.legallais.com',
    marginCoefficient: 1.9,
    notes: 'Bricolage et outillage. Quincaillerie professionnelle, agencement, visserie et outillage.',
  },
  {
    kind: 'distributeur',
    name: 'Hoffmann Group (outillage)',
    siteUrl: 'https://www.hoffmann-group.com',
    marginCoefficient: 1.8,
    notes: "Bricolage et outillage. Grossiste européen d'outillage de qualité pour les professionnels.",
  },
  {
    kind: 'distributeur',
    name: 'Prolians (bricolage et matériaux)',
    siteUrl: 'https://www.prolians.fr',
    marginCoefficient: 1.9,
    notes: 'Bricolage et jardin. Distributeur français de matériaux, outillage et fournitures de chantier.',
  },

  // --- Auto et moto (accessoires) ---
  {
    kind: 'distributeur',
    name: 'Autodistribution (auto)',
    siteUrl: 'https://www.autodistribution.fr',
    marginCoefficient: 1.9,
    notes: 'Auto et moto. Réseau français de distribution de pièces détachées pour professionnels.',
  },
  {
    kind: 'distributeur',
    name: 'Hartje (vélo, moto et auto)',
    siteUrl: 'https://hartje.de',
    marginCoefficient: 1.9,
    notes: 'Auto et moto. Grossiste allemand, pièces et accessoires vélo, moto et automobile.',
  },

  // --- Sourcing asiatique complémentaire ---
  {
    kind: 'fournisseur',
    name: 'Chinagoods (sourcing)',
    siteUrl: 'https://www.chinagoods.com',
    marginCoefficient: 2.6,
    notes: 'Sourcing généraliste. Plateforme officielle du marché de Yiwu, petits articles, jouets et accessoires.',
  },
  {
    kind: 'fournisseur',
    name: 'LightInTheBox (sourcing)',
    siteUrl: 'https://www.lightinthebox.com',
    marginCoefficient: 2.2,
    notes: "Sourcing généraliste. Grossiste asiatique, petits lots et dropshipping vers l'Europe.",
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
