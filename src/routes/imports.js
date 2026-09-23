import { Router } from 'express';
import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';
import { scrapeProductFromUrl } from '../importer/scraper.js';
import { generateListingsForImport, validateSitePayload } from '../importer/listingGenerator.js';
import { publishListing, unpublishListing } from '../importer/publisher.js';
import { connectors } from '../connectors/index.js';
import { computeSuggestedPrice } from '../importer/pricing.js';
import { config } from '../config/env.js';
import { withResolvedMargin } from './suppliers.js';

export const importsRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

const MAX_IMAGES = 30;

/* Valide et nettoie la liste de photos envoyée par le tableau de bord (ajout
   manuel ou retrait d'une photo extraite) avant de l'enregistrer — une URL
   mal formée ne doit jamais atteindre buildPublishPayload plus tard. */
function parseImageUrls(value) {
  if (!Array.isArray(value)) throw new Error('imageUrls doit être un tableau d\'URLs.');
  if (value.length > MAX_IMAGES) throw new Error(`imageUrls : ${MAX_IMAGES} photos maximum.`);
  return value.map((url, i) => {
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error(`imageUrls[${i}] invalide : une URL non vide est attendue.`);
    }
    const trimmed = url.trim();
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`imageUrls[${i}] invalide : « ${trimmed.slice(0, 80)} » n'est pas une URL lisible.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`imageUrls[${i}] invalide : seuls http et https sont acceptés.`);
    }
    return trimmed;
  });
}

/*
 * `supplierId` vient d'un <select> du tableau de bord : on accepte le nombre ou
 * son écriture décimale (« 3 »), mais jamais un partenaire inexistant. Un
 * import rattaché à un identifiant fantôme afficherait « aucun partenaire »
 * tout en prétendant le contraire, et sa marge ne serait jamais appliquée.
 */
async function resolveSupplierId(value) {
  if (value === undefined || value === null || value === '') return null;

  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Partenaire invalide : supplierId doit être l'identifiant d'un fournisseur, distributeur ou transporteur enregistré.");
  }

  const supplier = await dbGet('SELECT id FROM suppliers WHERE id = ?', [id]);
  if (!supplier) {
    throw new Error(`Partenaire introuvable (id=${id}) : enregistre-le dans l'onglet Fournisseurs avant de l'associer à un import.`);
  }
  return id;
}

// --- Liste des imports ---
importsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    // Le partenaire est joint ici (et non rechargé ligne par ligne) pour que la
    // table des imports puisse dire d'où vient chaque extraction sans N+1.
    res.json(await dbAll(
      `SELECT i.*, s.name AS supplier_name, s.kind AS supplier_kind
       FROM imports i
       LEFT JOIN suppliers s ON s.id = i.supplier_id
       ORDER BY i.created_at DESC LIMIT 100`,
    ));
  }),
);

// --- Étape 1 : extraction depuis une URL fournisseur ---
importsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { url, supplierId } = req.body || {};
    // Validé AVANT l'extraction : inutile de scraper une page si le partenaire
    // choisi n'existe pas — l'erreur doit tomber tout de suite.
    const resolvedSupplierId = await resolveSupplierId(supplierId);
    const data = await scrapeProductFromUrl(url);
    // Filet de sécurité : le scraper limite déjà son propre scan générique,
    // mais une fiche avec beaucoup de vraies variantes structurées (JSON-LD)
    // pourrait théoriquement dépasser la limite que /:id PATCH impose plus
    // tard (MAX_IMAGES). On tronque ici pour ne jamais enregistrer un import
    // que la suite du flux ne pourrait plus modifier sans d'abord retirer des
    // photos à la main.
    const imageUrls = data.imageUrls.slice(0, MAX_IMAGES);
    const info = await dbRun(
      `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'brouillon', ?, ?)`,
      [
        url,
        data.sourceSite,
        data.title,
        data.rawDescription,
        data.purchasePrice,
        data.currency,
        JSON.stringify(imageUrls),
        resolvedSupplierId,
        Date.now(),
      ],
    );
    const supplier = resolvedSupplierId == null
      ? null
      : withResolvedMargin(await dbGet('SELECT * FROM suppliers WHERE id = ?', [resolvedSupplierId]));
    await logActivity(
      'IMPORT_CREE',
      `Produit importé depuis ${data.sourceSite} : ${data.title}${supplier ? ` (partenaire : ${supplier.name})` : ''}`,
    );
    res.status(201).json({ id: info.lastInsertRowid, ...data, imageUrls, supplier });
  }),
);

/* Détail d'un import : la ligne, ses images parsées et ses fiches par canal.
   Partagé par GET et PATCH pour que les deux répondent EXACTEMENT la même
   forme — le tableau de bord les traite sans distinction. */
async function readImportDetail(id) {
  const imp = await dbGet('SELECT * FROM imports WHERE id = ?', [id]);
  if (!imp) throw new Error('Import introuvable.');
  const listings = await dbAll(
    'SELECT * FROM import_listings WHERE import_id = ? ORDER BY marketplace',
    [id],
  );
  // Le partenaire est renvoyé avec sa marge résolue : le tableau de bord peut
  // dire quel partenaire est à l'origine de l'import ET quelle marge a servi.
  const supplier = imp.supplier_id == null
    ? null
    : withResolvedMargin(await dbGet('SELECT * FROM suppliers WHERE id = ?', [imp.supplier_id]));
  return { ...imp, imageUrls: JSON.parse(imp.image_urls || '[]'), listings, supplier };
}

// --- Détail d'un import + ses fiches par marketplace ---
importsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json(await readImportDetail(req.params.id));
  }),
);

// --- Suppression d'un import et de ses fiches (nettoyage d'un import raté) ---
/* Ne retire RIEN d'un canal : ceci n'efface que la fiche de travail locale
   (imports + import_listings), jamais un article déjà en ligne. Un article
   publié via ce module se gère ensuite indépendamment (ex. le catalogue du
   site propre, géré depuis Canaux, avec sa propre suppression).

   Un import dont une fiche est encore au statut « publie » est refusé par
   défaut : le supprimer ferait perdre published_external_id, le seul moyen
   dont dispose cette route pour dépublier plus tard. `force=true` passe
   outre en connaissance de cause — l'article reste en ligne, seule la trace
   locale disparaît. */
importsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const imp = await dbGet('SELECT id, title FROM imports WHERE id = ?', [req.params.id]);
    if (!imp) throw new Error('Import introuvable.');

    const force = req.query.force === 'true' || req.body?.force === true;
    if (!force) {
      const published = await dbAll(
        "SELECT marketplace FROM import_listings WHERE import_id = ? AND status = 'publie'",
        [req.params.id],
      );
      if (published.length) {
        const channels = published.map((p) => p.marketplace).join(', ');
        throw new Error(
          `Cet import a une fiche publiée sur ${channels} — la supprimer ferait perdre le seul lien pour la dépublier depuis ici. `
          + `Dépublie-la d'abord (bouton « Dépublier »), ou relance la suppression avec ?force=true si l'article publié n'est pas concerné.`,
        );
      }
    }

    // Effacé explicitement plutôt que de s'en remettre uniquement à ON DELETE
    // CASCADE : le client libSQL distant peut exécuter chaque requête sur une
    // connexion différente, où PRAGMA foreign_keys ne serait pas garanti actif.
    await dbRun('DELETE FROM import_listings WHERE import_id = ?', [req.params.id]);
    await dbRun('DELETE FROM imports WHERE id = ?', [req.params.id]);
    await logActivity('IMPORT_SUPPRIME', `Import supprimé : ${imp.title} (id=${imp.id}).`);
    res.json({ ok: true });
  }),
);

