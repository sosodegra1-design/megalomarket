import { askVision, parseJsonFromModel } from './client.js';

/*
 * Agent 3a — contrôle visuel des images d'une fiche produit.
 *
 * Rejette une image plutôt que de deviner : un lien mort, un type MIME qui
 * n'est pas une image, ou une image trop volumineuse font échouer TOUT le
 * lot (overallOk: false), car publier avec une photo cassée ou non vérifiée
 * serait pire qu'un brouillon en attente.
 */

const MAX_IMAGES = 6; // borne le coût et la taille de la requête vision
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 Mo, large marge sous les limites Anthropic
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const FETCH_TIMEOUT_MS = 15000;

async function fetchImageAsBase64(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`image injoignable (délai dépassé) : ${url}`);
    }
    throw new Error(`image injoignable (${error?.message ?? error}) : ${url}`);
  }
  if (!response.ok) {
    throw new Error(`image inaccessible (HTTP ${response.status}) : ${url}`);
  }
  const mediaType = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`type d'image non supporté (${mediaType || 'inconnu'}) : ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`image trop volumineuse (> 5 Mo) : ${url}`);
  }
  return { media_type: mediaType, data: buffer.toString('base64') };
}

const SYSTEM_PROMPT = `Tu es contrôleur qualité e-commerce, spécialisé dans la vérification des photos de fiches produit.
Réponds UNIQUEMENT avec un objet JSON valide, au format exact :
{"images":[{"index":0,"relevant":true,"quality":"ok","issue":null}],"overallOk":true,"summary":"..."}
Pour chaque image, dans l'ordre fourni :
- "relevant" : correspond-elle vraiment au produit décrit par le titre (pas une image d'illustration générique ou d'un autre article) ?
- "quality" : "ok", ou l'un de "flou", "fond_charge" (fond qui nuit à la lisibilité produit, pas neutre), "basse_resolution", "trompeuse" (angle ou montage qui induit en erreur sur le produit réel).
- "issue" : une phrase courte expliquant le problème si quality != "ok" ou relevant == false, sinon null.
"overallOk" est true UNIQUEMENT si TOUTES les images sont "relevant": true ET "quality": "ok". Sois strict : dans le doute, fais échouer plutôt que de valider.
"summary" : un résumé d'une phrase de ton verdict global, en français.`;

/** Analyse jusqu'à MAX_IMAGES images. Une image injoignable/invalide fait échouer tout le lot, sans appel au modèle. */
export async function inspectImages({ title, imageUrls }) {
  const urls = Array.isArray(imageUrls) ? imageUrls.filter((u) => typeof u === 'string' && u.trim()) : [];
  if (!urls.length) {
    return { overallOk: false, images: [], summary: 'Aucune image fournie — impossible de vérifier ce qui n\'existe pas.' };
  }

  const limited = urls.slice(0, MAX_IMAGES);
  const fetched = [];
  const fetchErrors = [];
  for (const [index, url] of limited.entries()) {
    try {
      fetched.push({ index, ...(await fetchImageAsBase64(url)) });
    } catch (error) {
      fetchErrors.push(`Image ${index + 1} : ${error.message}`);
    }
  }
  if (fetchErrors.length) {
    return { overallOk: false, images: [], summary: `Image(s) invalide(s) ou injoignable(s) :\n${fetchErrors.join('\n')}` };
  }

  // askVision peut échouer avant tout appel réseau (ANTHROPIC_API_KEY absente)
  // ou pendant (fournisseur injoignable) — dans les deux cas, ce n'est PAS une
  // exception à laisser remonter jusqu'à la route : c'est un contrôle qui n'a
  // pas pu s'exécuter, donc un échec de contrôle comme un autre (le pipeline
  // doit basculer en brouillon, pas planter avec une erreur 400 générique).
  let raw;
  try {
    raw = await askVision({
      system: SYSTEM_PROMPT,
      prompt: `Titre du produit : ${title}\n\nAnalyse les ${fetched.length} image(s) fournies, dans l'ordre.`,
      images: fetched.map((f) => ({ source: { type: 'base64', media_type: f.media_type, data: f.data } })),
      maxTokens: 800,
    });
  } catch (error) {
    return { overallOk: false, images: [], summary: error.message };
  }

  let parsed;
  try {
    parsed = parseJsonFromModel(raw);
  } catch {
    return { overallOk: false, images: [], summary: `Réponse IA non exploitable (analyse image) : ${raw.slice(0, 200)}` };
  }

  const images = Array.isArray(parsed.images) ? parsed.images : [];
  const allPass = images.length === fetched.length && images.every((i) => i && i.relevant === true && i.quality === 'ok');
  return {
    overallOk: Boolean(parsed.overallOk) && allPass,
    images,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}
