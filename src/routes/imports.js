import { Router } from 'express';
import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';
import { scrapeProductFromUrl, detectSourceSite } from '../importer/scraper.js';
import { readProductPageWithAgent } from '../importer/aiReader.js';
import { generateListingsForImport, validateSitePayload } from '../importer/listingGenerator.js';
import { publishListing, unpublishListing } from '../importer/publisher.js';
import { connectors } from '../connectors/index.js';
import { computePriceFromSupplier } from '../importer/pricing.js';
import { loadCurrencyRates } from '../db/currency-catalogue.js';
import { config } from '../config/env.js';
import { withResolvedMargin } from './suppliers.js';
import { inspectImages } from '../ai/visionInspector.js';

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

/*
 * Nettoyage groupé : imports CASSÉS (au moins une fiche en échec de
 * publication) ou EN ATTENTE (jamais sortis du brouillon — extraction faite,
 * fiches jamais générées ou génération interrompue). Les deux statuts sont
 * ceux du schéma réel (imports.status, import_listings.status), rien
 * d'inventé. Un import qui porte, par ailleurs, une fiche 'publie' est
 * toujours épargné — même garde-fou que la suppression individuelle : la
 * supprimer ferait perdre le seul lien pour la dépublier depuis ce tableau.
 *
 * Placées avant /:id pour qu'Express ne confonde jamais le segment littéral
 * « cleanup » avec le paramètre :id.
 */
async function findCleanupCandidates() {
  const [brokenLinks, pendingImports, publishedLinks] = await Promise.all([
    dbAll("SELECT DISTINCT import_id AS id FROM import_listings WHERE status = 'echec'"),
    dbAll("SELECT id, title, status FROM imports WHERE status = 'brouillon'"),
    dbAll("SELECT DISTINCT import_id AS id FROM import_listings WHERE status = 'publie'"),
  ]);
  const publishedIds = new Set(publishedLinks.map((r) => r.id));
  const brokenImports = brokenLinks.length
    ? await dbAll(
      `SELECT id, title, status FROM imports WHERE id IN (${brokenLinks.map(() => '?').join(',')})`,
      brokenLinks.map((r) => r.id),
    )
    : [];
  const merged = new Map();
  for (const imp of [...brokenImports, ...pendingImports]) {
    if (!publishedIds.has(imp.id)) merged.set(imp.id, imp);
  }
  return [...merged.values()];
}

importsRouter.get(
  '/cleanup/preview',
  asyncRoute(async (req, res) => {
    res.json({ imports: await findCleanupCandidates() });
  }),
);

importsRouter.delete(
  '/cleanup',
  asyncRoute(async (req, res) => {
    const candidates = await findCleanupCandidates();
    for (const imp of candidates) {
      await dbRun('DELETE FROM import_listings WHERE import_id = ?', [imp.id]);
      await dbRun('DELETE FROM imports WHERE id = ?', [imp.id]);
    }
    if (candidates.length) {
      await logActivity(
        'IMPORT_NETTOYAGE',
        `Nettoyage groupé : ${candidates.length} import(s) cassé(s) ou en attente supprimé(s).`,
      );
    }
    res.json({ deleted: candidates.length, titles: candidates.map((i) => i.title) });
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

    /* Deux voies d'extraction, dans cet ordre :
       1. le scraping (rapide, gratuit, exact — c'est la source de vérité quand
          il aboutit) ;
       2. si et seulement s'il échoue, la lecture de la page par l'agent web
          Perplexity (voir importer/aiReader.js).
       Cette seconde voie existe parce qu'Alibaba refuse les six couches de
       scraping : insister davantage sur le scraping ne débloque rien, alors
       qu'un agent qui ouvre réellement la page passe. Le résultat est marqué
       comme lu par IA (`extractionMethod`) pour que l'interface avertisse au
       lieu de faire passer les deux cas pour identiques. */
    let data;
    let extractionMethod = 'scrape';
    try {
      data = await scrapeProductFromUrl(url);
    } catch (scrapeError) {
      // Sans clé configurée, inutile de tenter : on remonte l'échec du scraping,
      // dont le message détaille déjà toutes les tentatives.
      if (!config.perplexity.ready) throw scrapeError;
      try {
        data = await readProductPageWithAgent({ url });
        extractionMethod = 'agent';
      } catch (agentError) {
        /* Les deux voies ont échoué : on garde le message du scraping — c'est
           lui qui décrit précisément ce que le site a répondu — et on y ajoute
           la raison de l'échec de l'agent, pour que l'utilisateur sache que les
           deux ont été tentées et pourquoi la saisie manuelle est la suite. */
        throw new Error(
          `${scrapeError.message} Lecture de la page par un agent web tentée ensuite : ${agentError.message}`,
        );
      }
    }
    // Filet de sécurité : le scraper limite déjà son propre scan générique,
    // mais une fiche avec beaucoup de vraies variantes structurées (JSON-LD)
    // pourrait théoriquement dépasser la limite que /:id PATCH impose plus
    // tard (MAX_IMAGES). On tronque ici pour ne jamais enregistrer un import
    // que la suite du flux ne pourrait plus modifier sans d'abord retirer des
    // photos à la main.
    const imageUrls = data.imageUrls.slice(0, MAX_IMAGES);
    const info = await dbRun(
      `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id, extraction_method, extraction_notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'brouillon', ?, ?, ?, ?)`,
      [
        url,
        data.sourceSite,
        data.title,
        data.rawDescription,
        data.purchasePrice,
        data.currency,
        JSON.stringify(imageUrls),
        resolvedSupplierId,
        extractionMethod,
        data.agentNotes || null,
        Date.now(),
      ],
    );
    const supplier = resolvedSupplierId == null
      ? null
      : withResolvedMargin(await dbGet('SELECT * FROM suppliers WHERE id = ?', [resolvedSupplierId]));
    await logActivity(
      'IMPORT_CREE',
      extractionMethod === 'agent'
        // Traçable dans le journal d'activité : une fiche lue par un agent n'a
        // pas la même valeur de preuve qu'une fiche scrapée, l'historique doit
        // le dire au lieu de les confondre.
        ? `Produit importé depuis ${data.sourceSite} (page lue par un agent web, à vérifier) : ${data.title}${supplier ? ` (partenaire : ${supplier.name})` : ''}`
        : `Produit importé depuis ${data.sourceSite} : ${data.title}${supplier ? ` (partenaire : ${supplier.name})` : ''}`,
    );
    res.status(201).json({ id: info.lastInsertRowid, ...data, imageUrls, supplier, extractionMethod });
  }),
);