// --- Correction d'un import après extraction ---
/* Le scraper ne lit pas toujours le prix d'achat : une page fournisseur sans
   données structurées donne 0, et toutes les fiches générées partent alors à
   0 €. Sans cette route, la donnée source était définitive : l'import restait
   bloqué avec des fiches invendables, sans aucun moyen de le réparer. */
importsRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const { purchasePrice, currency, title, rawDescription, imageUrls } = req.body || {};

    const imp = await dbGet('SELECT id FROM imports WHERE id = ?', [req.params.id]);
    if (!imp) throw new Error('Import introuvable.');

    const fields = [];
    const values = [];

    if (purchasePrice !== undefined) {
      // 0 est refusé volontairement : c'est précisément le symptôme à corriger,
      // pas une valeur acceptable (elle produit des fiches que les canaux
      // rejettent). On exige un vrai nombre, pas une chaîne numérique.
      if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
        throw new Error(
          "Prix d'achat invalide : il doit être un nombre strictement supérieur à 0 (0 € signale une extraction manquée).",
        );
      }
      fields.push('purchase_price = ?');
      values.push(purchasePrice);
    }

    if (currency !== undefined) {
      if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
        throw new Error('Devise invalide : un code de 3 lettres est attendu (ex. EUR, USD).');
      }
      fields.push('currency = ?');
      values.push(currency.trim().toUpperCase());
    }

    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) {
        throw new Error('Titre invalide : une chaîne non vide est attendue.');
      }
      fields.push('title = ?');
      values.push(title.trim());
    }

    if (rawDescription !== undefined) {
      if (typeof rawDescription !== 'string' || !rawDescription.trim()) {
        throw new Error('Description brute invalide : une chaîne non vide est attendue.');
      }
      fields.push('raw_description = ?');
      values.push(rawDescription.trim());
    }

    if (imageUrls !== undefined) {
      fields.push('image_urls = ?');
      values.push(JSON.stringify(parseImageUrls(imageUrls)));
    }

    // Aucun champ exploitable : on refuse plutôt que de répondre « ok » sur une
    // requête qui n'a rien changé (même règle que la fiche d'une marketplace).
    if (!fields.length) throw new Error('Aucune modification fournie.');

    await dbRun(`UPDATE imports SET ${fields.join(', ')} WHERE id = ?`, [...values, req.params.id]);
    res.json(await readImportDetail(req.params.id));
  }),
);

