import { config } from '../config/env.js';
import { askModel, parseJsonFromModel } from '../ai/client.js';
import {
  assertHostIsPublic,
  defaultLookup,
  detectSourceSite,
  looksLikeGenericPage,
} from './scraper.js';

/*
 * Lecture d'une fiche produit par un AGENT WEB, quand le scraping a échoué.
 *
 * Pourquoi cette couche existe
 * ----------------------------
 * Alibaba (et d'autres places de marché B2B) refusent les six couches de
 * scraping : en-têtes de navigateur complet, échelle de réessais, hôte mobile
 * `m.alibaba.com`, instantané Wayback, lecteur Jina. Toutes se font bloquer de
 * la même façon, parce qu'elles se présentent toutes comme un client HTTP
 * automatisé. Le résultat en production était un HTTP 400 répétitif que
 * l'utilisateur a signalé comme « erreur répétitive ».
 *
 * Il n'existe pas de contournement honnête à ce blocage par le scraping : la
 * sixième couche ne marchera pas mieux que la première. En revanche le projet
 * dispose DÉJÀ d'un agent qui ouvre réellement les pages sur le web : le preset
 * `pro-search` de Perplexity, utilisé par le Dénicheur (voir ai/supplierFinder.js)
 * et dont la clé est configurée en production. Cette couche le réutilise pour
 * LIRE la page au lieu de la chercher.
 *
 * Ce que cette couche n'est pas
 * -----------------------------
 * Ce n'est pas un scrape déguisé et ce n'est pas une source de vérité. Un agent
 * qui lit une page peut se tromper (prix d'une variante au lieu du prix de base,
 * prix promotionnel, devise mal identifiée). Le résultat est donc marqué comme
 * lu par IA dans l'import (`extraction_method = 'agent'`) pour que l'interface
 * avertisse l'utilisateur, et AUCUN prix n'est accepté sans devise explicite :
 * un prix faux se propage silencieusement dans le prix de vente conseillé et
 * dans les annonces publiées.
 *
 * Règle de refus : mieux vaut un échec franc qu'un faux succès. Si l'agent n'a
 * pas réellement lu la page, s'il retombe sur une page d'annuaire, ou s'il ne
 * voit pas de prix avec sa devise, cette fonction LÈVE une erreur explicite qui
 * renvoie vers la saisie manuelle (POST /api/imports/manual), laquelle ne dépend
 * d'aucun site et fonctionne toujours.
 */

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

/* Plus long que le scrape (45 s contre 10 s) : ce n'est pas une requête HTTP
   mais un agent qui cherche, ouvre et lit une page. Reste borné pour tenir dans
   le délai de la requête entrante de l'utilisateur — au-delà, ce n'est plus une
   attente, c'est un blocage. */
const AGENT_TIMEOUT_MS = 45_000;

// Un seul réessai sur 429 « upstream overloaded », comme le Dénicheur : c'est
// presque toujours passager. Le délai suggéré par Perplexity est respecté, borné
// pour ne pas immobiliser la requête de l'utilisateur.
const MAX_RETRY_DELAY_MS = 15_000;

/* Alibaba protège ses images par référent : ces URL restent utiles à titre
   indicatif, mais elles peuvent refuser de se télécharger. On en garde peu,
   surtout parce que la route tronque de toute façon à MAX_IMAGES (30) et que
   l'utilisateur remplacera probablement ces visuels par les siens. */
const MAX_IMAGES_FROM_AGENT = 8;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Consigne donnée à l'agent. Elle est délibérément méfiante : on exige une
 * lecture réelle de l'URL exacte, on interdit explicitement d'inventer un prix,
 * et on demande une preuve textuelle (le passage vu sur la page) qui permet à
 * l'utilisateur de juger la fiabilité sans avoir à rouvrir la page.
 */
