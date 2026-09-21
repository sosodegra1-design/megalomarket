import { dbGet, dbRun, logActivity } from '../db/database.js';
import { connectors } from '../connectors/index.js';

/**
 * Construit le payload attendu par le connecteur du canal visé.
 *
 * Les marketplaces se contentent d'un titre, d'une description, d'un prix et
 * d'images — c'est ce que le module d'import produit et stocke. Le site propre
 * est nettement plus exigeant : il lui faut catégorie, univers, âge, clé
 * d'icône et libellés bilingues, qui n'ont pas d'équivalent côté marketplace.
 * Ces champs vivent donc dans import_listings.site_payload, et leur absence est
 * signalée explicitement plutôt que de publier une fiche incomplète que le site
 * refuserait avec un message obscur.
 */
function buildPublishPayload(listing, imp) {
  const images = JSON.parse(imp.image_urls || '[]');

  if (listing.marketplace === 'own_site') {
    if (!listing.site_payload) {
      throw new Error(
        "Publication sur le site propre impossible : aucune fiche détaillée n'a été préparée. " +
        "Le site exige une catégorie, un univers, un âge, une clé d'icône et des libellés bilingues. " +
        "Renseigne-les via PATCH /api/imports/:id/listings/own_site { sitePayload: {...} }.",
      );
    }

    let site;
    try {
      site = JSON.parse(listing.site_payload);
    } catch {
      throw new Error('site_payload illisible (JSON invalide) — corrige la fiche avant de publier.');
    }

    // Le prix et les textes de référence restent ceux de la fiche validée.
    return {
      ...site,
      name: site.name || listing.title,
      description: site.description || listing.description,
      price: listing.suggested_price,
      images: site.images || images,
      sourceUrl: site.sourceUrl || imp.source_url,
    };
  }

  return {
    sku: `IMP-${imp.id}-${listing.marketplace}`.toUpperCase(),
    title: listing.title,
    description: listing.description,
    imageUrls: images,
    price: listing.suggested_price,
    quantity: 1,
  };
}

/** Publie une fiche produit validée sur sa marketplace cible via le connecteur correspondant. */
export async function publishListing(importListingId) {
  const listing = await dbGet('SELECT * FROM import_listings WHERE id = ?', [importListingId]);
  if (!listing) throw new Error(`Fiche produit introuvable (id=${importListingId}).`);

  const imp = await dbGet('SELECT * FROM imports WHERE id = ?', [listing.import_id]);
  const connector = connectors[listing.marketplace];
  if (!connector?.createListing) {
    throw new Error(`Publication non supportée pour le canal "${listing.marketplace}".`);
  }

  try {
    const result = await connector.createListing(buildPublishPayload(listing, imp));

    await dbRun(
      "UPDATE import_listings SET status = 'publie', published_external_id = ?, publish_error = NULL, updated_at = ? WHERE id = ?",
      [result?.offerId || result?.listingId || null, Date.now(), importListingId],
    );
    await logActivity('IMPORT_PUBLIE', `Fiche "${listing.title}" publiée sur ${listing.marketplace}.`);
    return { ok: true, ...result };
  } catch (error) {
    await dbRun(
      "UPDATE import_listings SET status = 'echec', publish_error = ?, updated_at = ? WHERE id = ?",
      [error.message, Date.now(), importListingId],
    );
    throw error;
  }
}
