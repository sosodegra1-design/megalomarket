import * as cheerio from 'cheerio';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Table de reconnaissance des hébergeurs, volontairement ILLUSTRATIVE et non
 * exhaustive : l'import doit fonctionner sur n'importe quelle boutique — un
 * distributeur inconnu est scrapé génériquement, c'est tout l'intérêt. Cette
 * liste ne sert qu'à rendre `sourceSite` lisible (statistiques, débogage) ;
 * elle ne conditionne jamais le fait de pouvoir importer une page.
 *
 * L'ordre compte : `detectSourceSite` retient la première correspondance, les
 * familles les plus spécifiques doivent donc passer avant les plus générales.
 */
const SOURCE_SITE_PATTERNS = [
  // Places de marché / B2B
  { key: 'aliexpress', match: /aliexpress\./i },
  { key: 'alibaba', match: /alibaba\.com/i },
  { key: '1688', match: /1688\.com/i },
  { key: 'made-in-china', match: /made-in-china\.com/i },
  { key: 'globalsources', match: /globalsources\.com/i },
  { key: 'dhgate', match: /dhgate\.com/i },
  { key: 'banggood', match: /banggood\./i },
  { key: 'temu', match: /temu\.com/i },
  { key: 'shein', match: /shein\./i },
  { key: 'taobao', match: /taobao\.com/i },
  { key: 'wish', match: /wish\.com/i },
  { key: 'joom', match: /joom\.com/i },

  // Plateformes de dropshipping / grossistes
  { key: 'bigbuy', match: /bigbuy\./i },
  { key: 'spocket', match: /spocket\.co/i },
  { key: 'syncee', match: /syncee\.com/i },
  { key: 'modalyst', match: /modalyst\.com/i },
  { key: 'faire', match: /faire\.com/i },
  { key: 'ankorstore', match: /ankorstore\.com/i },
  { key: 'orderchamp', match: /orderchamp\.com/i },
  { key: 'printful', match: /printful\.com/i },
  { key: 'printify', match: /printify\.com/i },
  { key: 'gelato', match: /gelato\.com/i },

  // Grande distribution / places de marché où l'on s'approvisionne
  { key: 'amazon', match: /amazon\./i },
  { key: 'ebay', match: /ebay\./i },
  { key: 'walmart', match: /walmart\./i },
  { key: 'etsy', match: /etsy\.com/i },
  { key: 'cdiscount', match: /cdiscount\.com/i },
  { key: 'fnac', match: /fnac\.com/i },
  { key: 'rakuten', match: /rakuten\./i },
  { key: 'bol', match: /bol\.com/i },
  { key: 'zalando', match: /zalando\./i },
  { key: 'otto', match: /otto\.de/i },
  { key: 'kaufland', match: /kaufland\./i },
  { key: 'allegro', match: /allegro\./i },
  { key: 'emag', match: /emag\./i },

  // Plateformes auto-hébergées (boutiques tenues par le marchand lui-même)
  { key: 'shopify', match: /myshopify\.com/i },
  { key: 'woocommerce', match: /wp-json/i },
  { key: 'prestashop', match: /prestashop\.com/i },
  { key: 'bigcommerce', match: /bigcommerce\.com/i },
  { key: 'magento', match: /magento\.com/i },
  { key: 'wix', match: /wix\.com/i },
  { key: 'squarespace', match: /squarespace\.com/i },
  { key: 'shopware', match: /shopware\./i },
  { key: 'ecwid', match: /ecwid\.com/i },
  { key: 'lightspeed', match: /lightspeedhq\./i },
];

/**
 * Délai maximal accordé à la page fournisseur. Sans lui, une page qui ne répond
 * jamais laissait la requête Express suspendue jusqu'à ce que la plateforme la
 * tue — un socket ouvert par import, indéfiniment. Le budget court sur
 * l'ensemble des appels réseau d'un même import (essais d'API puis HTML).
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Taille maximale du corps accepté, là aussi cumulée sur tous les appels de
 * l'import. Une fiche produit tient largement dans quelques centaines de Ko ;
 * au-delà, c'est probablement une archive ou une réponse vidéo, et
 * `await response.text()` chargerait tout en mémoire au risque de faire tomber
 * le process.
 */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Plafond propre aux réponses d'API plateforme. Un JSON produit Shopify ou
 * WooCommerce fait quelques dizaines de Ko ; ce plafond garantit qu'un
 * `products.json` de catalogue entier (ou une page HTML servie à la place) ne
 * consomme pas tout le budget d'octets avant que le repli HTML ne s'exécute.
 */
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Part du délai global réservée au repli HTML générique. Sans cette réserve,
 * une API plateforme qui répond lentement pouvait épuiser le budget et faire
 * échouer l'import alors que la page HTML était, elle, parfaitement lisible.
 */
const MIN_HTML_BUDGET_MS = 3_000;

/**
 * Nombre maximal de redirections suivies. Une page fournisseur peut légitimement
 * renvoyer vers une URL canonique (http→https, sans www, ajout de locale), mais
 * une chaîne plus longue est presque toujours une boucle ou un rebondissement
 * vers une cible inattendue : on refuse plutôt que de laisser l'import dériver.
 */
const MAX_REDIRECTS = 5;

/**
 * Statuts qui signalent un BLOCAGE (et non une erreur d'URL) : eux seuls
 * méritent qu'on réessaie la même page avec une autre identité. Un 404, un 410
 * ou un 500 sont des réponses définitives du site — changer d'agent n'y changera
 * rien, et il faut au contraire les garder visibles pour que l'utilisateur
 * distingue « site qui bloque » de « URL erronée ».
 */
const RETRYABLE_STATUSES = new Set([400, 403, 429, 503]);

/**
 * Profils d'identité essayés l'un après l'autre quand un site bloque.
 *
 * `navigateur` : Chrome desktop, l'identité qui obtient le rendu complet.
 * `mobile`     : Chrome Android. Beaucoup de places de marché servent au
 *                sous-domaine `m.`/à l'agent mobile une version allégée, sans
 *                le mur anti-robot de la version desktop.
 * `googlebot`  : l'agent de Google. Certains sites réservent aux crawlers une
 *                réponse complète (enjeu SEO) au lieu de la page vide servie
 *                aux inconnus.
 *
 * `clientHints` vaut `null` pour Googlebot : un crawler n'annonce pas de
 * Client Hints, les envoyer trahirait l'emprunt d'identité — précisément le
 * genre d'incohérence que cette couche existe pour supprimer.
 */
const BROWSER_PROFILES = {
  navigateur: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    clientHints: { mobile: '?0', platform: '"Windows"' },
    referer: true,
    fetchSite: 'same-origin',
  },
  mobile: {
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    clientHints: { mobile: '?1', platform: '"Android"' },
    referer: true,
    fetchSite: 'same-origin',
  },
  googlebot: {
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    clientHints: null,
    referer: false,
    fetchSite: 'none',
  },
};

const DESKTOP_USER_AGENT = BROWSER_PROFILES.navigateur.userAgent;

/**
 * En-têtes d'une navigation de navigateur réelle.
 *
 * POURQUOI c'est vital : un `fetch` qui n'envoie que `User-Agent` et
 * `Accept-Language` est une EMPREINTE, pas une requête. Les gros sites
 * (Alibaba, AliExpress, Amazon…) ne bloquent pas « le contenu », ils bloquent ce
 * PROFIL : l'absence d'`Accept`, de `Sec-Fetch-*`, de Client Hints et surtout de
 * `Referer` trahit un client automatique mieux que n'importe quel autre signal —
 * d'où les HTTP 400/403 avant même que la page ne soit servie. On envoie donc
 * exactement ce que Chrome envoie pour une navigation, `Referer` compris : il
 * pointe sur l'origine du site lui-même, parce qu'un vrai visiteur arrive en
 * cliquant depuis la page d'accueil, jamais en tapant l'URL produit directement.
 *
 * Les en-têtes sont reconstruits par appel ET par profil (plutôt que figés dans
 * une constante) : `Referer` dépend de l'hôte, et la requête initiale comme
 * chaque redirection doivent porter la MÊME identité — un en-tête qui change en
 * cours de route trahirait le suivi manuel des redirections.
 */