function buildPrompt(url) {
  return (
    `Ouvre EXACTEMENT cette page produit et lis-la : ${url}\n`
    + 'Utilise ton outil d\'ouverture de page sur cette URL précise. Ne te contente pas d\'un résultat de recherche '
    + 'et ne remplace pas l\'URL par une autre.\n'
    + 'Réponds UNIQUEMENT par un objet JSON, sans texte autour et sans balise de code, avec exactement ces clés :\n'
    + '{\n'
    + '  "pageRead": true ou false — as-tu réellement ouvert et lu CETTE page ?\n'
    + '  "pageKind": "fiche produit" | "page d\'accueil" | "page de categorie" | "annuaire" | "mur anti-robot" | "erreur",\n'
    + '  "title": le nom exact du produit tel qu\'il est écrit sur la page, ou "" si tu n\'as pas pu lire la page,\n'
    + '  "price": le prix à l\'unité le PLUS BAS visible sur la page, en nombre décimal sans symbole ni séparateur de milliers, ou null,\n'
    + '  "currency": le code ISO à 3 lettres de ce prix (USD, EUR, CNY…) ou null,\n'
  + '  "shippingPrice": les frais de PORT par pièce s\'ils sont écrits sur la page, en nombre décimal, ou null,\n'
    + '  "priceNote": le prix tel qu\'il est écrit sur la page, recopié mot pour mot (par exemple "US$1.20-1.50 / piece, min. order 100 pieces"), ou "",\n'
    + '  "description": 2 à 4 phrases décrivant le produit d\'après ce que dit la page, ou "",\n'
    + '  "images": un tableau d\'URL absolues d\'images du produit vues sur la page (maximum 8, [] si aucune),\n'
    + '  "evidence": une citation courte et exacte, recopiée de la page, qui montre le prix que tu as retenu, ou ""\n'
    + '}\n'
    + 'Règles strictes :\n'
    + '- N\'INVENTE JAMAIS un prix, une devise, un titre ou des images. Si tu ne les vois pas sur la page, mets null ou "".\n'
    + '- Si la page est une page d\'accueil, une page de catégorie, un annuaire ou un mur anti-robot, mets "pageRead": false '
    + 'et "pageKind" en conséquence : cela vaut mieux qu\'un titre approximatif.\n'
    + '- Si le prix est une fourchette, retiens la borne basse pour "price" et recopie la fourchette entière dans "priceNote".\n'
    + '- Si le prix est affiché dans une autre devise que le dollar, donne la devise réellement affichée, pas une conversion.\n'
    + '- Aucune estimation, aucun prix « typique » de marché, aucune conversion de devise.'
  );
}

/* Le texte de réponse peut arriver sous deux formes selon la variante de l'API
   (comme dans ai/supplierFinder.js) : la commodité `output_text`, ou le tableau
   `output` détaillé. */
function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text) return payload.output_text;
  const messages = Array.isArray(payload?.output) ? payload.output : [];
  return messages
    .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
    .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Récupère le premier objet JSON équilibré du texte. Un simple `JSON.parse`
 * échouerait dès que le modèle ajoute une phrase avant ou après l'objet, ce qui
 * arrive régulièrement malgré la consigne. Le parcours respecte les chaînes et
 * leurs échappements pour ne pas confondre une accolade citée avec la fin de
 * l'objet.
 */
function extractFirstJsonObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* Retire les balises de code que le modèle ajoute parfois autour du JSON
   (` ```json ... ``` `) avant l'extraction. */
