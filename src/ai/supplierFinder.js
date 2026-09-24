import { config } from '../config/env.js';

/*
 * Recherche fournisseur réelle (Perplexity Agent API, outils web_search +
 * fetch_url).
 *
 * Remplace le bug signalé : le bouton "Chercher chez un fournisseur" du
 * Dénicheur renvoyait vers un site fixe (Alibaba), puis vers une recherche
 * Google générique — deux replis honnêtes mais qui n'étaient jamais un vrai
 * lien fournisseur. Cette fois l'agent va réellement chercher sur le web
 * (contrairement au chasseur de tendances, nicheHunter.js, qui n'a AUCUN
 * accès réseau) et revient avec des pages sourcées et vérifiables — des
 * candidats à vérifier soi-même, jamais une garantie d'exactitude : Perplexity
 * peut se tromper de fournisseur ou ne rien trouver, ce module ne prétend pas
 * l'inverse.
 *
 * Un premier passage (web_search seul) retombait souvent sur une page
 * d'accueil ou de catégorie de grossiste, sans le produit ni un prix
 * visible — un simple résultat de recherche, jamais lu en détail. Ouvrir
 * réellement chaque page candidate (au lieu de se fier au résumé de
 * recherche) demande de la lire, ce qui est nettement plus lourd pour le
 * fournisseur IA — observé en production : un modèle choisi à l'aveugle
 * ("perplexity/sonar", faute d'accès à la doc officielle pendant le
 * développement) saturait (HTTP 429 "upstream model overloaded") dès que
 * la consigne l'obligeait à ouvrir plusieurs pages. Le preset "pro-search"
 * — combinaison model+tools réglée par Perplexity elle-même, qui inclut
 * déjà la recherche web ET l'ouverture de page — remplace ce choix manuel.
 *
 * Requête REST directe (pas de SDK) : même convention que le reste de
 * src/ai/ (compatible-OpenAI via fetch, voir client.js askOpenAiCompatible),
 * et le projet est Node/Express — le SDK officiel Perplexity documenté par
 * l'utilisateur est Python (`pip install perplexityai`), inapplicable ici.
 */

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';
const REQUEST_TIMEOUT_MS = 55000;
// Un seul réessai : un 429 "overloaded" est presque toujours transitoire
// (quelques secondes), mais laisser l'utilisateur cliquer indéfiniment sur
// "Réessayer" pour un problème que le serveur peut absorber lui-même serait
// une friction inutile. Le délai suggéré par Perplexity (Retry-After) est
// respecté, borné pour ne pas bloquer la requête HTTP entrante trop longtemps.
const MAX_RETRY_DELAY_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function buildPrompt(title, sourcingHint) {
  const hint = String(sourcingHint || '').trim();
  return (
    `Trouve 1 à 3 FICHES PRODUIT précises (pas une page d'accueil ni une page de catégorie générique) `
    + `pour sourcer ce produit : "${String(title || '').trim()}"`
    + (hint ? `, piste de sourcing suggérée : ${hint}.` : '.')
    + ' Priorise des fournisseurs situés en Europe (délais et logistique plus courts) quand c\'est plausible pour ce type de produit, '
    + 'sans en inventer un s\'il n\'y en a manifestement pas.'
    + ' Pour CHAQUE candidat trouvé par recherche web, utilise l\'outil d\'ouverture de page pour la consulter réellement et confirmer '
    + 'qu\'elle affiche bien CE produit (ou un équivalent direct) ET un prix visible, AVANT de la proposer.'
    + ' N\'inclus JAMAIS une page d\'accueil, une page de catégorie, ou une page où tu n\'as pas pu confirmer un prix visible en l\'ouvrant '
    + '— dans ce cas, dis-le franchement plutôt que de proposer un résultat vague. Mieux vaut 0 résultat qu\'un résultat imprécis.'
    + ' Écris chaque résultat confirmé en Markdown [nom du fournisseur — prix constaté sur la page](url), le prix étant celui que tu as '
    + 'réellement vu en ouvrant la page, pas une estimation.'
    + ' Jamais un lien de recherche Google ou Bing, jamais un nom d\'entreprise inventé.'
  );
}

/* google.com/search, bing.com/search... : exactement le genre de lien que
   cette fonctionnalité existe pour remplacer. Un filet de sécurité au cas où
   le modèle en citerait un dans son texte malgré la consigne. */
const SEARCH_ENGINE_HOST_RE = /(^|\.)google\.[a-z.]+$|(^|\.)bing\.com$|(^|\.)duckduckgo\.com$/i;

function isSearchEngineUrl(url) {
  try {
    return SEARCH_ENGINE_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/* Le texte de réponse peut arriver sous deux formes selon la variante de
   l'API (voir docs.perplexity.ai/docs/agent-api/output-control) : la
   commodité `output_text`, ou à défaut le tableau `output` détaillé. */
function extractOutputText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text) return payload.output_text;
  const messages = Array.isArray(payload.output) ? payload.output : [];
  return messages
    .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
    .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)<>\]"']+/g;

