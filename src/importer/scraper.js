import * as cheerio from 'cheerio';

const SOURCE_SITE_PATTERNS = [
  { key: 'alibaba', match: /alibaba\.com/i },
  { key: 'aliexpress', match: /aliexpress\.com/i },
];

function detectSourceSite(url) {
  const found = SOURCE_SITE_PATTERNS.find((p) => p.match.test(url));
  return found ? found.key : 'autre';
}

function resolveUrl(src, baseUrl) {
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Cherche un noeud JSON-LD de type Product dans la page (schema.org), présent sur la plupart des fiches e-commerce. */
function parseJsonLdProduct($) {
  let product = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return; // bloc JSON-LD invalide sur cette page, on continue avec les autres
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const candidate of candidates) {
      const nodes = candidate['@graph'] ? candidate['@graph'] : [candidate];
      for (const node of nodes) {
        const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        if (types.includes('Product')) product = node;
      }
    }
  });
  return product;
}

function extractPrice(jsonLdProduct, $) {
  const offer = Array.isArray(jsonLdProduct?.offers) ? jsonLdProduct.offers[0] : jsonLdProduct?.offers;
  if (offer?.price) return { price: Number(offer.price), currency: offer.priceCurrency || 'USD' };
  if (offer?.lowPrice) return { price: Number(offer.lowPrice), currency: offer.priceCurrency || 'USD' };

  const metaPrice = $('meta[property="product:price:amount"]').attr('content');
  const metaCurrency = $('meta[property="product:price:currency"]').attr('content');
  if (metaPrice) return { price: Number(metaPrice), currency: metaCurrency || 'USD' };

  return { price: 0, currency: 'USD' };
}

function extractImages($, baseUrl, jsonLdProduct) {
  const urls = new Set();

  const jsonLdImages = Array.isArray(jsonLdProduct?.image) ? jsonLdProduct.image : [jsonLdProduct?.image].filter(Boolean);
  for (const img of jsonLdImages) {
    const resolved = resolveUrl(img, baseUrl);
    if (resolved) urls.add(resolved);
  }

  $('meta[property="og:image"]').each((_, el) => {
    const resolved = resolveUrl($(el).attr('content'), baseUrl);
    if (resolved) urls.add(resolved);
  });

  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src || /\.(svg|gif)(\?|$)/i.test(src)) return;
    const resolved = resolveUrl(src, baseUrl);
    if (resolved) urls.add(resolved);
  });

  return [...urls];
}

/**
 * Extrait titre, description, prix d'achat et photos depuis la page produit d'un fournisseur.
 * S'appuie d'abord sur les données structurées (JSON-LD schema.org) puis sur les méta-tags Open
 * Graph, avec repli sur le HTML brut. Des sites comme Alibaba/AliExpress bloquent activement les
 * requêtes automatisées ou chargent le contenu en JavaScript : dans ce cas l'extraction peut
 * échouer ou être incomplète — c'est signalé par une erreur claire plutôt qu'un résultat vide.
 */
export async function scrapeProductFromUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('URL invalide (doit commencer par http:// ou https://).');
  }
  const sourceSite = detectSourceSite(url);

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(
      `Impossible de récupérer la page (HTTP ${response.status}). Le site bloque peut-être les requêtes automatisées.`,
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const jsonLdProduct = parseJsonLdProduct($);

  const title =
    jsonLdProduct?.name ||
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    $('title').text().trim();

  const rawDescription =
    jsonLdProduct?.description ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';

  const { price, currency } = extractPrice(jsonLdProduct, $);
  const imageUrls = extractImages($, url, jsonLdProduct);

  if (!title) {
    throw new Error(
      `Aucune information exploitable extraite de cette page (${sourceSite}). Le site bloque probablement les requêtes automatisées (contenu chargé en JavaScript) — remplis la fiche manuellement pour ce produit.`,
    );
  }

  return {
    sourceSite,
    title: title.trim(),
    rawDescription: rawDescription.trim(),
    purchasePrice: price,
    currency,
    imageUrls,
  };
}