function stripCodeFences(text) {
  return String(text || '')
    .replace(/^\s*```[a-zA-Z]*\s*/m, '')
    .replace(/\s*```\s*$/m, '');
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Traduit la réponse brute de l'agent en une fiche exploitable, ou lève une
 * erreur disant précisément ce qui a manqué. Aucune valeur n'est devinée : un
 * champ absent est un refus, jamais un zéro ou un dollar par défaut.
 */
function normalizeAgentResult(raw, url, { strategy = 'agent-perplexity', lecteur = 'Perplexity' } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('réponse illisible : aucun objet JSON exploitable.');
  }

  const pageKind = normalizeText(raw.pageKind) || 'inconnue';
  const title = normalizeText(raw.title);
  const description = normalizeText(raw.description);
  const priceNote = normalizeText(raw.priceNote);
  const evidence = normalizeText(raw.evidence);

  /* L'agent admet ne pas avoir lu la page : c'est le cas d'Alibaba quand le mur
     anti-robot tient bon même pour lui, et c'est une information utile, pas un
     bug. On la remonte telle quelle plutôt que de la masquer derrière un titre
     de repli. */
  if (raw.pageRead !== true) {
    throw new Error(
      `l'agent n'a pas pu lire la page (type de page vu : ${pageKind}). `
      + 'Le site bloque probablement aussi la lecture automatique — utilise la saisie manuelle '
      + '(titre + prix d\'achat), l\'IA génère ensuite les 5 fiches sans avoir besoin de la page.',
    );
  }

  /* Même refus que le scraper : un titre d'annuaire n'est pas une fiche produit.
     Réutiliser `looksLikeGenericPage` garantit que le trou déjà corrigé côté
     scraping ne se rouvre pas ici (Alibaba répond « Alibaba Manufacturer
     Directory »). */
  if (looksLikeGenericPage({ title })) {
    throw new Error(
      'l\'agent a bien ouvert la page mais elle ne contient pas de fiche produit '
      + `(titre lu : « ${title || 'aucun'} », type : ${pageKind}). `
      + 'Utilise la saisie manuelle pour créer l\'import à partir du titre et du prix.',
    );
  }

  /* Le prix doit être un nombre strictement positif : 0 est le symptôme d'une
     extraction manquée, et les canaux de publication rejettent une fiche à 0 €. */
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(
      'l\'agent a lu la page mais n\'y a vu aucun prix à l\'unité exploitable'
      + (priceNote ? ` (prix affiché : « ${priceNote} »)` : '')
      + '. Saisis le prix à la main : la page est peut-être réservée aux comptes connectés.',
    );
  }

  /* Devise obligatoire. Un prix sans devise fausse le prix de vente conseillé
     puis les annonces publiées ; on refuse plutôt que de supposer le dollar. */
  const currency = normalizeText(raw.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(
      `l'agent a lu un prix (${price}) mais n'a pas donné de devise ISO exploitable`
      + (currency ? ` (reçu : « ${currency} »)` : '')
      + '. Un prix sans devise publierait un prix de vente faux — saisis-le à la main.',
    );
  }

  const imageUrls = (Array.isArray(raw.images) ? raw.images : [])
    .filter((image) => typeof image === 'string' && /^https?:\/\//i.test(image.trim()))
    .map((image) => image.trim())
    .filter((image, index, all) => all.indexOf(image) === index)
    .slice(0, MAX_IMAGES_FROM_AGENT);

  /* La note de prix et la preuve sont conservées : elles permettent à
     l'utilisateur de juger la lecture sans rouvrir la page, et couvrent le cas
     d'une fourchette de prix B2B (« 1,20–1,50 US$ / pièce, min. 100 pièces »)
     que le seul nombre ne restitue pas. */
  const notes = [
    `Fiche lue par un agent web (${lecteur}), pas extraite du code source de la page — à vérifier avant publication.`,
    `Type de page vu par l'agent : ${pageKind}.`,
    priceNote ? `Prix tel qu'affiché : « ${priceNote} ».` : null,
    evidence ? `Passage de la page cité par l'agent : « ${evidence} ».` : null,
  ].filter(Boolean).join(' ');

  return {
    sourceSite: detectSourceSite(url),
    title,
    rawDescription: description,
    purchasePrice: price,
    currency,
    /* Transport lu par l'agent, dans la même devise que le prix d'achat.
       Absent ou illisible = 0 : le calcul retombera alors sur le forfait de lot
       s'il existe. On ne devine jamais — un transport inventé fausse le coût
       rendu, et donc tous les prix qui en découlent. */
    shippingPrice: Number.isFinite(Number(raw.shippingPrice)) && Number(raw.shippingPrice) >= 0
      ? Number(raw.shippingPrice)
      : 0,
    imageUrls,
    strategy,
    agentNotes: notes,
  };
}

async function callAgent(prompt, fetchImpl) {
  return fetchImpl(`${PERPLEXITY_BASE_URL}/v1/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.perplexity.apiKey}`,
    },
    body: JSON.stringify({ preset: 'pro-search', input: prompt }),
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });
}

/**
 * Lit une fiche produit en faisant ouvrir la page par l'agent web Perplexity.
 *
 * Lève une erreur explicite dans TOUS les cas où la fiche n'est pas
 * exploitable — clé absente, URL privée, HTTP en échec, page non lue, page
 * générique, prix ou devise manquants — et ne renvoie jamais un résultat
 * partiel silencieux.
 *
 * `lookupHost` et `fetchImpl` sont injectables pour que les tests couvrent la
 * garde SSRF et l'analyse de la réponse sans toucher au réseau.
 */

/* ============================================================================
   LECTEUR GRATUIT — remplace Perplexity quand aucune clé n'est configurée.
   ============================================================================

   POURQUOI. La couche agent reposait sur `pro-search` de Perplexity : payant, et
   une clé de plus à gérer. Or deux briques GRATUITES sont déjà là :

     1. r.jina.ai — lit une page et en renvoie le texte, sans clé ;
     2. le modèle configuré — Ollama en local (gratuit), Groq en ligne
        (offre gratuite). C'est `askModel`, déjà utilisé partout.

   Ce que ça change, honnêtement : Perplexity, lui, CHERCHE sur le web quand la
   page est bloquée. Ici on ne fait que lire l'URL demandée. Une page vraiment
   inaccessible restera inaccessible — mais elle échouera avec un message clair
   au lieu de coûter une clé.

   La validation est IDENTIQUE à celle du chemin payant : `normalizeAgentResult`
   est réutilisée telle quelle. Un titre d'annuaire reste refusé, un prix sans
   devise reste refusé, et rien n'est inventé.
*/