/* Filet de sécurité au cas où la forme exacte de citations/search_results
   documentée diffère de ce qui arrive réellement (egress bloqué vers
   docs.perplexity.ai pendant le développement — le format exact des champs
   n'a pas pu être vérifié mot pour mot, seulement recoupé via des sources
   tierces). Le prompt demande aussi des URL en clair au format Markdown
   pour cette raison : une extraction par texte fonctionne quel que soit le
   nom exact du champ structuré. */
function extractLinksFromText(text, links) {
  if (!text) return;
  let match;
  MARKDOWN_LINK_RE.lastIndex = 0;
  while ((match = MARKDOWN_LINK_RE.exec(text))) {
    const [, label, url] = match;
    if (!isSearchEngineUrl(url) && !links.has(url)) links.set(url, label);
  }
  BARE_URL_RE.lastIndex = 0;
  while ((match = BARE_URL_RE.exec(text))) {
    const url = match[0].replace(/[.,;:)\]]+$/, '');
    if (!isSearchEngineUrl(url) && !links.has(url)) links.set(url, url);
  }
}

/* Trois sources de liens, jamais toutes garanties présentes : `search_results`
   (métadonnées de source au niveau racine), les `annotations` de citation
   portées par chaque bloc de texte, et les URL écrites en clair dans le
   texte lui-même (voir extractLinksFromText). Fusionnées et dédupliquées par
   URL, les deux premières sources (mieux labellisées) passent en premier. */
function extractLinks(payload) {
  const links = new Map();
  if (Array.isArray(payload.search_results)) {
    for (const result of payload.search_results) {
      if (result?.url && !isSearchEngineUrl(result.url)) links.set(result.url, result.title || result.url);
    }
  }
  const messages = Array.isArray(payload.output) ? payload.output : [];
  for (const message of messages) {
    for (const content of (Array.isArray(message?.content) ? message.content : [])) {
      for (const annotation of (Array.isArray(content?.annotations) ? content.annotations : [])) {
        if (annotation?.url && !isSearchEngineUrl(annotation.url)) links.set(annotation.url, annotation.title || annotation.url);
      }
      extractLinksFromText(content?.text, links);
    }
  }
  extractLinksFromText(payload.output_text, links);
  return [...links.entries()].map(([url, label]) => ({ url, label }));
}

async function callAgent(prompt) {
  return fetch(`${PERPLEXITY_BASE_URL}/v1/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.perplexity.apiKey}`,
    },
    body: JSON.stringify({
      preset: 'pro-search',
      input: prompt,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Cherche de vrais fournisseurs pour un produit + une piste de sourcing.
 * Lève une erreur explicite (clé absente, HTTP en échec, réponse illisible)
 * plutôt que de retourner un résultat vide silencieux — l'appelant doit
 * pouvoir distinguer « rien trouvé » d'« la recherche n'a pas pu avoir lieu ».
 */
export async function findSupplierLinks({ title, sourcingHint } = {}) {
  if (!config.perplexity.ready) {
    throw new Error(
      "PERPLEXITY_API_KEY manquante — impossible de chercher un vrai fournisseur sans elle. "
      + 'Crée une clé sur console.perplexity.ai et renseigne-la dans les variables d\'environnement.',
    );
  }
  if (!String(title || '').trim()) throw new Error('Titre du produit manquant.');

  const prompt = buildPrompt(title, sourcingHint);

  let response;
  try {
    response = await callAgent(prompt);
    if (response.status === 429) {
      // Un seul réessai, après le délai suggéré par Perplexity (borné) : la
      // surcharge du modèle upstream est presque toujours passagère.
      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const delayMs = Math.min(
        Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : 5000,
        MAX_RETRY_DELAY_MS,
      );
      await sleep(delayMs);
      response = await callAgent(prompt);
    }
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`Perplexity Agent API injoignable : aucune réponse en ${REQUEST_TIMEOUT_MS / 1000} s.`);
    }
    throw new Error(`Impossible de contacter Perplexity Agent API : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new Error(`Authentification refusée (HTTP 401) — vérifie PERPLEXITY_API_KEY. Réponse : ${detail.slice(0, 300)}`);
    }
    if (response.status === 429) {
      throw new Error(
        `Quota Perplexity dépassé (HTTP 429), toujours saturé après un premier réessai. Réponse : ${detail.slice(0, 300)}`,
      );
    }
    throw new Error(`Erreur Perplexity Agent API (HTTP ${response.status}) : ${detail.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Réponse Perplexity illisible : le corps de la réponse n\'était pas du JSON valide.');
  }

  return { links: extractLinks(payload), outputText: extractOutputText(payload) };
}