function buildBrowserHeaders(targetUrl, profileName = 'navigateur') {
  const profile = BROWSER_PROFILES[profileName] || BROWSER_PROFILES.navigateur;
  let origin = null;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    origin = null; // URL déjà validée en amont : ce cas n'arrive pas, on reste défensif
  }

  const headers = {
    'User-Agent': profile.userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    // Node décompresse `gzip`, `deflate` et `br` même quand on fixe cet en-tête
    // nous-mêmes : le navigateur annonce donc les trois, sans risque de recevoir
    // un corps binaire illisible.
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': profile.fetchSite,
    'Sec-Fetch-User': '?1',
    Connection: 'keep-alive',
  };
  if (profile.referer && origin) headers.Referer = `${origin}/`;
  if (profile.clientHints) {
    headers['Sec-Ch-Ua'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
    headers['Sec-Ch-Ua-Mobile'] = profile.clientHints.mobile;
    headers['Sec-Ch-Ua-Platform'] = profile.clientHints.platform;
  }
  return headers;
}

/** Hôtes manifestement internes, refusés avant même toute résolution DNS. */
const INTERNAL_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.home.arpa'];

/** Balises dont le contenu est du code, jamais du texte affiché : on les retire avant de « textifier ». */
const NON_TEXT_TAGS = ['script', 'style', 'noscript', 'template'];

/**
 * Balises de bloc et sauts de ligne, remplacés par une espace avant extraction
 * du texte. Sans cela, retirer `<h2>Titre</h2><p>Suite</p>` collerait les mots
 * (« TitreSuite ») : `.text()` de cheerio concatène les noeuds sans séparateur.
 */
const BLOCK_LEVEL_TAGS = /<\/?(?:p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|blockquote|figure|figcaption|hr|dd|dt|dl|pre)\b[^>]*>/gi;

/**
 * Fragments d'URL qui trahissent une vignette décorative plutôt qu'une photo
 * produit — logos, pictogrammes d'interface, ET (ajouté après un import réel
 * dont la galerie s'est retrouvée polluée) les badges de paiement et de
 * confiance qu'on trouve dans le pied de page de presque toutes les
 * boutiques : Visa, Mastercard, Amex, PayPal, Klarna, Afterpay, Apple/Google
 * Pay, Trustpilot, SSL/sécurité… Ces vignettes ne portent jamais « logo » ou
 * « icon » dans leur nom de fichier, d'où leur passage inaperçu jusqu'ici.
 */
const ICON_URL_PATTERN = /(sprite|logo|icon|favicon|placeholder|pixel|spacer|badge|flag|avatar|payment|paiement|visa|mastercard|maestro|amex|american[-_]?express|paypal|klarna|afterpay|affirm|clearpay|apple[-_]?pay|google[-_]?pay|samsung[-_]?pay|sofort|ideal|bancontact|przelewy|giropay|sepa|stripe-badge|trustpilot|trusted|verified|mcafee|norton|secure|ssl|ge-trusted|bbb-|social|facebook|twitter|instagram|pinterest|youtube|tiktok-icon|whatsapp|linkedin|wechat|chevron|arrow-icon|star-rating|rating-star|cart-icon|wishlist-icon|search-icon|hamburger|spinner|loader)/i;