/*
 * Applique la marge du partenaire au prix conseillé de CET import.
 *
 * C'est tout l'intérêt d'avoir mémorisé le partenaire : la plateforme de gros et
 * le distributeur local ne vendent pas au même prix, donc le coefficient global
 * ne peut pas être le bon pour les deux. Le générateur, lui, ne connaît que le
 * coefficient global (il est partagé et sert aussi hors import) : on réécrit
 * donc ici le prix des fiches qui viennent d'être créées, en repassant par
 * computeSuggestedPrice — seule source de vérité, verrou anti-vente à perte
 * compris. Réécrire APRÈS coup plutôt que de modifier la configuration globale
 * évite qu'une génération concurrente (autre partenaire, autre marge) hérite du
 * coefficient d'une autre requête.
 */
async function applySupplierMargin(importId, result) {
  const imp = await dbGet('SELECT purchase_price, supplier_id FROM imports WHERE id = ?', [importId]);
  if (!imp || imp.supplier_id == null) return result;

  const supplier = await dbGet('SELECT margin_coefficient FROM suppliers WHERE id = ?', [imp.supplier_id]);
  // NULL = « utiliser le défaut global » : le générateur a déjà calculé le bon
  // prix, et le réécrire avec la même valeur ne ferait que brouiller l'affichage.
  if (!supplier || supplier.margin_coefficient == null) return result;

  const price = computeSuggestedPrice(imp.purchase_price, {
    marginCoefficient: supplier.margin_coefficient,
    fixedFee: config.pricing.fixedFee,
  });
  await dbRun(
    'UPDATE import_listings SET suggested_price = ?, updated_at = ? WHERE import_id = ?',
    [price, Date.now(), importId],
  );

  // La réponse de /generate porte les prix calculés : on les aligne pour que
  // l'affichage immédiat ne montre pas le coefficient global.
  const listings = Array.isArray(result?.listings)
    ? result.listings.map((listing) => (
      listing && listing.suggestedPrice !== undefined ? { ...listing, suggestedPrice: price } : listing
    ))
    : result?.listings;
  return { ...result, listings };
}

