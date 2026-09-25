import { config } from '../config/env.js';
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
function normalizeAgentResult(raw, url) {
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
    `Fiche lue par un agent web (Perplexity), pas extraite du code source de la page — à vérifier avant publication.`,
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
    imageUrls,
    strategy: 'agent-perplexity',
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
export async function readProductPageWithAgent({
  url,
  lookupHost = defaultLookup,
  fetchImpl = fetch,
} = {}) {
  if (!config.perplexity.ready) {
    throw new Error(
      'PERPLEXITY_API_KEY manquante — impossible de faire lire la page par un agent. '
      + 'Renseigne la clé, ou passe par la saisie manuelle.',
    );
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
