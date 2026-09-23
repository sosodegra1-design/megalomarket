import { Router } from 'express';
import { connectors } from '../connectors/index.js';
import { dbAll, dbRun, logActivity } from '../db/database.js';
import { writeListing } from '../ai/copywriter.js';
import { inspectImages } from '../ai/visionInspector.js';
import { editorialCheck, categorize } from '../ai/qualityInspector.js';
import { computeSellPrice, computeNetMargin, MIN_MARGIN_COEFFICIENT } from '../services/pricing.js';
import { cheapestCarrier } from '../services/shipping.js';
import { cheapestSendcloudMethod, listSendcloudMethods, isSendcloudConfigured } from '../services/sendcloud.js';
import { processProductImages, isImageStudioConfigured } from '../services/imageStudio.js';

/*
 * Chaîne de PRÉPARATION Dénicheur -> Rédacteur -> Tarification/logistique
 * (suggestion) -> Inspecteur qualité.
 *
 * Ne publie JAMAIS automatiquement (revirement explicite de l'utilisateur
 * par rapport à la version précédente de ce fichier) : chaque exécution se
 * termine TOUJOURS en statut « brouillon en attente de validation humaine »,
 * quel que soit le résultat des contrôles. Le coût d'achat réel, les photos
 * définitives, le prix final et le clic de publication restent une décision
 * humaine — cette route prépare un dossier complet (texte rédigé, prix et
 * transporteur SUGGÉRÉS, contrôles qualité), jamais plus.
 *
 * L'entrée du Dénicheur (Agent 1) reste manuelle ici : src/ai/nicheHunter.js
 * ne récupère aucune vraie fiche fournisseur (pas d'URL, pas de coût réel —
 * voir l'avertissement dans ce fichier), donc le titre/coût/images fournis
 * en entrée viennent forcément d'ailleurs (une piste du Dénicheur complétée
 * à la main, ou un import).
 */

export const pipelineRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

function requireOwnSite() {
  const connector = connectors.own_site;
  if (!connector?.isConfigured?.()) {
    throw new Error("Connecteur site propre non configuré — impossible de valider la catégorisation contre la taxonomie réelle (OWN_SITE_API_URL + OWN_SITE_API_KEY).");
  }
  return connector;
}

async function saveRun({
  title, sourceUrl, imageUrls, purchasePrice, sellPrice, shippingCarrier, shippingCost, netMargin,
  category, seoTitle, description, report,
}) {
  const info = await dbRun(
    `INSERT INTO pipeline_runs
       (title, source_url, image_urls, purchase_price, sell_price, shipping_carrier, shipping_cost, net_margin,
        category, seo_title, description, status, report, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon', ?, ?)`,
    [
      title, sourceUrl || null, JSON.stringify(imageUrls || []),
      Number.isFinite(purchasePrice) ? purchasePrice : null,
      Number.isFinite(sellPrice) ? sellPrice : null,
      shippingCarrier || null,
      Number.isFinite(shippingCost) ? shippingCost : null,
      Number.isFinite(netMargin) ? netMargin : null,
      category || null, seoTitle || null, description || null, JSON.stringify(report), Date.now(),
    ],
  );
  return info.lastInsertRowid;
}

