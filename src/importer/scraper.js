import * as cheerio from 'cheerio';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const SOURCE_SITE_PATTERNS = [
  { key: 'alibaba', match: /alibaba\.com/i },
  { key: 'aliexpress', match: /aliexpress\.com/i },
];

/**
 * Délai maximal accordé à la page fournisseur. Sans lui, une page qui ne répond
 * jamais laissait la requête Express suspendue jusqu'à ce que la plateforme la
 * tue — un socket ouvert par import, indéfiniment.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Taille maximale du corps accepté. Une fiche produit tient largement dans
 * quelques centaines de Ko ; au-delà, c'est probablement une archive ou une
 * réponse vidéo, et `await response.text()` chargerait tout en mémoire au
 * risque de faire tomber le process.
 */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Hôtes manifestement internes, refusés avant même toute résolution DNS. */
const INTERNAL_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.home.arpa'];

/**
 * Résolution DNS par défaut. Elle est isolée derrière l'option `lookupHost`
 * pour que les tests puissent injecter une adresse publique sans toucher au
 * réseau : la protection SSRF doit rester vérifiable hors ligne.
 */
async function defaultLookup(hostname) {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function parseIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return bytes;
}

/** Développe une adresse IPv6 (forme compressée `::`, IPv4 intégrée) en 16 octets. */
function ipv6ToBytes(address) {
  let value = address.toLowerCase();
  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex); // identifiant de zone (fe80::1%eth0)

  if (value.includes('.')) {
    const colonIndex = value.lastIndexOf(':');
    const dotted = parseIpv4(value.slice(colonIndex + 1));
    if (!dotted) return null;
    const high = ((dotted[0] << 8) | dotted[1]).toString(16);
    const low = ((dotted[2] << 8) | dotted[3]).toString(16);
    value = `${value.slice(0, colonIndex)}:${high}:${low}`;
  }

  let groups;
  if (value.includes('::')) {
    const [head, tail] = value.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...new Array(missing).fill('0'), ...tailGroups];
  } else {
    groups = value.split(':');
  }
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const number = parseInt(group, 16);
    bytes.push((number >> 8) & 0xff, number & 0xff);
  }
  return bytes;
}

function isPrivateIpv4(bytes) {
  const [a, b] = bytes;
  return (
    a === 0 || // 0.0.0.0/8 « ce réseau »
    a === 10 || // 10.0.0.0/8
    (a === 100 && (b & 0xc0) === 64) || // 100.64.0.0/10 (CGNAT)
    a === 127 || // 127.0.0.0/8 boucle locale
    (a === 169 && b === 254) || // 169.254.0.0/16 lien-local, dont 169.254.169.254 (métadonnées cloud)
    (a === 172 && (b & 0xf0) === 16) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a & 0xf0) === 224 || // 224.0.0.0/4 multicast
    (a & 0xf0) === 240 // 240.0.0.0/4 réservé + diffusion
  );
}

/**
 * Vrai si l'adresse ne doit jamais être joignable par un import : boucle locale,
 * lien-local, privée, unique-local ou multicast, en IPv4 comme en IPv6. Une
 * adresse illisible est refusée par prudence (échec en fermé).
 */
function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIpv4(address);
    return bytes ? isPrivateIpv4(bytes) : true;
  }
  if (family !== 6) return true;

  const bytes = ipv6ToBytes(address);
  if (!bytes) return true;

  // ::ffff:a.b.c.d (IPv4 mappée) : on applique les règles IPv4 à la partie encapsulée.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(bytes.slice(12));
  }
  // ::/96 : adresse non spécifiée, boucle locale ::1, et IPv4-compatible (dépréciée).
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return true;

  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) !== 0) return true; // fe80::/10 lien-local + fec0::/10 site-local (déprécié)
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast

  return false;
}

function internalAddressError(hostname, address) {
  const target = address ? `« ${hostname} » pointe vers l'adresse interne ${address}` : `« ${hostname} » est une adresse interne`;
  return new Error(`URL refusée : ${target}. Les adresses internes (boucle locale, privées, lien-local, multicast) sont interdites pour éviter une requête forgée depuis le serveur.`);
}

