import { config } from '../config/env.js';

/*
 * Recherche fournisseur réelle (Perplexity Agent API, outil web_search).
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
 * Requête REST directe (pas de SDK) : même convention que le reste de
 * src/ai/ (compatible-OpenAI via fetch, voir client.js askOpenAiCompatible),
 * et le projet est Node/Express — le SDK officiel Perplexity documenté par
 * l'utilisateur est Python (`pip install perplexityai`), inapplicable ici.
 */

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';
const REQUEST_TIMEOUT_MS = 30000;

function buildPrompt(title, sourcingHint) {
  const hint = String(sourcingHint || '').trim();
  return (
    `Trouve 2 à 3 fournisseurs B2B réels pour sourcer ce produit : "${String(title || '').trim()}"`
    + (hint ? `, piste de sourcing suggérée : ${hint}.` : '.')
    + ' Priorise des fournisseurs situés en Europe (délais et logistique plus courts) quand c\'est plausible pour ce type de produit, '
    + 'sans en inventer un s\'il n\'y en a manifestement pas.'
    + ' Une fiche d\'entreprise précise (site officiel d\'un fabricant ou grossiste) est préférable, mais si tu n\'en trouves aucune '
    + 'avec certitude, une page de CATÉGORIE d\'un vrai annuaire B2B reconnu (Europages, Kompass, Made-in-Europe…) pour ce type de '
    + 'produit est un résultat acceptable — mieux vaut ce repli honnête que rien du tout.'
    + ' Écris chaque URL en clair dans ta réponse (pas seulement en citation), au format Markdown [nom](url), pour qu\'elle reste '
    + 'lisible même si les citations structurées ne sont pas conservées.'
    + ' Jamais un lien de recherche Google ou Bing, jamais un nom d\'entreprise inventé : si vraiment rien de vérifiable n\'existe, dis-le.'
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

  let response;
  try {
    response = await fetch(`${PERPLEXITY_BASE_URL}/v1/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.perplexity.apiKey}`,
      },
      body: JSON.stringify({
        model: 'perplexity/sonar',
        input: buildPrompt(title, sourcingHint),
        tools: [{ type: 'web_search' }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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
      const retryAfter = response.headers.get('retry-after');
      throw new Error(
        `Quota Perplexity dépassé (HTTP 429)${retryAfter ? ` — réessaie dans ${retryAfter}s` : ''}. Réponse : ${detail.slice(0, 300)}`,
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