/** Formats qu'on ne veut jamais dans les photos produit (vectoriel ou animé). */
const NON_PHOTO_EXTENSION = /\.(svg|gif)(\?|#|$)/i;

/*
 * Sélecteur des blocs « produits associés » (bug réel : la photo d'un câble
 * USB, vendu par ailleurs sur la même page fournisseur, s'est retrouvée dans
 * la galerie d'un blender importé — ramassée par le scan <img> générique, qui
 * n'excluait jusqu'ici que l'en-tête/pied de page/navigation/barre latérale,
 * jamais un widget de ce type placé dans le contenu principal). Les noms de
 * classe/identifiant varient d'un site à l'autre mais convergent presque
 * toujours vers un de ces mots — liste volontairement large : mieux vaut
 * exclure une vraie photo produit mal nommée (retrait manuel possible, voir
 * le tableau de bord) que republier un article sans rapport par erreur.
 */
const RELATED_PRODUCTS_KEYWORDS = [
  'related-product', 'relatedproduct',
  'you-may-also-like', 'youmayalsolike',
  'also-bought', 'alsobought',
  'frequently-bought', 'frequentlybought',
  'cross-sell', 'crosssell',
  'upsell',
  'recommend',
  'similar-product', 'similarproduct',
];
const RELATED_PRODUCTS_SELECTOR = RELATED_PRODUCTS_KEYWORDS
  .flatMap((word) => [`[class*="${word}" i]`, `[id*="${word}" i]`])
  .join(', ');

/** Nombre maximal de photos remontées par l'extraction générique <img> : une
 * fiche produit correctement scrapée en a rarement plus d'une quinzaine — au-
 * delà, c'est le signe qu'on a aussi ramassé la mise en page (bannières,
 * pied de page, barre latérale). Les images des sources fiables (JSON-LD,
 * Open Graph, microdata) ne sont JAMAIS comptées dans ce plafond : elles sont
 * ajoutées avant le scan générique et priment toujours sur lui. */
const MAX_GENERIC_IMAGES = 16;

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
 * Les redirections ne sont PAS une limite : `fetchFollowingRedirects` repasse
 * chaque `Location` par cette même fonction avant de la suivre.
 *
 * Limite assumée : le DNS est résolu ici puis de nouveau par `fetch` au moment de
 * la connexion, ce qui laisse une fenêtre de « DNS rebinding » entre les deux.
 * La refermer exigerait d'épingler la connexion sur l'IP déjà validée (dispatcher
 * undici personnalisé) ; `undici` n'étant pas exposé par Node (`node:undici`
 * n'existe pas) et n'étant ici qu'une dépendance transitive de cheerio, la
 * complexité n'est pas justifiée pour un outil d'import interne.
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
 *
 * `announcedLimitBytes` sert uniquement au message d'erreur : le long d'une
 * chaîne de redirections, `limitBytes` n'est que le budget restant, et annoncer
 * « plus de 0 Mo » parce qu'il ne reste que quelques octets serait absurde.
 */
async function readBodyWithLimit(response, limitBytes, announcedLimitBytes = limitBytes) {
  const tooLarge = () =>
    new Error(
      `Page trop volumineuse (plus de ${Math.round(announcedLimitBytes / (1024 * 1024))} Mo) : ce n'est pas une fiche produit. Réduis la page ou remplis la fiche manuellement.`,
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

/** Statuts que `fetch` suivrait automatiquement et qu'on doit donc traiter nous-mêmes. */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function timeoutError(timeoutMs) {
  return new Error(
    `Délai dépassé (${Math.round(timeoutMs / 1000)} s) : la page fournisseur n'a pas répondu. Le site est trop lent ou bloque les requêtes automatisées — réessaie ou remplis la fiche manuellement.`,
  );
}

/**
 * Budget partagé par TOUS les appels réseau d'un même import : essais d'API
 * plateforme compris. Les redirections étaient déjà décomptées globalement ;
 * avec l'arrivée des chemins rapides, il fallait que le délai et les octets le
 * soient aussi, sinon un import pouvait multiplier le temps et le volume par le
 * nombre d'API essayées.
 */
function createBudget(timeoutMs, maxBytes) {
  return { deadline: Date.now() + timeoutMs, maxBytes, bytesRead: 0, timeoutMs };
}

/**
 * Récupère une URL en suivant les redirections à la main, en re-validant chaque
 * cible.
 *
 * Pourquoi `redirect: 'manual'` plutôt qu'un `dispatcher` undici personnalisé :
 * Node n'expose pas `undici` comme module intégré (`node:undici` n'existe pas) et
 * le paquet `undici` présent ici n'est qu'une dépendance transitive de cheerio —
 * s'y accrocher serait fragile. La boucle manuelle garde le `fetch` global, donc
 * le point d'injection des tests reste le même et la suite reste hors ligne. La
 * validation d'un saut est exactement celle de l'URL initiale
 * (`assertHostIsPublic`), ce qui ferme le trou laissé par le suivi automatique de
 * `fetch` : un 302 vers 169.254.169.254 ou vers un hôte privé est refusé.
 *
 * Renvoie le corps, l'URL FINALE (après redirections) et le type de contenu :
 * les chemins rapides en ont besoin pour résoudre les images relatives et pour
 * décider si la réponse est bien du JSON, sans second appel réseau.
 *
 * `maxBytes` n'est qu'un plafond local (API) ; le budget global, lui, est
 * décrémenté ici pour chaque saut, y compris les corps de redirection — sans
 * quoi une chaîne de renvois ferait transiter plusieurs fois le plafond.
 */
async function fetchFollowingRedirects(
  startUrl,
  {
    lookupHost,
    budget,
    maxBytes = budget.maxBytes,
    // Identité envoyée à CHAQUE saut. Par défaut une navigation de navigateur
    // desktop ; la montée en identités (voir `buildDirectStrategies`) passe le
    // profil correspondant à la tentative.
    headers,
    // Quand vaut `true`, un statut non-2xx est RENVOYÉ (`ok: false`, `status`)
    // au lieu d'être levé en erreur : c'est ce qui permet à la couche de repli
    // de décider « ce 403 mérite une autre identité » au lieu d'abandonner.
    returnOnHttpError = false,
  },
) {
  let currentUrl = startUrl;
  const requestHeaders = headers || buildBrowserHeaders(startUrl);

  for (let hop = 0; ; hop += 1) {
    if (hop > MAX_REDIRECTS) {
      throw new Error(
        `Trop de redirections (plus de ${MAX_REDIRECTS}) : la page fournisseur renvoie une chaîne de renvois trop longue.`,
      );
    }

    const remainingMs = budget.deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError(budget.timeoutMs);
    const remainingBytes = Math.min(budget.maxBytes - budget.bytesRead, maxBytes);
    if (remainingBytes <= 0) throw new Error('Budget de téléchargement épuisé pour cet import.');

    let response;
    try {
      response = await fetch(currentUrl, {
        headers: requestHeaders,
        // On suit nous-mêmes les 3xx, sinon une redirection vers une adresse
        // interne contournerait la validation faite sur l'URL demandée.
        redirect: 'manual',
        // Un site qui ne répond jamais ne doit pas retenir la requête Express.
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw timeoutError(budget.timeoutMs);
      throw new Error(`Impossible de récupérer la page : ${error?.message ?? error}`);
    }

    if (!isRedirectStatus(response.status)) {
      if (!response.ok) {
        if (!returnOnHttpError) {
          throw new Error(
            `Impossible de récupérer la page (HTTP ${response.status}). Le site bloque peut-être les requêtes automatisées.`,
          );
        }
        // Le corps d'une page de refus ne nous intéresse pas : on le libère
        // sans le charger (une page d'erreur peut peser plusieurs Mo et
        // consommerait le budget d'octets commun à toutes les tentatives).
        try {
          await response.body?.cancel?.();
        } catch {
          /* corps déjà consommé ou absent : sans conséquence */
        }
        return {
          text: '',
          finalUrl: currentUrl,
          contentType: String(response.headers?.get?.('content-type') ?? ''),
          status: response.status,
          ok: false,
        };
      }
      const text = await readBodyWithLimit(response, remainingBytes, maxBytes);
      budget.bytesRead += Buffer.byteLength(text, 'utf8');
      return {
        text,
        finalUrl: currentUrl,
        contentType: String(response.headers?.get?.('content-type') ?? ''),
        status: response.status,
        ok: true,
      };
    }

    // Le corps d'une redirection ne nous intéresse pas, mais il est lu pour
    // libérer la connexion et surtout pour être décompté du budget global : sans
    // cela, une chaîne de 5 redirections pourrait faire transiter 5 fois le
    // plafond avant la réponse finale.
    const drained = await readBodyWithLimit(response, remainingBytes, maxBytes);
    budget.bytesRead += Buffer.byteLength(drained, 'utf8');

    const location = response.headers?.get?.('location');
    if (!location) {
      throw new Error(`Redirection sans destination (HTTP ${response.status}).`);
    }

    let target;
    try {
      // Résolution relative au saut courant : un `Location: /suite` reste sur le
      // même hôte, un `Location: http://…` peut changer de domaine.
      target = new URL(location, currentUrl);
    } catch {
      throw new Error(`URL de redirection invalide : « ${location} ».`);
    }
    // Un saut vers file:, data: ou ftp: contournerait l'allow-list de schémas.
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(
        `URL refusée : la redirection vers le schéma « ${target.protocol} » est interdite (seuls http:// et https:// sont autorisés).`,
      );
    }
    await assertHostIsPublic(target, lookupHost);
    currentUrl = target.toString();
  }
}

/* Exporté pour la création MANUELLE d'un import (routes/imports.js) : elle ne
   scrape rien, mais elle veut la même étiquette lisible (« alibaba », « autre »…)
   que l'extraction, pour que la table des imports reste cohérente. */
export function detectSourceSite(url) {
  const found = SOURCE_SITE_PATTERNS.find((p) => p.match.test(url));
  return found ? found.key : 'autre';
}

function resolveUrl(src, baseUrl) {
  if (!src || typeof src !== 'string') return null;
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Transforme un fragment HTML (description Shopify `body_html`, contenu
 * microdata…) en texte propre : les balises ne doivent jamais finir stockées
 * dans `rawDescription`, et les entités (`&eacute;`, `&amp;`, `&#8364;`…)
 * doivent être décodées une fois pour toutes — c'est ce texte qui alimentera la
 * fiche produit et les annonces.
 */
function htmlToText(html) {
  if (!html) return '';
  const fragment = cheerio.load(`<div id="__dsh_root">${String(html)}</div>`, null, false);
  fragment('#__dsh_root ' + NON_TEXT_TAGS.join(', #__dsh_root ')).remove();
  // Un espace à la place des balises de bloc, PUIS `.text()` : laisser cheerio
  // extraire le texte garantit que les entités sont décodées correctement (un
  // `<` encodé dans le contenu ne doit pas être pris pour une balise).
  fragment('#__dsh_root').html(fragment('#__dsh_root').html().replace(BLOCK_LEVEL_TAGS, ' '));
  return fragment('#__dsh_root').text().replace(/\s+/g, ' ').trim();
}

/** Normalise un texte déjà propre (attribut `content`, description JSON-LD…). */
function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Codes et symboles monétaires reconnus. Volontairement limité aux devises que
 * l'import croise réellement : deviner une devise exotique serait pire que de
 * retomber sur USD, la valeur par défaut historique.
 *
 * Les codes sont encadrés par des frontières explicites (début/fin de chaîne ou
 * caractère non alphabétique) et non par `\b` : sans cela « 12USD » (sans espace)
 * ne serait pas reconnu, et le symbole « € » présent ailleurs donnerait EUR à
 * tort.
 */
const CURRENCY_SYMBOLS = [
  { pattern: /zł|zloty|(?<![a-z])pln(?![a-z])/i, code: 'PLN' },
  { pattern: /€|(?<![a-z])eur(?![a-z])/i, code: 'EUR' },
  { pattern: /£|(?<![a-z])gbp(?![a-z])/i, code: 'GBP' },
  { pattern: /¥|(?<![a-z])jpy(?![a-z])/i, code: 'JPY' },
  { pattern: /\$|(?<![a-z])usd(?![a-z])/i, code: 'USD' },
];

const CURRENCY_CODE_PATTERN = /(?<![a-z])(EUR|USD|GBP|PLN|CNY|RMB|JPY|CHF|CAD|AUD|SEK|NOK|DKK|CZK|HUF|RON|BGN|TRY|INR|BRL|MXN|HKD|SGD|NZD|ZAR)(?![a-z])/i;

/**
 * Devine la devise d'un prix textuel. Le symbole prime sur l'absence de code :
 * « 12,50 € » n'a aucune raison d'être étiqueté USD. Un code explicite (ISO)
 * reste prioritaire sur le symbole, car « 1 234,56 € EUR » ou « CA$12.50 CAD »
 * sont sans ambiguïté. Faute d'indice, on garde USD : c'est la valeur par
 * défaut historique du scraper et la seule qui ne casse pas les tests existants.
 */
function detectCurrencyFromText(text, fallback = 'USD') {
  if (!text) return fallback;
  const code = String(text).match(CURRENCY_CODE_PATTERN);
  if (code) {
    const normalized = code[1].toUpperCase();
    return normalized === 'RMB' ? 'CNY' : normalized;
  }
  for (const { pattern, code } of CURRENCY_SYMBOLS) {
    if (pattern.test(String(text))) return code;
  }
  return fallback;
}

/**
 * Analyse un prix écrit « à la européenne » (`12,50 €`, `1 234,56 €`) comme « à
 * l'américaine » (`$12.50`, `12.50 USD`), espaces insécables compris.
 *
 * La règle de départage est explicite plutôt que devinée :
 * - quand la devise est connue et que le texte contient une virgule décimale
 *   plausible (`12,50`, `1 234,56`), la virgule est le séparateur décimal ;
 * - sinon on applique les conventions usuelles : virgule suivie d'un ou deux
 *   chiffres = décimale, virgule suivie de trois chiffres = séparateur de
 *   milliers (`1,234` vaut alors 1234).
 *
 * Renvoie `null` — jamais `NaN` — quand rien d'exploitable n'est trouvé ; c'est
 * ce `null` qui laisse le prix à 0 et déclenche l'avertissement « prix d'achat
 * manquant » côté route d'import.
 */
function parsePriceValue(rawText, { currencyHint = null } = {}) {
  if (rawText === null || rawText === undefined) return null;
  // Espaces fines insécables, insécables et tabulations : fréquents comme
  // séparateurs de milliers dans les pages françaises et polonaises.
  const text = String(rawText).replace(/[\u00a0\u202f\u2009\u2007\t\u200e\u200f]/g, ' ').trim();
  const match = text.match(/\d[\d\s.,']*\d|\d/);
  if (!match) return null;

  let numeric = match[0].replace(/[\s']/g, '');
  const dotCount = (numeric.match(/\./g) || []).length;
  const commaCount = (numeric.match(/,/g) || []).length;

  if (dotCount && commaCount) {
    // Les deux séparateurs sont présents : le DERNIER est le décimal, l'autre
    // est un séparateur de milliers. `1.234,56` → 1234.56 ; `1,234.56` → 1234.56.
    numeric =
      numeric.lastIndexOf(',') > numeric.lastIndexOf('.')
        ? numeric.replace(/\./g, '').replace(',', '.')
        : numeric.replace(/,/g, '');
  } else if (commaCount) {
    const fraction = numeric.slice(numeric.lastIndexOf(',') + 1);
    // « 1,234 » est ambigu : 1234 (milliers) ou 1.234 (décimale). On tranche selon
    // la devise devinée — le PLN et l'EUR sont des devises à deux décimales, donc
    // trois chiffres après la virgule sont presque toujours un groupe de milliers.
    const thousandsGrouping = fraction.length === 3 && (currencyHint === 'PLN' || currencyHint === 'EUR');
    // Dans tous les autres cas (1-2 décimales, ou un seul chiffre), la virgule est
    // le séparateur décimal : c'est la convention de toutes les pages européennes.
    numeric = thousandsGrouping ? numeric.replace(/,/g, '') : numeric.replace(/,/g, '.');
  } else if (dotCount > 1) {
    // Plusieurs points sans virgule : ce sont des séparateurs de milliers
    // (`1.234.567`). Avec un seul point, point décimal et séparateur de milliers
    // sont indiscernables sans le contexte : on garde la lecture décimale, qui
    // est celle des plateformes anglophones majoritaires.
    numeric = numeric.replace(/\./g, '');
  }

  const value = Number.parseFloat(numeric);
  return Number.isFinite(value) ? value : null;
}

/** Prix + devise depuis un texte où les deux peuvent apparaître. */
function priceFromText(rawText, { fallbackCurrency = 'USD' } = {}) {
  const text = rawText === null || rawText === undefined ? '' : String(rawText);
  const currency = detectCurrencyFromText(text, fallbackCurrency);
  const price = parsePriceValue(text, { currencyHint: currency });
  if (price === null) return null;
  return { price, currency };
}

/** Cherche récursivement la première clé portant une valeur non vide (offres imbriquées). */
function findNestedValue(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return undefined;
  for (const key of keys) {
    if (node[key] !== undefined && node[key] !== null && node[key] !== '') return node[key];
  }
  // `priceSpecification` est un objet `PriceSpecification` : le visiter évite de
  // renvoyer l'objet entier au lieu de son montant.
  const containers = ['offers', 'priceSpecification', 'itemOffered', 'mainEntity', 'hasVariant', 'isVariantOf'];
  for (const key of containers) {
    if (node[key]) {
      const found = findNestedValue(node[key], keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
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

/**
 * Prix d'achat, essayé dans l'ordre de fiabilité décroissante : JSON-LD
 * (`offers`, `AggregateOffer`, `@graph`), puis méta Open Graph, puis microdata,
 * puis l'attribut `data-price` en dernier recours. Aucune source ne renvoie
 * `NaN` : un prix illisible vaut 0, ce qui laisse l'avertissement « prix
 * d'achat manquant » se déclencher comme avant.
 */
function extractPrice(jsonLdProduct, $) {
  // Le prix vient d'abord des offres (offre simple, tableau, ou `AggregateOffer`
  // avec lowPrice/highPrice), puis d'un éventuel `priceSpecification` imbriqué.
  const raw = findNestedValue(jsonLdProduct, ['price', 'lowPrice', 'highPrice']);
  if (raw !== undefined) {
    const declared = findNestedValue(jsonLdProduct, ['priceCurrency']);
    const parsed = priceFromText(raw, { fallbackCurrency: declared ? String(declared).toUpperCase() : 'USD' });
    if (parsed) return parsed;
  }

  for (const property of ['product:price:amount', 'og:price:amount']) {
    const content = $(`meta[property="${property}"]`).attr('content');
    if (content) {
      const declared = $('meta[property="product:price:currency"]').attr('content') ||
        $('meta[property="og:price:currency"]').attr('content');
      const parsed = priceFromText(content, { fallbackCurrency: declared ? String(declared).toUpperCase() : 'USD' });
      if (parsed) return parsed;
    }
  }

  const microdata = $('[itemprop="price"]').first();
  if (microdata.length) {
    const raw = microdata.attr('content') || microdata.text();
    // `itemprop="priceCurrency"` peut être porté par le même noeud ou par un
    // voisin dans le même itemscope : on prend le premier trouvé dans la page.
    const declared = $('[itemprop="priceCurrency"]').first().attr('content') || $('[itemprop="priceCurrency"]').first().text();
    const parsed = priceFromText(raw, { fallbackCurrency: declared ? String(declared).trim().toUpperCase() : 'USD' });
    if (parsed) return parsed;
  }

  const dataPrice = $('[data-price]').first().attr('data-price');
  if (dataPrice) {
    const parsed = priceFromText(dataPrice);
    if (parsed) return parsed;
  }

  return { price: 0, currency: 'USD' };
}

/**
 * Photos produit : JSON-LD (chaîne, tableau ou objet `ImageObject`), Open Graph,
 * microdata, puis les `<img>` de la page — y compris le chargement différé
 * (`data-src`, `data-original`, `data-lazy-src`, `srcset`). Les URL relatives
 * sont résolues contre l'URL FINALE (après redirections), sinon une boutique qui
 * renvoie vers un sous-domaine d'images produirait des liens cassés.
 */
/**
 * Vrai si une dimension déclarée (attribut `width`/`height`, ou `40px` dans un
 * `style` inline) est manifestement une icône plutôt qu'une photo produit. Une
 * dimension absente ou illisible n'est PAS un motif de rejet : beaucoup de
 * vraies photos n'annoncent leur taille qu'en CSS externe, invisible ici.
 */
const TINY_ICON_SIZE_PX = 48;
function hasTinyDeclaredSize($el) {
  const parse = (value) => {
    const n = Number.parseInt(String(value ?? '').replace(/[^\d.]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const width = parse($el.attr('width'));
  const height = parse($el.attr('height'));
  if (width !== null && width > 0 && width <= TINY_ICON_SIZE_PX) return true;
  if (height !== null && height > 0 && height <= TINY_ICON_SIZE_PX) return true;
  return false;
}

function extractImages($, baseUrl, jsonLdProduct) {
  const structuredUrls = new Set();

  const jsonLdImages = Array.isArray(jsonLdProduct?.image) ? jsonLdProduct.image : [jsonLdProduct?.image].filter(Boolean);
  for (const image of jsonLdImages) {
    const candidate = typeof image === 'string' ? image : image?.url || image?.contentUrl;
    const resolved = resolveUrl(candidate, baseUrl);
    if (resolved) structuredUrls.add(resolved);
  }

  for (const property of ['og:image', 'og:image:secure_url']) {
    $(`meta[property="${property}"]`).each((_, el) => {
      const resolved = resolveUrl($(el).attr('content'), baseUrl);
      if (resolved) structuredUrls.add(resolved);
    });
  }

  $('[itemprop="image"]').each((_, el) => {
    const candidate = $(el).attr('content') || $(el).attr('src') || $(el).attr('href');
    const resolved = resolveUrl(candidate, baseUrl);
    if (resolved) structuredUrls.add(resolved);
  });

  // Le scan générique de <img> est le chemin le moins fiable : sans le cadre
  // d'une donnée structurée, on ne distingue pas une photo produit d'un
  // logo de partenaire, d'un badge de paiement, ou d'un AUTRE produit vendu
  // sur la même page. Filtres cumulés : hors de l'en-tête/pied de
  // page/navigation/barre latérale et hors d'un widget « produits associés »
  // (leur contenu n'est jamais la fiche produit elle-même), taille déclarée
  // non minuscule, et nom de fichier non reconnu comme pictogramme.
  const genericUrls = new Set();
  $('img').each((_, el) => {
    const $el = $(el);
    if ($el.closest('header, footer, nav, aside').length) return;
    if ($el.closest(RELATED_PRODUCTS_SELECTOR).length) return;
    if (hasTinyDeclaredSize($el)) return;

    const attributes = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-old-hires'];
    let src = null;
    for (const attribute of attributes) {
      if ($el.attr(attribute)) {
        src = $el.attr(attribute);
        break;
      }
    }
    if (!src) {
      // `srcset="a.jpg 1x, b.jpg 2x"` : la première URL est la plus petite, mais
      // c'est la seule dont on soit sûr qu'elle appartienne à la fiche.
      const srcset = $el.attr('srcset') || $el.attr('data-srcset');
      if (srcset) src = String(srcset).split(',')[0].trim().split(/\s+/)[0];
    }
    if (!src || src.startsWith('data:')) return;
    if (NON_PHOTO_EXTENSION.test(src) || ICON_URL_PATTERN.test(src)) return;
    if (structuredUrls.has(src)) return;
    const resolved = resolveUrl(src, baseUrl);
    if (resolved && !structuredUrls.has(resolved)) genericUrls.add(resolved);
  });

  // Les sources structurées priment toujours et ne sont jamais plafonnées :
  // elles viennent du marchand lui-même (JSON-LD, Open Graph, microdata), pas
  // d'une supposition sur ce qu'est un <img> de mise en page. Le scan
  // générique, lui, est tronqué : au-delà d'une quinzaine d'images encore
  // présentes après les trois filtres ci-dessus, la suite est presque
  // toujours de la mise en page qui leur a échappé plutôt que la fiche.
  return [...structuredUrls, ...[...genericUrls].slice(0, MAX_GENERIC_IMAGES)];
}

/**
 * Extrait la poignée produit d'une URL Shopify. Les chemins varient beaucoup :
 * `/products/mon-produit`, `/collections/x/products/mon-produit`, avec ou sans
 * préfixe de langue, avec `.html`, ou sous `/fr/…/produits/…` pour les boutiques
 * francophones. On cherche donc le segment `product(s)` et on prend le suivant.
 *
 * Le pluriel est exigé : `/product/123.html` (singulier, très répandu ailleurs)
 * n'est PAS un permalien Shopify, et le confondre ferait interroger
 * `/products/123.json` sur des sites qui ne sont pas des boutiques Shopify.
 */
function deriveProductHandle(pathname) {
  const segments = String(pathname || '')
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // pourcentage invalide : on garde le segment brut
      }
    })
    .filter(Boolean);
  const index = segments.findIndex((segment) => /^(products|produits)$/i.test(segment));
  if (index === -1) return null;
  const handle = segments[index + 1];
  if (!handle) return null;
  return handle.replace(/\.(html?|json)$/i, '') || null;
}

/** Détecte un segment de plateforme dans le chemin : `/wp-json/…` trahit WordPress. */
function hasWoocommerceHint(url) {
  return /wp-json|wc\/store|\/wp-content\//i.test(url);
}

/** Nombre de décimales par défaut d'une devise (2), quand l'API ne le précise pas. */
const DEFAULT_MINOR_UNIT = 2;

/**
 * Lit un prix WooCommerce Store API.
 *
 * Piège majeur : l'API renvoie des unités MINEURES. `"price": "1250"` avec
 * `currency_minor_unit: 2` vaut 12,50 — et une devise sans décimale (JPY) a
 * `currency_minor_unit: 0`, donc 1250 vaut bien 1250. La division dépend donc
 * entièrement du champ `currency_minor_unit` ; la coder en dur (×100 ou ÷100)
 * fausserait tous les prix.
 */
function parseWoocommercePrice(prices, fallbackCurrency) {
  const currency = String(prices?.currency_code || fallbackCurrency || 'USD').toUpperCase();
  const minorUnit = Number(prices?.currency_minor_unit);
  const divisor = Number.isFinite(minorUnit) && minorUnit >= 0 ? 10 ** minorUnit : 10 ** DEFAULT_MINOR_UNIT;
  // `price` est le prix courant (promotion incluse), `regular_price` le prix
  // barré : on garde le prix courant comme prix d'achat, c'est celui qu'on paie.
  const raw = prices?.price ?? prices?.regular_price ?? prices?.sale_price;
  if (raw === null || raw === undefined || raw === '') return { price: 0, currency };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { price: 0, currency };
  return { price: value / divisor, currency };
}

/** JSON invalide, page de mot de passe ou erreur applicative : on ne devine pas, on abandonne le chemin rapide. */
function parseJsonBody(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Détermine, sans réseau, quelle API plateforme essayer.
 *
 * Heuristique volontairement large : un hôte inconnu n'est PAS un motif
 * suffisant pour s'abstenir (beaucoup de boutiques Shopify tournent sur leur
 * propre domaine), donc on se fie au permalien `/products/…`. Les hôtes
 * explicitement reconnus passent en tête, et un site dont l'URL contient
 * `wp-json` est traité comme WooCommerce sans même essayer Shopify.
 */
function detectPlatformCandidates(parsedUrl, sourceSite) {
  if (sourceSite === 'woocommerce' || hasWoocommerceHint(parsedUrl.href)) {
    return [{ kind: 'woocommerce', handle: deriveProductHandle(parsedUrl.pathname) }];
  }

  // Pas de segment `products` : aucun permalien à interroger. On préfère ne
  // rien tenter plutôt que de gaspiller deux requêtes sur une fiche inconnue —
  // le HTML générique reste de toute façon le chemin de repli.
  const handle = deriveProductHandle(parsedUrl.pathname);
  if (!handle) return [];

  // Une boutique WooCommerce peut très bien utiliser `/products/…` : on essaie
  // donc les deux API, Shopify d'abord (la plus répandue) ; dès que l'une répond
  // en JSON, l'autre n'est pas interrogée.
  return [{ kind: 'shopify', handle }, { kind: 'woocommerce', handle }];
}

/**
 * Chemin rapide Shopify. L'API produit publique expose exactement ce qu'on
 * cherche — titre, description HTML, images, prix des variantes — sans passer par
 * le HTML rendu côté client, qui est illisible sur beaucoup de thèmes.
 *
 * Deux points d'entrée, essayés dans cet ordre : `/products/{poignée}.json`
 * (léger, la fiche exacte) puis `/products.json?limit=250` (catalogue, quand la
 * fiche unitaire est désactivée ou illisible). Renvoie `{ responded, payload }` :
 * `responded` vaut vrai seulement quand une API Shopify a réellement répondu du
 * JSON — cela évite d'interroger WooCommerce inutilement. Tout échec (JSON
 * désactivé, page de mot de passe, redirection, réseau) retombe silencieusement
 * sur la suite : un chemin rapide ne doit JAMAIS faire échouer l'import.
 */
async function scrapeShopifyFastPath(origin, handle, { lookupHost, budget }) {
  if (!handle) return { responded: false, payload: null };

  const endpoints = [];
  try {
    endpoints.push(new URL(`/products/${encodeURIComponent(handle)}.json`, origin).toString());
  } catch {
    return { responded: false, payload: null };
  }
  try {
    endpoints.push(new URL('/products.json?limit=250', origin).toString());
  } catch {
    /* origine sans chemin exploitable : on se contente du point d'entrée produit */
  }

  const expected = handle.toLowerCase();
  let anyJson = false;
  for (const endpoint of endpoints) {
    let fetched;
    try {
      fetched = await fetchFollowingRedirects(endpoint, {
        lookupHost,
        budget,
        maxBytes: MAX_API_RESPONSE_BYTES,
      });
    } catch {
      continue; // API absente/refusée : on essaie l'entrée suivante, puis le HTML
    }

    // Corps non-JSON (page de mot de passe, HTML servi à la place de l'API…) :
    // ce n'est pas une preuve que le site n'est pas Shopify, on tente donc le
    // catalogue `products.json` avant d'abandonner.
    const body = parseJsonBody(fetched.text);
    if (!body) continue;
    anyJson = true;

    let product = body.product || null;
    if (!product && Array.isArray(body.products)) {
      // `products.json` renvoie le catalogue : on cherche la poignée exacte, puis
      // le titre, quand l'URL ne portait pas de poignée exploitable.
      product =
        body.products.find((item) => String(item?.handle || '').toLowerCase() === expected) ||
        body.products.find((item) => String(item?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').includes(expected)) ||
        null;
    }
    // JSON valide mais aucune fiche correspondante : on a bien affaire à une API
    // Shopify (le catalogue a répondu), simplement sans ce produit.
    if (!product || typeof product !== 'object') return { responded: true, payload: null };

    const variant = Array.isArray(product.variants) ? product.variants[0] : null;
    const variantPrice = parsePriceValue(variant?.price ?? product.price, { currencyHint: 'USD' });
    const compareAt = parsePriceValue(variant?.compare_at_price ?? product.compare_at_price, { currencyHint: 'USD' });
    const price = variantPrice ?? compareAt ?? 0;

    const images = [];
    const rawImages = Array.isArray(product.images) ? product.images : [];
    for (const image of rawImages) {
      const resolved = resolveUrl(typeof image === 'string' ? image : image?.src, origin);
      if (resolved) images.push(resolved);
    }

    return {
      responded: true,
      payload: {
        title: cleanText(product.title),
        rawDescription: htmlToText(product.body_html),
        purchasePrice: Number.isFinite(price) ? price : 0,
        currency: detectCurrencyFromText(product.currency || variant?.price_currency || '', 'USD'),
        imageUrls: images,
      },
    };
  }

  // Aucune fiche trouvée : on ne déclare « Shopify » que si l'API a réellement
  // répondu du JSON, sinon la boutique mérite d'être interrogée autrement.
  return { responded: anyJson, payload: null };
}

/**
 * Chemin rapide WooCommerce. La Store API publique (`/wp-json/wc/store/v1`)
 * répond même quand le thème rend le HTML en JavaScript ; elle expose aussi un
 * mode `search=` pour les permaliens sans slug produit.
 */
async function scrapeWoocommerceFastPath(origin, handle, { lookupHost, budget }) {
  const urls = [];
  const slug = handle || deriveProductHandle(new URL(origin).pathname);
  try {
    if (slug) {
      urls.push(new URL(`/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`, origin).toString());
      urls.push(new URL(`/wp-json/wc/store/v1/products?search=${encodeURIComponent(slug)}`, origin).toString());
    } else {
      urls.push(new URL('/wp-json/wc/store/v1/products?per_page=1', origin).toString());
    }
  } catch {
    return { responded: false, payload: null };
  }

  let anyJson = false;
  for (const endpoint of urls) {
    let fetched;
    try {
      fetched = await fetchFollowingRedirects(endpoint, {
        lookupHost,
        budget,
        maxBytes: MAX_API_RESPONSE_BYTES,
      });
    } catch {
      continue; // Store API absente ou refusée : on essaie l'URL suivante, puis le HTML
    }

    const body = parseJsonBody(fetched.text);
    if (!body) continue; // HTML servi à la place de l'API : le repli générique prendra le relais
    anyJson = true;
    const product = Array.isArray(body) ? body[0] : body;
    // Tableau vide (slug inconnu) : on doit essayer la recherche `search=` avant
    // de conclure. Un tableau non vide mais sans nom est en revanche une preuve
    // que l'API a répondu, donc que le site est bien WooCommerce.
    if (Array.isArray(body) && body.length === 0) continue;
    if (!product || typeof product !== 'object' || (!product.name && !product.id)) return { responded: true, payload: null };

    const images = [];
    const rawImages = Array.isArray(product.images) ? product.images : [];
    for (const image of rawImages) {
      const resolved = resolveUrl(typeof image === 'string' ? image : image?.src, origin);
      if (resolved) images.push(resolved);
    }

    const description = product.description || product.short_description || '';
    const { price, currency } = parseWoocommercePrice(product.prices, product.currency || 'USD');

    return {
      responded: true,
      payload: {
        title: cleanText(product.name),
        rawDescription: htmlToText(description),
        purchasePrice: price,
        currency,
        imageUrls: images,
      },
    };
  }

  return { responded: anyJson, payload: null };
}

/** Rassemble les données extraites d'un JSON d'API plateforme en résultat d'import exploitable. */
function normalizeFastPathResult(platform, payload) {
  if (!payload || !payload.title) return null;
  return {
    sourceSite: platform,
    title: String(payload.title).trim(),
    rawDescription: cleanText(payload.rawDescription),
    purchasePrice: Number.isFinite(payload.purchasePrice) ? payload.purchasePrice : 0,
    currency: payload.currency || 'USD',
    imageUrls: payload.imageUrls || [],
  };
}

/**
 * Titres qui trahissent un mur anti-robot déguisé en page 200 (Cloudflare,
 * Akamai…). Sans ce filtre, « Just a moment… » serait importé comme le titre
 * d'un produit. C'est aussi ce qui déclenche l'identité suivante : une page 200
 * sans produit est un échec, pas un succès silencieux.
 */
const BLOCKED_PAGE_TITLE = /(just a moment|attention required|access denied|are you a robot|enable javascript|checking your browser|403 forbidden|access to this page has been denied|page unavailable)/i;

/**
 * Extraction générique du HTML d'une fiche produit. Renvoie `null` — et non un
 * résultat vide — quand la page ne porte aucun titre exploitable : c'est ce
 * `null` qui fait monter d'une identité dans la stratégie directe, puis bascule
 * vers les lecteurs tiers.
 */
function extractFromHtml(html, finalUrl, patternSite) {
  const $ = cheerio.load(html || '');
  const jsonLdProduct = parseJsonLdProduct($);

  const title =
    cleanText(jsonLdProduct?.name) ||
    cleanText($('meta[property="og:title"]').attr('content')) ||
    cleanText($('[itemprop="name"]').first().attr('content') || $('[itemprop="name"]').first().text()) ||
    cleanText($('h1').first().text()) ||
    cleanText($('title').text());

  if (!title || BLOCKED_PAGE_TITLE.test(title)) return null;

  const rawDescription =
    cleanText(jsonLdProduct?.description) ||
    cleanText($('meta[property="og:description"]').attr('content')) ||
    cleanText($('meta[name="description"]').attr('content')) ||
    cleanText($('[itemprop="description"]').first().attr('content') || $('[itemprop="description"]').first().text());

  const { price, currency } = extractPrice(jsonLdProduct, $);
  const imageUrls = extractImages($, finalUrl, jsonLdProduct);

  return {
    sourceSite: patternSite,
    title: title.trim(),
    rawDescription: rawDescription.trim(),
    purchasePrice: price,
    currency,
    imageUrls,
  };
}

/**
 * Dérive l'hôte « mobile » d'une URL : `www.alibaba.com` → `m.alibaba.com`,
 * `alibaba.com` → `m.alibaba.com`. On s'abstient si l'hôte n'a pas de domaine
 * exploitable ou s'il est déjà `m.` : fabriquer `m.m.exemple.com` serait pire
 * que ne rien tenter.
 */
function deriveAlternateHostUrls(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  const bare = host.replace(/^www\./, '');
  if (!bare.includes('.') || /^m\./.test(bare)) return [];
  const candidate = `m.${bare}`;
  if (candidate === host) return [];

  const alternate = new URL(parsedUrl.toString());
  alternate.hostname = candidate;
  return [alternate.toString()];
}

/**
 * Ordre EXACT des tentatives directes, du plus « normal » au plus spécifique :
 * navigateur desktop → mobile → Googlebot → hôte alternatif. Chaque tentative
 * rejoue l'URL avec une identité complète et cohérente (voir
 * `buildBrowserHeaders`) : on ne se contente pas de changer le User-Agent.
 */
function buildDirectStrategies(parsedUrl) {
  const strategies = [
    { name: 'navigateur', url: parsedUrl.toString(), profile: 'navigateur' },
    { name: 'mobile', url: parsedUrl.toString(), profile: 'mobile' },
    { name: 'googlebot', url: parsedUrl.toString(), profile: 'googlebot' },
  ];
  for (const alternate of deriveAlternateHostUrls(parsedUrl)) {
    let label = alternate;
    try {
      label = new URL(alternate).hostname;
    } catch {
      /* URL déjà construite par `deriveAlternateHostUrls` : on garde l'URL brute */
    }
    strategies.push({ name: `hôte alternatif (${label})`, url: alternate, profile: 'navigateur' });
  }
  return strategies;
}

/** Motif lisible d'une page 200 inexploitable, pour le rapport final. */
function classifyUnusablePage(fetched) {
  const body = String(fetched?.text || '').trim();
  if (!body) return 'corps vide';
  if (/captcha|robot check|are you a robot|just a moment|access denied|attention required|cf-error|enable javascript/i.test(body)) {
    return 'page anti-robot';
  }
  return 'aucune donnée produit';
}

/**
 * Résume en une ligne ce que chaque stratégie a répondu. C'est ce qui permet à
 * l'utilisateur de distinguer un site qui bloque (403 répétés) d'une URL erronée
 * (404) ou d'un service tiers indisponible — au lieu d'un message unique qui ne
 * dit rien.
 */
function describeAttempts(attempts) {
  if (!attempts.length) return 'aucune tentative enregistrée';
  return attempts
    .map((attempt) => {
      const details = [attempt.status ? `HTTP ${attempt.status}` : null, attempt.note || null]
        .filter(Boolean)
        .join(', ');
      return details ? `${attempt.strategy} (${details})` : attempt.strategy;
    })
    .join(' ; ');
}

function buildDirectFailureMessage(patternSite, attempts) {
  return (
    `Aucune information exploitable extraite de cette page (${patternSite}). `
    + `Le site bloque probablement les requêtes automatisées (page vide, mur anti-robot ou contenu chargé en JavaScript). `
    + `Stratégies essayées : ${describeAttempts(attempts)}. `
    + `Vérifie d'abord que l'URL est bien celle d'une fiche produit, puis saisis la fiche à la main : l'IA n'a besoin que d'un titre et d'un prix.`
  );
}

/** Ligne de métadonnée produite par r.jina.ai (« Title: … »). */
const READER_META_LINE = /^(title|url source|published time|markdown content|description|warning)\s*:\s*/i;
/** Image markdown : `![alt](https://…)`. */
const READER_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)/g;
const MARKDOWN_INLINE = /[*_`>#]+/g;

/** Retire le balisage markdown d'une ligne (liens, emphases, titres). */
function stripMarkdownInline(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(MARKDOWN_INLINE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extraction de dernier recours depuis la réponse texte/markdown de r.jina.ai.
 *
 * Deux formes possibles : du markdown (cas nominal) ou du HTML brut (certains
 * modes du lecteur). Dans le second cas on réutilise l'extraction HTML, bien
 * plus fiable que d'improviser ligne à ligne. Le prix est cherché en priorité
 * sur une ligne portant à la fois un chiffre et un symbole/code monétaire :
 * chercher sur tout le document ramasserait le premier nombre venu (quantité,
 * référence, date de publication).
 */
function extractFromReaderText(text, baseUrl, patternSite) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  if (/<\s*(?:!doctype|html|head|body|meta|script|div)\b/i.test(raw)) {
    return extractFromHtml(raw, baseUrl, patternSite);
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const body = [];
  let title = '';
  let description = '';
  for (const line of lines) {
    const meta = line.match(READER_META_LINE);
    if (meta) {
      const label = meta[1].toLowerCase();
      const value = stripMarkdownInline(line.slice(meta[0].length));
      if (label === 'title' && !title) title = value;
      else if (label === 'description' && !description) description = value;
      continue;
    }
    if (line) body.push(line);
  }
  if (!title) {
    const heading = body.find((line) => /^#{1,4}\s+\S/.test(line)) || body[0] || '';
    title = stripMarkdownInline(heading.replace(/^#{1,6}\s*/, ''));
  }
  if (!title || title.length < 2 || BLOCKED_PAGE_TITLE.test(title)) return null;

  const images = [];
  const seen = new Set();
  for (const match of raw.matchAll(READER_IMAGE_PATTERN)) {
    const url = match[1];
    if (!seen.has(url)) {
      seen.add(url);
      images.push(url);
    }
    if (images.length >= MAX_GENERIC_IMAGES) break;
  }

  if (!description) description = stripMarkdownInline(body.join(' ')).slice(0, 1200);

  const priceLine = lines.find(
    (line) =>
      /\d/.test(line)
      && /[€$£¥]|\b(?:EUR|USD|GBP|PLN|CNY|RMB|JPY|CHF|CAD|AUD|SEK|NOK|DKK|CZK|HUF|RON|BGN|TRY|INR|BRL|MXN|HKD|SGD|NZD|ZAR)\b/i.test(line),
  );
  const parsed = priceFromText(priceLine || raw);
  const price = parsed ? parsed.price : 0;
  const currency = parsed ? parsed.currency : 'USD';

  return {
    sourceSite: patternSite,
    title: title.trim(),
    rawDescription: description.trim(),
    purchasePrice: price,
    currency,
    imageUrls: images,
  };
}

/**
 * Récupère une ressource chez un LECTEUR TIERS.
 *
 * Sécurité — le point capital : archive.org et r.jina.ai vont chercher l'URL
 * cible DEPUIS LEUR PROPRE RÉSEAU. On ne peut donc jamais leur transmettre une
 * adresse que `assertHostIsPublic` n'a pas validée, sinon on leur offrirait un
 * moyen de sonder le réseau interne du serveur (127.0.0.1, 192.168.x.x,
 * 169.254.169.254…). L'appelant re-valide la cible juste avant de la confier au
 * tiers ; ici on valide en plus l'hôte du service lui-même, et chaque
 * redirection repasse par la même barrière (`fetchFollowingRedirects`).
 */
async function fetchReaderResource(url, { lookupHost, budget, headers, maxBytes = budget.maxBytes }) {
  await assertHostIsPublic(new URL(url), lookupHost);
  return fetchFollowingRedirects(url, { lookupHost, budget, headers, maxBytes, returnOnHttpError: true });
}

const WAYBACK_AVAILABILITY_URL = 'https://archive.org/wayback/available';
const JINA_READER_URL = 'https://r.jina.ai/';
/** Titres de pages d'erreur d'un lecteur, jamais un produit. */
const READER_ERROR_TITLE = /(wayback machine|internet archive|not archived|no archived|blocked site error|429 too many requests|rate limit)/i;

/**
 * Repli n°1 : Wayback Machine (gratuit, sans clé). On interroge l'API
 * `available` puis on lit l'instantané comme n'importe quelle page. Aucun
 * instantané ⇒ on avance EN SILENCE : ce n'est pas une erreur d'import, juste
 * une source qui n'a rien pour cette URL.
 */
async function tryWaybackSnapshot(targetUrl, { lookupHost, budget, patternSite }) {
  const availabilityUrl = `${WAYBACK_AVAILABILITY_URL}?url=${encodeURIComponent(targetUrl)}`;
  let availability;
  try {
    availability = await fetchReaderResource(availabilityUrl, {
      lookupHost,
      budget,
      maxBytes: MAX_API_RESPONSE_BYTES,
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    });
  } catch {
    return null; // service injoignable : ce n'est pas une raison de faire échouer l'import
  }
  if (!availability.ok) return null;

  const body = parseJsonBody(availability.text);
  const snapshotUrl = body?.archived_snapshots?.closest?.url;
  if (typeof snapshotUrl !== 'string' || !snapshotUrl) return null;

  let snapshot;
  try {
    snapshot = await fetchReaderResource(snapshotUrl, {
      lookupHost,
      budget,
      headers: buildBrowserHeaders(snapshotUrl, 'navigateur'),
    });
  } catch {
    return null;
  }
  if (!snapshot.ok) return null;

  const extracted = extractFromHtml(snapshot.text, snapshot.finalUrl || snapshotUrl, patternSite);
  // L'instantané existe mais la page servie est une erreur du lecteur :
  // importer « Wayback Machine has not archived that URL » comme titre serait
  // pire que de continuer.
  if (!extracted || READER_ERROR_TITLE.test(extracted.title)) return null;
  return extracted;
}

/**
 * Repli n°2 : lecteur Jina (offre gratuite, sans clé). Il rend la page en
 * texte/markdown et conçoit son service pour franchir les blocages simples.
 * Dernier recours assumé — la donnée est moins fiable qu'une page servie
 * directement, d'où le `strategy: 'jina'` remonté à l'appelant.
 */
async function tryJinaReader(targetUrl, { lookupHost, budget, patternSite }) {
  const readerUrl = `${JINA_READER_URL}${targetUrl}`;
  let fetched;
  try {
    fetched = await fetchReaderResource(readerUrl, {
      lookupHost,
      budget,
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        Accept: 'text/plain,text/markdown;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    });
  } catch {
    return null;
  }
  if (!fetched.ok) return null;
  return extractFromReaderText(fetched.text, targetUrl, patternSite);
}

/**
 * Extrait titre, description, prix d'achat et photos depuis la page produit d'un fournisseur.
 *
 * Quatre niveaux, du plus fiable au plus général :
 * 1. les API publiques des plateformes (Shopify, WooCommerce), qui renvoient des
 *    données structurées même quand la page est rendue en JavaScript ;
 * 2. le HTML servi directement, lu avec une identité de navigateur complète ;
 * 3. la MÊME page, redemandée avec d'autres identités (mobile, Googlebot) puis
 *    sur l'hôte mobile quand il en existe un ;
 * 4. en dernier recours, un lecteur tiers (Wayback Machine puis r.jina.ai) qui
 *    va chercher la page depuis SON réseau.
 *
 * Tous les niveaux passent par la MÊME barrière SSRF (`assertHostIsPublic` à
 * chaque saut, y compris pour les hôtes alternatifs et AVANT de confier l'URL à
 * un tiers), partagent le MÊME budget de temps et d'octets, et chacune des
 * tentatives est enregistrée dans `attempts` pour que l'appelant voie ce qui a
 * été essayé et ce que chaque tentative a répondu.
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

  const patternSite = detectSourceSite(url);
  const budget = createBudget(timeoutMs, maxBytes);
  // Journal des tentatives : remonté à l'appelant en cas de succès (`strategy` =
  // celle qui a marché) comme en cas d'échec (message final), pour qu'il puisse
  // distinguer un site qui bloque d'une URL erronée.
  const attempts = [];

  // 1) API plateformes. Elles sont essayées uniquement quand le chemin y ressemble
  // (`/products/…`, `wp-json`) ou que l'hôte est un hébergeur connu : on ne veut
  // pas ajouter deux requêtes inutiles sur chaque import d'une boutique inconnue.
  for (const candidate of detectPlatformCandidates(parsedUrl, patternSite)) {
    // On garde toujours de quoi lire la page au moins une fois : une API lente ne
    // doit pas condamner le repli HTML, qui est le chemin de dernier recours.
    if (budget.deadline - Date.now() <= MIN_HTML_BUDGET_MS) break;

    const { responded, payload } =
      candidate.kind === 'shopify'
        ? await scrapeShopifyFastPath(parsedUrl.origin, candidate.handle, { lookupHost, budget })
        : await scrapeWoocommerceFastPath(parsedUrl.origin, candidate.handle, { lookupHost, budget });

    const result = normalizeFastPathResult(candidate.kind, payload);
    if (result) return { ...result, strategy: candidate.kind, attempts };
    // L'API n'a pas rendu la fiche : on le note pour que le rapport final soit
    // honnête sur TOUT ce qui a été tenté, puis on passe au HTML.
    attempts.push({ strategy: candidate.kind, note: responded ? 'API sans fiche' : 'API indisponible' });
    // L'API a répondu autre chose que la fiche attendue (page de mot de passe,
    // JSON vide…) : inutile d'interroger une autre plateforme, on passe au HTML.
    if (responded) break;
  }

  // 2) Montée en identités sur le HTML. La première tentative est exactement
  // celle d'avant (navigateur desktop) ; chacune des suivantes ne part QUE si la
  // précédente a été bloquée (400/403/429/503) ou a renvoyé une page sans
  // produit. Un 404 ou un 410, à l'inverse, arrête la montée : c'est une réponse
  // définitive du site, et la garder visible aide à repérer une URL erronée.
  for (const strategy of buildDirectStrategies(parsedUrl)) {
    if (budget.deadline - Date.now() <= 0) {
      attempts.push({ strategy: strategy.name, note: 'budget de temps épuisé' });
      break;
    }
    if (strategy.url !== url) {
      // L'hôte alternatif est une NOUVELLE cible réseau : il repasse par la même
      // barrière SSRF que l'URL d'origine (`m.exemple.com` peut très bien
      // résoudre vers une adresse privée).
      await assertHostIsPublic(new URL(strategy.url), lookupHost);
    }

    // Erreurs de sûreté (SSRF), de budget, de redirection ou de volume : elles
    // remontent telles quelles. Les « réessayer » avec une autre identité
    // reviendrait à contourner la barrière ou à gaspiller le budget.
    const fetched = await fetchFollowingRedirects(strategy.url, {
      lookupHost,
      budget,
      headers: buildBrowserHeaders(strategy.url, strategy.profile),
      returnOnHttpError: true,
    });

    if (!fetched.ok) {
      attempts.push({ strategy: strategy.name, status: fetched.status });
      if (!RETRYABLE_STATUSES.has(fetched.status)) break;
      continue;
    }

    const extracted = extractFromHtml(fetched.text, fetched.finalUrl, patternSite);
    if (extracted) return { ...extracted, strategy: strategy.name, attempts };
    attempts.push({ strategy: strategy.name, status: fetched.status, note: classifyUnusablePage(fetched) });
  }

  // 3) Lecteurs tiers — dernier recours. Sécurité : on re-valide la cible JUSTE
  // avant de la communiquer à un service qui ira la chercher depuis SON réseau.
  // Une adresse privée est refusée ici avant qu'archive.org ou r.jina.ai n'en
  // entende jamais parler (voir le test « aucune requête tierce pour une adresse
  // privée »).
  const targetUrl = parsedUrl.toString();
  await assertHostIsPublic(new URL(targetUrl), lookupHost);

  const wayback = await tryWaybackSnapshot(targetUrl, { lookupHost, budget, patternSite });
  if (wayback) return { ...wayback, strategy: 'wayback', attempts };
  attempts.push({ strategy: 'wayback', note: 'aucun instantané exploitable' });

  const jina = await tryJinaReader(targetUrl, { lookupHost, budget, patternSite });
  if (jina) return { ...jina, strategy: 'jina', attempts };
  attempts.push({ strategy: 'jina', note: 'aucune donnée exploitable' });

  // 4) Échec : le message dit exactement ce qui a été tenté et ce que chaque
  // tentative a répondu — et renvoie vers la saisie manuelle, qui, elle,
  // fonctionne toujours (POST /api/imports/manual).
  throw new Error(buildDirectFailureMessage(patternSite, attempts));
}