pipelineRouter.post(
  '/run',
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) throw new Error('Le titre du produit est obligatoire.');

    const purchasePrice = Number(body.purchasePrice);
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      throw new Error('Le coût d\'achat fournisseur est obligatoire (sert à suggérer un prix de vente, que tu ajustes ensuite toi-même).');
    }

    const imageUrls = Array.isArray(body.images) ? body.images.filter((u) => typeof u === 'string' && u.trim()) : [];
    const sourceUrl = typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : null;
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    const maxShippingDays = body.maxShippingDays != null && body.maxShippingDays !== ''
      ? Number(body.maxShippingDays) : null;
    // Le poids ne sert QUE si Sendcloud est configuré (ses tarifs dépendent de
    // tranches de poids réelles) — la comparaison manuelle de shipping.js n'en
    // a jamais eu besoin, donc rien ne casse si ce champ est absent.
    const weightKg = body.weightKg != null && body.weightKg !== '' ? Number(body.weightKg) : null;
    const shippingCountry = typeof body.shippingCountry === 'string' && body.shippingCountry.trim()
      ? body.shippingCountry.trim().toUpperCase() : 'FR';

    const connector = requireOwnSite();
    const taxonomy = await connector.getTaxonomy();
    const report = { steps: [] };

    // --- Agent 2 (studio photo) : détourage + fond uniformisé sur Cloudinary ---
    // Les images utilisées PAR LA SUITE (contrôle visuel, brouillon proposé à
    // la reprise) sont celles-ci si le traitement réussit — jamais les brutes
    // en même temps que les traitées, pour ne jamais laisser deux versions
    // incohérentes coexister dans le même brouillon.
    let processedImages = imageUrls;
    if (imageUrls.length && isImageStudioConfigured()) {
      const results = await processProductImages(imageUrls);
      processedImages = results.map((r) => r.studioUrl);
      const allOk = results.every((r) => r.ok);
      report.steps.push({
        agent: 'studio_photo',
        label: 'Studio photo (détourage & fond uniforme)',
        ok: allOk,
        detail: { images: results },
      });
    } else if (imageUrls.length) {
      report.steps.push({
        agent: 'studio_photo',
        label: 'Studio photo (détourage & fond uniforme)',
        ok: false,
        error: "Cloudinary non configuré (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET) — photos utilisées telles quelles, sans traitement.",
      });
    }

    // --- Tarification & logistique : prix x3 minimum SUGGÉRÉ + transporteur le moins cher SUGGÉRÉ ---
    // Purement informatif désormais : rien ici ne bloque ni n'autorise quoi que
    // ce soit, puisque plus rien ne se publie automatiquement.
    //
    // Sendcloud (vrais tarifs) est essayé EN PREMIER quand il est configuré
    // ET qu'un poids a été renseigné (ses tarifs dépendent de tranches de
    // poids réelles). Une panne Sendcloud (clé invalide, réponse
    // inattendue…) ne bloque jamais le reste : elle retombe sur la
    // comparaison manuelle de l'onglet Transporteurs, avec l'erreur Sendcloud
    // conservée dans le rapport pour être corrigée plutôt que masquée.
    const sellPrice = computeSellPrice(purchasePrice);
    let carrier = null;
    let shippingSource = null;
    let sendcloudError = null;

    if (isSendcloudConfigured() && weightKg != null) {
      try {
        const method = await cheapestSendcloudMethod({ toCountry: shippingCountry, weightKg });
        if (method) {
          carrier = {
            name: method.carrier ? `${method.name} (${method.carrier})` : method.name,
            shippingCost: method.price,
            shippingDays: null,
          };
          shippingSource = 'sendcloud';
        }
      } catch (error) {
        sendcloudError = error.message;
      }
    }
    if (!carrier) {
      carrier = await cheapestCarrier({ maxDays: maxShippingDays });
      if (carrier) shippingSource = 'manuel';
    }

    const shippingCost = carrier ? carrier.shippingCost : null;
    const netMargin = carrier ? computeNetMargin({ sellPrice, purchasePrice, shippingCost }) : null;
    const pricingOk = Boolean(carrier) && netMargin != null && netMargin > 0;
    report.steps.push({
      agent: 'tarification_logistique',
      label: 'Tarification & logistique (suggestion)',
      ok: pricingOk,
      detail: {
        purchasePrice,
        sellPrice,
        minCoefficient: MIN_MARGIN_COEFFICIENT,
        carrier: carrier ? carrier.name : null,
        shippingCost,
        shippingDays: carrier ? carrier.shippingDays : null,
        shippingSource,
        sendcloudError,
        netMargin,
        reason: carrier
          ? null
          : (weightKg == null && isSendcloudConfigured()
            ? 'Renseigne un poids pour obtenir un vrai tarif Sendcloud, ou ajoute un transporteur avec coût dans l\'onglet Transporteurs.'
            : 'Aucun transporteur actif avec un coût de livraison renseigné ne respecte le délai demandé.'),
      },
    });

    // --- Agent 2 : rédaction ---
    let listing = null;
    try {
      listing = await writeListing({ title, price: sellPrice, notes });
      report.steps.push({ agent: 'redacteur', label: 'Rédaction (titre SEO, accroche, puces, CTA)', ok: true });
    } catch (error) {
      report.steps.push({ agent: 'redacteur', label: 'Rédaction (titre SEO, accroche, puces, CTA)', ok: false, error: error.message });
    }

    let category = null;
    // Les contrôles qualité ont besoin d'un texte à vérifier : sans rédaction
    // réussie, il n'y a rien de fiable à analyser — on le dit plutôt que de
    // deviner sur le titre brut.
    if (listing) {
      const imageVerdict = await inspectImages({ title: listing.seoTitle, imageUrls: processedImages });
      report.steps.push({ agent: 'inspecteur_images', label: 'Contrôle visuel des images', ok: imageVerdict.overallOk, detail: imageVerdict });

      const editorial = await editorialCheck({ title: listing.seoTitle, description: listing.description });
      report.steps.push({ agent: 'inspecteur_editorial', label: 'Contrôle éditorial', ok: editorial.ok, detail: editorial });

      const cat = await categorize({ title: listing.seoTitle, description: listing.description }, taxonomy);
      const catOk = Boolean(cat.category && cat.iconKey && cat.confident);
      report.steps.push({ agent: 'categorisation', label: 'Catégorisation', ok: catOk, detail: cat });
      if (catOk) category = cat.category;
    } else {
      report.steps.push({ agent: 'inspecteur_images', label: 'Contrôle visuel des images', ok: false, error: 'Ignoré : pas de fiche rédigée à vérifier.' });
      report.steps.push({ agent: 'inspecteur_editorial', label: 'Contrôle éditorial', ok: false, error: 'Ignoré : pas de fiche rédigée à vérifier.' });
      report.steps.push({ agent: 'categorisation', label: 'Catégorisation', ok: false, error: 'Ignoré : pas de fiche rédigée à catégoriser.' });
    }

    const id = await saveRun({
      title, sourceUrl, imageUrls: processedImages, purchasePrice, sellPrice,
      shippingCarrier: carrier?.name, shippingCost, netMargin,
      category, seoTitle: listing?.seoTitle, description: listing?.description, report,
    });
    await logActivity('PIPELINE_BROUILLON', `Pipeline : "${listing?.seoTitle || title}" préparé en brouillon — validation humaine requise avant toute publication.`);
    res.status(201).json({ id, status: 'brouillon', report, listing });
  }),
);