/*
 * Création MANUELLE d'un import, sans aucune extraction — la garantie honnête.
 *
 * Le tableau de bord promettait « remplis la fiche manuellement » alors que
 * l'unique route de création (POST /api/imports) exigeait de scraper d'abord :
 * sur un site qui bloque, l'utilisateur n'avait donc AUCUN moyen de créer
 * l'import, et la promesse était un mensonge. Ici la page fournisseur n'est
 * jamais visitée : aucun réseau, donc aucun blocage possible et aucun risque
 * SSRF à couvrir. Le prix d'achat et la devise sont validés avec EXACTEMENT la
 * même rigueur que PATCH /:id — 0 reste refusé, car c'est le symptôme d'une
 * extraction manquée et les canaux rejettent une fiche à 0 €.
 *
 * À partir de là, le flux est identique à un import scrapé : GET /:id puis
 * POST /:id/generate. L'IA n'a jamais eu besoin du scrape, seulement d'un titre
 * et d'un prix.
 */
importsRouter.post(
  '/manual',
  asyncRoute(async (req, res) => {
    const { url, title, purchasePrice, currency, rawDescription, imageUrls, supplierId } = req.body || {};

    // Titre : chaîne non vide (mêmes règles que PATCH /:id).
    if (typeof title !== 'string' || !title.trim()) {
      throw new Error('Titre invalide : une chaîne non vide est attendue (c\'est la donnée indispensable avec le prix).');
    }
    // Prix strictement supérieur à 0, jamais une chaîne numérique : 0 est le
    // symptôme à corriger, pas une valeur acceptable.
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      throw new Error(
        "Prix d'achat invalide : il doit être un nombre strictement supérieur à 0 (0 € signale une extraction manquée).",
      );
    }
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
      throw new Error('Devise invalide : un code de 3 lettres est attendu (ex. EUR, USD).');
    }
    if (rawDescription !== undefined && rawDescription !== null && typeof rawDescription !== 'string') {
      throw new Error('Description brute invalide : une chaîne est attendue.');
    }
    if (imageUrls !== undefined && imageUrls !== null && !Array.isArray(imageUrls)) {
      throw new Error("imageUrls doit être un tableau d'URLs.");
    }

    // L'URL est FACULTATIVE. Quand elle est fournie, on la valide comme à
    // l'extraction (http/https, rien d'autre) mais on ne la visite pas : elle
    // sert uniquement de référence pour retrouver la fiche plus tard. Aucune
    // requête réseau n'est émise par cette route, donc aucune barrière SSRF à
    // franchir — on n'enregistre qu'une chaîne.
    let sourceUrl = '';
    let sourceSite = 'manuel';
    if (url !== undefined && url !== null && String(url).trim()) {
      const candidate = String(url).trim();
      let parsedUrl;
      try {
        parsedUrl = new URL(candidate);
      } catch {
        throw new Error('URL invalide (doit commencer par http:// ou https://).');
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('URL invalide : seuls les schémas http:// et https:// sont autorisés.');
      }
      sourceUrl = candidate;
      // Même étiquette que l'extraction (« alibaba », « autre »…) pour que la
      // table des imports reste cohérente quel que soit le mode de création.
      sourceSite = detectSourceSite(candidate);
    }

    // Partenaire validé AVANT l'écriture : un import rattaché à un identifiant
    // fantôme afficherait « aucun partenaire » tout en prétendant le contraire.
    const resolvedSupplierId = await resolveSupplierId(supplierId);
    const images = imageUrls ? parseImageUrls(imageUrls) : [];

    const info = await dbRun(
      `INSERT INTO imports (source_url, source_site, title, raw_description, purchase_price, currency, image_urls, status, supplier_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'brouillon', ?, ?)`,
      [
        sourceUrl,
        sourceSite,
        title.trim(),
        (rawDescription || '').trim(),
        purchasePrice,
        currency.trim().toUpperCase(),
        JSON.stringify(images),
        resolvedSupplierId,
        Date.now(),
      ],
    );
    const supplier = resolvedSupplierId == null
      ? null
      : withResolvedMargin(await dbGet('SELECT * FROM suppliers WHERE id = ?', [resolvedSupplierId]));
    await logActivity(
      'IMPORT_CREE',
      `Produit saisi à la main : ${title.trim()}${supplier ? ` (partenaire : ${supplier.name})` : ''}`,
    );

    // Même forme que POST /api/imports : le tableau de bord traite les deux
    // origines sans distinction. `strategy: 'manuel'` dit d'où vient la donnée.
    res.status(201).json({
      id: info.lastInsertRowid,
      sourceUrl,
      sourceSite,
      title: title.trim(),
      rawDescription: (rawDescription || '').trim(),
      purchasePrice,
      currency: currency.trim().toUpperCase(),
      imageUrls: images,
      supplier,
      strategy: 'manuel',
    });
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

/*
 * Contrôle visuel IA des photos de CET import, sur demande explicite (jamais
 * automatique ni bloquant pour la publication) — voir src/ai/visionInspector.js.
 *
 * Root cause du bug signalé en production (photo d'un câble USB au milieu de
 * la galerie d'un blender) : le scraper (importer/scraper.js) fait un scan
 * générique de la page fournisseur, qui peut ramasser une image d'un widget
 * "produits associés" sur la même page. Avant ce correctif, la seule
 * protection était humaine — repérer l'intrus dans une grille de vignettes de
 * 84×84px, jusqu'à 30 photos — et l'agent de contrôle visuel qui existait déjà
 * dans le code (inspectImages) n'était câblé que sur le pipeline Dénicheur
 * (routes/pipeline.js), jamais sur ce flux d'import par URL fournisseur.
 */
importsRouter.post(
  '/:id/inspect-images',
  asyncRoute(async (req, res) => {
    const imp = await dbGet('SELECT title, image_urls FROM imports WHERE id = ?', [req.params.id]);
    if (!imp) throw new Error('Import introuvable.');
    const imageUrls = JSON.parse(imp.image_urls || '[]');
    res.json(await inspectImages({ title: imp.title, imageUrls }));
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
    const { purchasePrice, currency, title, rawDescription, imageUrls, lotQuantity, lotFees } = req.body || {};

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

    /* Quantité du lot et frais totaux (transport + douane) : les deux
       ingrédients du coût rendu. Les frais se connaissent par LOT — un envoi de
       500 pièces coûte un forfait — donc on stocke le forfait et la quantité, et
       c'est le moteur de prix qui divise. Stocker directement un « coût
       unitaire » obligerait à refaire la division à chaque correction de
       quantité, et les deux valeurs finiraient par diverger. */
    if (lotQuantity !== undefined) {
      if (!Number.isInteger(lotQuantity) || lotQuantity < 1) {
        throw new Error('Quantité du lot invalide : un entier supérieur ou égal à 1 est attendu.');
      }
      fields.push('lot_quantity = ?');
      values.push(lotQuantity);
    }

    if (lotFees !== undefined) {
      if (!Number.isFinite(lotFees) || lotFees < 0) {
        throw new Error('Frais du lot invalides : un nombre positif ou nul est attendu (transport et douane du lot entier).');
      }
      fields.push('lot_fees = ?');
      values.push(lotFees);
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
  const imp = await dbGet(
    'SELECT purchase_price, currency, lot_quantity, lot_fees, supplier_id FROM imports WHERE id = ?',
    [importId],
  );
  if (!imp || imp.supplier_id == null) return result;

  const supplier = await dbGet('SELECT margin_coefficient FROM suppliers WHERE id = ?', [imp.supplier_id]);
  // NULL = « utiliser le défaut global » : le générateur a déjà calculé le bon
  // prix, et le réécrire avec la même valeur ne ferait que brouiller l'affichage.
  if (!supplier || supplier.margin_coefficient == null) return result;

  /* Même chaîne que le générateur : coût rendu (devise convertie + transport
     réparti), PUIS coefficient du partenaire. Appliquer le coefficient au prix
     fournisseur brut, comme avant, aurait ignoré la conversion et le fret — donc
     donné deux prix différents pour la même fiche selon le chemin emprunté. */
  const rates = await loadCurrencyRates();
  const { suggestedPrice: price } = computePriceFromSupplier({
    purchasePrice: imp.purchase_price,
    currency: imp.currency,
    lotQuantity: imp.lot_quantity,
    lotFees: imp.lot_fees,
    rates,
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