/* Jina Reader a besoin de quelques secondes : il charge la page, exécute le
   JavaScript et convertit le résultat. 20 s laisse de la marge sans bloquer
   indéfiniment une requête utilisateur. */
const JINA_TIMEOUT_MS = 20000;

/* Au-delà, on coupe : un modèle local a une fenêtre limitée, et le début d'une
   fiche produit contient déjà le titre et le prix. Tout garder ferait échouer
   l'extraction pour rien. */
const MAX_PAGE_CHARS = 12000;

/** Lit une page via r.jina.ai (gratuit, sans clé) et renvoie son texte. */
async function fetchPageTextFree(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://r.jina.ai/${url}`, {
      headers: {
        // `markdown` conserve les titres et les tableaux de prix, que du texte
        // brut écraserait.
        'X-Return-Format': 'markdown',
        Accept: 'text/plain',
      },
      signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`le lecteur gratuit (r.jina.ai) n'a pas répondu en ${JINA_TIMEOUT_MS / 1000} s.`);
    }
    throw new Error(`lecteur gratuit injoignable : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new Error(
        'le lecteur gratuit (r.jina.ai) est saturé (HTTP 429). Réessaie dans une minute : '
        + 'sans clé, le service est limité en débit.',
      );
    }
    throw new Error(`le lecteur gratuit a répondu HTTP ${response.status} : ${detail.slice(0, 200)}`);
  }

  const texte = (await response.text()).trim();
  if (!texte) {
    throw new Error('le lecteur gratuit n’a renvoyé aucun texte : la page est probablement vide ou bloquée.');
  }
  return texte.slice(0, MAX_PAGE_CHARS);
}

/** Consigne d'extraction pour le modèle : il LIT un texte, il ne navigue pas. */
function buildExtractionPrompt(url, texte) {
  return (
    `Voici le texte d'une page produit, récupéré depuis ${url}.\n`
    + 'Tu ne navigues pas : tu EXTRAIS uniquement ce qui figure dans ce texte.\n'
    + 'Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balise de code :\n'
    + '{\n'
    + '  "pageRead": true si le texte décrit bien UN produit identifiable, sinon false,\n'
    + '  "pageKind": "fiche produit" | "page d\'accueil" | "page de categorie" | "annuaire" | "mur anti-robot" | "erreur",\n'
    + '  "title": le nom exact du produit tel qu\'il est écrit, ou "",\n'
    + '  "price": le prix à l\'unité le PLUS BAS visible, en nombre décimal sans symbole ni séparateur de milliers, ou null,\n'
    + '  "shippingPrice": les frais de PORT par pièce s\'ils sont écrits sur la page, en nombre décimal, ou null,\n'
    + '  "currency": le code ISO à 3 lettres de ce prix (USD, EUR, CNY…) ou null,\n'
    + '  "priceNote": le prix tel qu\'écrit mot pour mot, ou "",\n'
    + '  "description": 2 à 4 phrases décrivant le produit d\'après ce texte, ou "",\n'
    + '  "images": tableau d\'URL absolues d\'images vues dans le texte (maximum 8, [] si aucune),\n'
    + '  "evidence": une citation courte et EXACTE du texte qui montre le prix retenu, ou ""\n'
    + '}\n'
    + 'Règles strictes :\n'
    + '- N\'INVENTE RIEN. Ni prix, ni devise, ni titre, ni image. Ce qui n\'est pas dans le texte vaut null ou "".\n'
    + '- Si le texte est une page d\'accueil, de catégorie, un annuaire ou un mur anti-robot, mets "pageRead": false : '
    + 'cela vaut mieux qu\'un titre approximatif.\n'
    + '- Fourchette de prix : retiens la borne BASSE pour "price", recopie la fourchette entière dans "priceNote".\n'
    + '- Ne convertis aucune devise : donne celle qui est écrite.\n'
    + '- Les frais de port ne se devinent pas : si la page ne les écrit pas, mets null. '
    + 'S\'ils sont écrits « livraison incluse » ou « free shipping », mets 0.\n\n'
    + '--- DÉBUT DU TEXTE DE LA PAGE ---\n'
    + texte
  );
}

