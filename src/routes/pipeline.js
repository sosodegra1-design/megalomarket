import { Router } from 'express';
import { connectors } from '../connectors/index.js';
import { config } from '../config/env.js';
import { dbAll, dbRun, logActivity } from '../db/database.js';
import { writeListing } from '../ai/copywriter.js';
import { inspectImages } from '../ai/visionInspector.js';
import { editorialCheck, categorize } from '../ai/qualityInspector.js';
import { computeSellPrice, computeNetMargin, MIN_MARGIN_COEFFICIENT } from '../services/pricing.js';
import { cheapestCarrier } from '../services/shipping.js';

/*
 * Chaîne autonome Dénicheur -> Rédacteur -> Tarification/Logistique ->
 * Inspecteur qualité -> Publication.
 *
 * L'entrée du Dénicheur (Agent 1) reste manuelle ici : src/ai/nicheHunter.js
 * ne récupère aucune vraie fiche fournisseur (pas d'URL, pas de coût réel —
 * voir l'avertissement dans ce fichier), donc le titre/coût/images fournis
 * en entrée viennent forcément d'ailleurs (une piste du Dénicheur complétée
 * à la main, ou un import). Ce que cette route automatise réellement, c'est
 * la suite : prix de vente (x3 minimum), transporteur le moins cher, marge
 * nette, rédaction, contrôle qualité, décision publier/brouillon.
 *
 * Le prix de vente n'est JAMAIS saisi à la main ici : il est calculé depuis
 * le coût d'achat (src/services/pricing.js), pour que la règle « toujours x3
 * minimum » soit une garantie de calcul, pas une case qu'on pourrait oublier
 * de cocher.
 *
 * Publication AUTONOME assumée (demande explicite) : si TOUS les contrôles
 * passent (tarification/logistique, images, éditorial, catégorisation), le
 * produit part en ligne sans clic humain. Un seul contrôle en échec bascule
 * tout en brouillon avec un rapport détaillé — jamais de publication
 * partielle ni de contrôle « réputé passé » faute d'avoir pu s'exécuter.
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
    throw new Error("Connecteur site propre non configuré — impossible d'exécuter la chaîne (OWN_SITE_API_URL + OWN_SITE_API_KEY).");
  }
  return connector;
}

function siteBaseUrl() {
  return config.ownSite.apiUrl ? String(config.ownSite.apiUrl).replace(/\/+$/, '') : null;
}

async function saveRun({
  status, title, sourceUrl, imageUrls, purchasePrice, sellPrice, shippingCarrier, shippingCost, netMargin,
  category, seoTitle, description, report, publishedProductId, publishedUrl,
}) {
  const info = await dbRun(
    `INSERT INTO pipeline_runs
       (title, source_url, image_urls, purchase_price, sell_price, shipping_carrier, shipping_cost, net_margin,
        category, seo_title, description, status, report, published_product_id, published_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title, sourceUrl || null, JSON.stringify(imageUrls || []),
      Number.isFinite(purchasePrice) ? purchasePrice : null,
      Number.isFinite(sellPrice) ? sellPrice : null,
      shippingCarrier || null,
      Number.isFinite(shippingCost) ? shippingCost : null,
      Number.isFinite(netMargin) ? netMargin : null,
      category || null, seoTitle || null, description || null, status, JSON.stringify(report),
      publishedProductId || null, publishedUrl || null, Date.now(),
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
      throw new Error('Le coût d\'achat fournisseur est obligatoire (le prix de vente est calculé automatiquement à partir de lui).');
    }

    const imageUrls = Array.isArray(body.images) ? body.images.filter((u) => typeof u === 'string' && u.trim()) : [];
    const sourceUrl = typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : null;
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    const maxShippingDays = body.maxShippingDays != null && body.maxShippingDays !== ''
      ? Number(body.maxShippingDays) : null;

    const connector = requireOwnSite();
    const taxonomy = await connector.getTaxonomy();
    const report = { steps: [] };

    // --- Agent Tarification & logistique : prix x3 minimum + transporteur le moins cher ---
    const sellPrice = computeSellPrice(purchasePrice);
    const carrier = await cheapestCarrier({ maxDays: maxShippingDays });
    const shippingCost = carrier ? carrier.shippingCost : null;
    const netMargin = carrier ? computeNetMargin({ sellPrice, purchasePrice, shippingCost }) : null;
    // Échoue si aucun transporteur éligible (rien à comparer) OU si la marge
    // nette après livraison tombe à zéro ou en dessous — le x3 brut sur le
    // prix de vente ne suffit pas si les frais de port mangent toute la marge.
    const pricingOk = Boolean(carrier) && netMargin != null && netMargin > 0;
    report.steps.push({
      agent: 'tarification_logistique',
      label: 'Tarification & logistique',
      ok: pricingOk,
      detail: {
        purchasePrice,
        sellPrice,
        minCoefficient: MIN_MARGIN_COEFFICIENT,
        carrier: carrier ? carrier.name : null,
        shippingCost,
        shippingDays: carrier ? carrier.shippingDays : null,
        netMargin,
        reason: carrier ? null : 'Aucun transporteur actif avec un coût de livraison renseigné ne respecte le délai demandé.',
      },
    });

    if (!pricingOk) {
      const id = await saveRun({
        status: 'brouillon', title, sourceUrl, imageUrls, purchasePrice, sellPrice,
        shippingCarrier: carrier?.name, shippingCost, netMargin, report,
      });
      await logActivity('PIPELINE_BROUILLON', `Pipeline autonome : "${title}" en brouillon — tarification/logistique non validée.`);
      return res.status(201).json({ id, status: 'brouillon', report, listing: null });
    }

    // --- Agent 2 : rédaction ---
    let listing;
    try {
      listing = await writeListing({ title, price: sellPrice, notes });
      report.steps.push({ agent: 'redacteur', label: 'Rédaction (titre SEO, accroche, puces, CTA)', ok: true });
    } catch (error) {
      report.steps.push({ agent: 'redacteur', label: 'Rédaction (titre SEO, accroche, puces, CTA)', ok: false, error: error.message });
      const id = await saveRun({
        status: 'brouillon', title, sourceUrl, imageUrls, purchasePrice, sellPrice,
        shippingCarrier: carrier?.name, shippingCost, netMargin, report,
      });
      await logActivity('PIPELINE_BROUILLON', `Pipeline autonome : "${title}" en brouillon — échec Agent 2 (rédaction).`);
      return res.status(201).json({ id, status: 'brouillon', report, listing: null });
    }

    // --- Agent 3a : contrôle des images ---
    const imageVerdict = await inspectImages({ title: listing.seoTitle, imageUrls });
    report.steps.push({ agent: 'inspecteur_images', label: 'Contrôle visuel des images', ok: imageVerdict.overallOk, detail: imageVerdict });

    // --- Agent 3b : contrôle éditorial ---
    const editorial = await editorialCheck({ title: listing.seoTitle, description: listing.description });
    report.steps.push({ agent: 'inspecteur_editorial', label: 'Contrôle éditorial', ok: editorial.ok, detail: editorial });

    // --- Agent 3c : catégorisation ---
    const cat = await categorize({ title: listing.seoTitle, description: listing.description }, taxonomy);
    const catOk = Boolean(cat.category && cat.iconKey && cat.confident);
    report.steps.push({ agent: 'categorisation', label: 'Catégorisation', ok: catOk, detail: cat });

    const allOk = imageVerdict.overallOk && editorial.ok && catOk;

    if (!allOk) {
      const id = await saveRun({
        status: 'brouillon', title, sourceUrl, imageUrls, purchasePrice, sellPrice,
        shippingCarrier: carrier?.name, shippingCost, netMargin,
        category: cat.category, seoTitle: listing.seoTitle, description: listing.description, report,
      });
      await logActivity('PIPELINE_BROUILLON', `Pipeline autonome : "${listing.seoTitle}" en brouillon — contrôle qualité non validé.`);
      return res.status(201).json({ id, status: 'brouillon', report, listing });
    }

    // --- Publication autonome : tous les contrôles ont passé ---
    const payload = {
      name: listing.seoTitle,
      name_en: listing.seoTitle,
      description: listing.description,
      description_en: '',
      category: cat.category,
      universe: cat.universe,
      age: 'all',
      ageLabel: 'Tous âges',
      ageLabel_en: 'All ages',
      iconKey: cat.iconKey,
      price: sellPrice,
      images: imageUrls,
    };
    const created = await connector.createListing(payload);
    const base = siteBaseUrl();
    const url = base && created?.offerId ? `${base}/${cat.category}.html?product=${encodeURIComponent(created.offerId)}` : null;

    const id = await saveRun({
      status: 'publie', title, sourceUrl, imageUrls, purchasePrice, sellPrice,
      shippingCarrier: carrier?.name, shippingCost, netMargin,
      category: cat.category, seoTitle: listing.seoTitle, description: listing.description, report,
      publishedProductId: created?.offerId, publishedUrl: url,
    });
    await logActivity('PIPELINE_AUTO_PUBLIE', `Pipeline autonome : "${listing.seoTitle}" publié automatiquement (${created?.offerId}), marge nette ${netMargin} €.`);
    res.status(201).json({ id, status: 'publie', report, listing, product: created, url });
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
      publishedProductId: r.published_product_id,
      publishedUrl: r.published_url,
      createdAt: r.created_at,
    })));
  }),
);
