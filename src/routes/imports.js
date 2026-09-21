import { Router } from 'express';
import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';
import { scrapeProductFromUrl } from '../importer/scraper.js';
import { generateListingsForImport, validateSitePayload } from '../importer/listingGenerator.js';
import { publishListing } from '../importer/publisher.js';
import { connectors } from '../connectors/index.js';

export const importsRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

// --- Liste des imports ---
importsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json(await dbAll('SELECT * FROM imports ORDER BY created_at DESC LIMIT 100'));
  }),
);

// --- Étape 1 : extraction depuis une URL fournisseur ---
importsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { url } = req.body || {};
    const data = await scrapeProductFromUrl(url);
    const info = await dbRun(
      `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'brouillon', ?)`,
      [
        url,
        data.sourceSite,
        data.title,
        data.rawDescription,
        data.purchasePrice,
        data.currency,
        JSON.stringify(data.imageUrls),
        Date.now(),
      ],
    );
    await logActivity('IMPORT_CREE', `Produit importé depuis ${data.sourceSite} : ${data.title}`);
    res.status(201).json({ id: info.lastInsertRowid, ...data });
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
  return { ...imp, imageUrls: JSON.parse(imp.image_urls || '[]'), listings };
}

// --- Détail d'un import + ses fiches par marketplace ---
importsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json(await readImportDetail(req.params.id));
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
    const { purchasePrice, currency, title, rawDescription } = req.body || {};

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

    // Aucun champ exploitable : on refuse plutôt que de répondre « ok » sur une
    // requête qui n'a rien changé (même règle que la fiche d'une marketplace).
    if (!fields.length) throw new Error('Aucune modification fournie.');

    await dbRun(`UPDATE imports SET ${fields.join(', ')} WHERE id = ?`, [...values, req.params.id]);
    res.json(await readImportDetail(req.params.id));
  }),
);

// --- Étape 2 : génération IA des fiches par marketplace + prix conseillé ---
importsRouter.post(
  '/:id/generate',
  asyncRoute(async (req, res) => {
    res.json(await generateListingsForImport(Number(req.params.id)));
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