/**
 * Barrière SSRF : l'URL vient de l'utilisateur, elle ne doit donc pas pouvoir
 * viser la boucle locale, le réseau privé de l'hôte ou le service de métadonnées
 * cloud (169.254.169.254). On résout le nom et on refuse si *une* des adresses
 * retournées est interne — un domaine public pointant vers du privé est rejeté
 * au même titre qu'une IP littérale.
 *
 * `lookupHost` est injecté (voir `defaultLookup`) pour garder les tests hors ligne.
 *
 * Limites assumées : la vérification porte sur l'URL demandée, pas sur les cibles
 * de redirection (fetch suit les 3xx), et le DNS est résolu deux fois (ici puis
 * par fetch), ce qui laisse une fenêtre de « DNS rebinding » entre les deux. Une
 * protection complète exigerait de re-valider chaque saut de redirection et de
 * forcer fetch à utiliser l'IP déjà validée, au prix d'une complexité
 * disproportionnée pour un outil d'import interne.
 */
async function assertHostIsPublic(parsedUrl, lookupHost) {
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(
      "URL refusée : identifiants intégrés (http://utilisateur:motdepasse@hôte) interdits à l'import.",
    );
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname) {
    throw new Error("URL invalide : nom d'hôte manquant.");
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`URL refusée : « ${hostname} » désigne la boucle locale de ce serveur.`);
  }
  if (hostname === 'internal' || hostname === 'local' || INTERNAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error(`URL refusée : « ${hostname} » est un nom d'hôte interne.`);
  }

  // Une IP littérale n'a pas besoin de DNS — et la refuser ici évite qu'un
  // résolveur complaisant ne contourne la vérification.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw internalAddressError(hostname, null);
    return;
  }

  let addresses;
  try {
    addresses = await lookupHost(hostname);
  } catch (error) {
    throw new Error(`Impossible de résoudre le domaine « ${hostname} » : ${error?.message ?? error}.`);
  }
  const resolved = (addresses || []).filter(Boolean);
  if (!resolved.length) {
    throw new Error(`Impossible de résoudre le domaine « ${hostname} » (aucune adresse retournée).`);
  }
  for (const address of resolved) {
    if (isPrivateAddress(address)) throw internalAddressError(hostname, address);
  }
}

/**
 * Lit le corps en s'arrêtant net au-delà de `limitBytes`.
 * `Content-Length` est vérifié d'abord (cas courant : on évite même d'ouvrir le
 * flux), puis la lecture réelle est plafonnée — un serveur peut mentir sur
 * l'en-tête ou répondre en `chunked` sans longueur annoncée.
 */
async function readBodyWithLimit(response, limitBytes) {
  const tooLarge = () =>
    new Error(
      `Page trop volumineuse (plus de ${Math.round(limitBytes / (1024 * 1024))} Mo) : ce n'est pas une fiche produit. Réduis la page ou remplis la fiche manuellement.`,
    );

  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) throw tooLarge();

  if (!response.body || typeof response.body.getReader !== 'function') {
    // Réponse sans flux lisible (cas de repli) : on lit tout puis on vérifie.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limitBytes) throw tooLarge();
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}



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
export async function scrapeProductFromUrl(url, { lookupHost = defaultLookup, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('URL invalide (doit commencer par http:// ou https://).');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('URL invalide : seuls les schémas http:// et https:// sont autorisés.');
  }
  await assertHostIsPublic(parsedUrl, lookupHost);

  const sourceSite = detectSourceSite(url);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
      // Un site qui ne répond jamais ne doit pas retenir la requête Express.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(
        `Délai dépassé (${Math.round(timeoutMs / 1000)} s) : la page fournisseur n'a pas répondu. Le site est trop lent ou bloque les requêtes automatisées — réessaie ou remplis la fiche manuellement.`,
      );
    }
    throw new Error(`Impossible de récupérer la page : ${error?.message ?? error}`);
  }
  if (!response.ok) {
    throw new Error(
      `Impossible de récupérer la page (HTTP ${response.status}). Le site bloque peut-être les requêtes automatisées.`,
    );
  }

  const html = await readBodyWithLimit(response, maxBytes);
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