pipelineRouter.get(
  '/sendcloud/methods',
  asyncRoute(async (req, res) => {
    if (!isSendcloudConfigured()) {
      throw new Error('Sendcloud non configuré (SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY manquantes).');
    }
    const toCountry = typeof req.query.toCountry === 'string' && req.query.toCountry.trim()
      ? req.query.toCountry.trim().toUpperCase() : 'FR';
    const fromCountry = typeof req.query.fromCountry === 'string' && req.query.fromCountry.trim()
      ? req.query.fromCountry.trim().toUpperCase() : 'FR';
    const weightKg = req.query.weightKg != null && req.query.weightKg !== '' ? Number(req.query.weightKg) : null;
    const methods = await listSendcloudMethods({ toCountry, fromCountry, weightKg });
    res.json({ toCountry, fromCountry, weightKg, methods });
  }),
);

pipelineRouter.get(
  '/runs',
  asyncRoute(async (req, res) => {
    const rows = await dbAll('SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT 100');
    res.json(rows.map((r) => ({
      id: r.id,
      title: r.title,
      sourceUrl: r.source_url,
      images: JSON.parse(r.image_urls || '[]'),
      purchasePrice: r.purchase_price,
      sellPrice: r.sell_price,
      shippingCarrier: r.shipping_carrier,
      shippingCost: r.shipping_cost,
      netMargin: r.net_margin,
      category: r.category,
      seoTitle: r.seo_title,
      description: r.description,
      status: r.status,
      report: JSON.parse(r.report || '{}'),
      createdAt: r.created_at,
    })));
  }),
);