// --- Étape 2 : génération IA des fiches par marketplace + prix conseillé ---
importsRouter.post(
  '/:id/generate',
  asyncRoute(async (req, res) => {
    const importId = Number(req.params.id);
    const result = await generateListingsForImport(importId);
    res.json(await applySupplierMargin(importId, result));
  }),
);

// --- Option A : récupération/modification manuelle d'une fiche avant publication ---
importsRouter.patch(
  '/:id/listings/:marketplace',
  asyncRoute(async (req, res) => {
    const { title, description, suggestedPrice, sitePayload } = req.body || {};

    const imp = await dbGet('SELECT purchase_price FROM imports WHERE id = ?', [req.params.id]);
    if (!imp) throw new Error('Import introuvable.');

    const fields = [];
    const values = [];
    if (title) {
      fields.push('title = ?');
      values.push(title);
    }
    if (description) {
      fields.push('description = ?');
      values.push(description);
    }
    if (suggestedPrice !== undefined) {
      if (!Number.isFinite(suggestedPrice) || suggestedPrice <= 0) throw new Error('Prix invalide.');
      // Le verrou anti-vente à perte doit valoir aussi sur le chemin de
      // validation humaine : sans cette comparaison, l'option A permettait
      // d'enregistrer un prix sous le prix d'achat, que la publication envoyait
      // ensuite tel quel au canal.
      if (suggestedPrice < imp.purchase_price) {
        throw new Error(
          `Prix refusé : ${suggestedPrice} € est inférieur au prix d'achat (${imp.purchase_price} €). Vente à perte.`,
        );
      }
      fields.push('suggested_price = ?');
      values.push(suggestedPrice);
    }
    if (sitePayload !== undefined) {
      if (sitePayload === null) {
        fields.push('site_payload = ?');
        values.push(null);
      } else {
        if (typeof sitePayload !== 'object' || Array.isArray(sitePayload)) {
          throw new Error('sitePayload doit être un objet JSON.');
        }
        // Validée contre la taxonomie réelle du site quand elle est joignable :
        // une catégorie ou une icône inventée ne doit jamais l'atteindre, car
        // elle sortirait des filtres de la boutique.
        let taxonomy = null;
        const connector = connectors.own_site;
        if (connector?.isConfigured?.() && connector.getTaxonomy) {
          try {
            taxonomy = await connector.getTaxonomy();
          } catch {
            taxonomy = null; // site injoignable : on enregistre sans validation croisée
          }
        }
        const payload = taxonomy ? validateSitePayload(sitePayload, taxonomy) : sitePayload;
        fields.push('site_payload = ?');
        values.push(JSON.stringify(payload));
      }
    }
    if (!fields.length) throw new Error('Aucune modification fournie.');
    fields.push('status = ?', 'updated_at = ?');
    values.push('valide', Date.now(), req.params.id, req.params.marketplace);

    const info = await dbRun(
      `UPDATE import_listings SET ${fields.join(', ')} WHERE import_id = ? AND marketplace = ?`,
      values,
    );
    if (info.changes === 0) throw new Error('Fiche produit introuvable pour ce canal.');
    res.json({ ok: true });
  }),
);

// --- Option B : publication directe sur la marketplace choisie ---
importsRouter.post(
  '/:id/listings/:marketplace/publish',
  asyncRoute(async (req, res) => {
    const listing = await dbGet('SELECT * FROM import_listings WHERE import_id = ? AND marketplace = ?', [
      req.params.id,
      req.params.marketplace,
    ]);
    if (!listing) throw new Error('Fiche produit introuvable pour ce canal — génère les fiches avant de publier.');
    res.json(await publishListing(listing.id));
  }),
);

// --- Retire une fiche déjà publiée (dépublication) ---
importsRouter.delete(
  '/:id/listings/:marketplace/publish',
  asyncRoute(async (req, res) => {
    const listing = await dbGet('SELECT * FROM import_listings WHERE import_id = ? AND marketplace = ?', [
      req.params.id,
      req.params.marketplace,
    ]);
    if (!listing) throw new Error('Fiche produit introuvable pour ce canal.');
    res.json(await unpublishListing(listing.id));
  }),
);