/**
 * Lit une fiche produit sans aucune clé payante.
 * Même contrat de retour et mêmes refus que le chemin Perplexity.
 */
export async function readProductPageFree({ url, lookupHost = defaultLookup, fetchImpl = fetch } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('URL invalide (doit commencer par http:// ou https://).');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('URL invalide : seuls les schémas http:// et https:// sont autorisés.');
  }

  /* Le garde SSRF compte ici aussi : r.jina.ai va chercher l'URL depuis SON
     réseau. Une adresse privée doit être refusée avant qu'un tiers n'en entende
     parler, exactement comme pour Wayback. */
  await assertHostIsPublic(parsedUrl, lookupHost);

  const texte = await fetchPageTextFree(parsedUrl.toString(), fetchImpl);

  // Le modèle configuré, gratuit dans les deux cas : Ollama en local, Groq en ligne.
  let raw;
  try {
    raw = await askModel({
      system: 'Tu extrais des données de fiches produit. Tu réponds uniquement en JSON valide, sans texte autour.',
      prompt: buildExtractionPrompt(parsedUrl.toString(), texte),
      maxTokens: 1200,
    });
  } catch (error) {
    throw new Error(`le modèle local n'a pas pu analyser la page : ${error?.message ?? error}`);
  }

  const objet = parseJsonFromModel(raw);
  /* On annonce la VRAIE provenance : « agent-perplexity » serait un mensonge
     dans le badge de l'import, et l'utilisateur doit savoir que la lecture
     vient d'un modèle local sur un texte tiers, pas d'un agent payant. */
  return normalizeAgentResult(objet, parsedUrl.toString(), {
    strategy: 'agent-gratuit',
    lecteur: 'r.jina.ai + modèle local',
  });
}

export async function readProductPageWithAgent({
  url,
  lookupHost = defaultLookup,
  fetchImpl = fetch,
} = {}) {
  /* SANS CLÉ PAYANTE, ON NE RENONCE PLUS. On bascule sur le lecteur gratuit
     (r.jina.ai + le modèle déjà configuré). Le nom de la fonction ne change pas :
     l'appelant n'a rien à savoir de la façon dont la page est lue.

     Ce que la bascule ne fait pas : elle ne CHERCHE pas la page ailleurs. Si
     l'URL elle-même est bloquée, elle échouera comme avant — mais avec un
     message clair, et sans exiger de clé. */
  if (!config.perplexity.ready || !config.perplexity.enabled) {
    return readProductPageFree({ url, lookupHost, fetchImpl });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('URL invalide (doit commencer par http:// ou https://).');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('URL invalide : seuls les schémas http:// et https:// sont autorisés.');
  }

  /* Garde SSRF, identique à celle du scraper avant de confier l'URL à Wayback
     ou Jina : Perplexity ira chercher l'URL depuis SON réseau, on refuse donc
     toute adresse privée avant qu'un tiers n'en entende jamais parler. */
  await assertHostIsPublic(parsedUrl, lookupHost);

  const prompt = buildPrompt(parsedUrl.toString());

  let response;
  try {
    response = await callAgent(prompt, fetchImpl);
    if (response.status === 429) {
      const retryAfterHeader = Number(response.headers?.get?.('retry-after'));
      const delayMs = Math.min(
        Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : 5000,
        MAX_RETRY_DELAY_MS,
      );
      await sleep(delayMs);
      response = await callAgent(prompt, fetchImpl);
    }
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`l'agent de lecture n'a pas répondu en ${AGENT_TIMEOUT_MS / 1000} s.`);
    }
    throw new Error(`impossible de contacter l'agent de lecture : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new Error(`authentification refusée (HTTP 401) — vérifie PERPLEXITY_API_KEY. Réponse : ${detail.slice(0, 300)}`);
    }
    if (response.status === 429) {
      throw new Error(`quota dépassé (HTTP 429), toujours saturé après un réessai. Réponse : ${detail.slice(0, 300)}`);
    }
    throw new Error(`erreur de l'agent de lecture (HTTP ${response.status}) : ${detail.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('réponse illisible : le corps de la réponse n\'était pas du JSON valide.');
  }

  const raw = extractFirstJsonObject(stripCodeFences(extractOutputText(payload)));
  return normalizeAgentResult(raw, parsedUrl.toString());
}
