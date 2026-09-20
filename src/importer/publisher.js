import { dbGet, dbRun, logActivity } from '../db/database.js';
import { connectors } from '../connectors/index.js';

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
    const result = await connector.createListing({
      sku: `IMP-${imp.id}-${listing.marketplace}`.toUpperCase(),
      title: listing.title,
      description: listing.description,
      imageUrls: JSON.parse(imp.image_urls || '[]'),
      price: listing.suggested_price,
      quantity: 1,
    });

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
