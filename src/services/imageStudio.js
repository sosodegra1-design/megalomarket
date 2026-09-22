import { createHash } from 'node:crypto';
import { config } from '../config/env.js';

/*
 * Studio photo (Agent 2 — traitement visuel du pipeline).
 *
 * Envoie une image source (URL brute, fournisseur ou collée à la main) vers
 * Cloudinary, qui l'héberge de façon PERMANENTE (contrairement au disque du
 * serveur, effacé à chaque redéploiement — voir la config "base locale" du
 * reste de l'app) et expose une version "studio" — fond détouré et
 * uniformisé (blanc par défaut) — générée à la volée par transformation
 * d'URL et mise en cache par le CDN Cloudinary dès la première requête.
 *
 * N'embellit PAS l'image au sens retouche fine (netteté, colorimétrie) :
 * seul le détourage/fond est fait ici, car c'est la seule transformation
 * demandée qui ait un besoin réel d'uniformité sur tout le catalogue. Une
 * netteté ou une balance des couleurs mal réglées à la source restent
 * telles quelles — les corriger à l'aveugle risquerait de dénaturer la
 * vraie couleur du produit.
 */

const UPLOAD_TIMEOUT_MS = 30000;

export function isImageStudioConfigured() {
  return config.cloudinary.ready;
}

function requireConfigured() {
  if (!isImageStudioConfigured()) {
    throw new Error(
      "Studio photo indisponible : CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY et CLOUDINARY_API_SECRET doivent tous être configurés.",
    );
  }
}

/* Signature Cloudinary : SHA1 des paramètres à signer, triés par clé et
   concaténés en "clé=valeur", suivis directement du secret (jamais envoyé
   lui-même dans la requête). file/cloud_name/api_key/resource_type ne font
   jamais partie de la signature — c'est la règle Cloudinary, pas un choix
   arbitraire d'implémentation ici. */
function signParams(params) {
  const sorted = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
  return createHash('sha1').update(sorted + config.cloudinary.apiSecret).digest('hex');
}

async function uploadFromUrl(sourceUrl) {
  requireConfigured();
  if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
    throw new Error('URL source manquante pour le studio photo.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'megalomarket-studio';
  const signature = signParams({ timestamp, folder });

  const form = new URLSearchParams();
  form.set('file', sourceUrl.trim());
  form.set('timestamp', String(timestamp));
  form.set('api_key', config.cloudinary.apiKey);
  form.set('signature', signature);
  form.set('folder', folder);

  let response;
  try {
    response = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/image/upload`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`Cloudinary injoignable (délai dépassé) pour : ${sourceUrl}`);
    }
    throw new Error(`Impossible de contacter Cloudinary pour ${sourceUrl} : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Cloudinary a refusé l'image ${sourceUrl} (HTTP ${response.status}) : ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  if (!data.public_id) {
    throw new Error(`Réponse Cloudinary inattendue pour ${sourceUrl} : aucun public_id renvoyé.`);
  }
  return data.public_id;
}

/* URL "studio" : détourage IA (add-on Background Removal de Cloudinary, doit
   être activé sur le compte) puis aplatissement sur un fond uni — générée à
   la volée, jamais stockée séparément. `backgroundColor` suit la syntaxe
   Cloudinary ("white", "black", un hex sans # via "rgb:ffffff"...). */
function studioUrl(publicId, { backgroundColor = 'white' } = {}) {
  return `https://res.cloudinary.com/${config.cloudinary.cloudName}/image/upload/`
    + `e_background_removal/b_${backgroundColor},f_jpg,q_auto/${publicId}`;
}

/** Traite une image source (upload + détourage/fond uni) et retourne son URL studio prête à publier. */
export async function processProductImage(sourceUrl, options = {}) {
  const publicId = await uploadFromUrl(sourceUrl);
  return studioUrl(publicId, options);
}

/**
 * Traite plusieurs images. Chaque échec reste local à son image (URL
 * source conservée en secours) plutôt que de faire échouer tout le lot —
 * une seule photo cassée ne doit pas priver les autres du traitement.
 */
export async function processProductImages(sourceUrls, options = {}) {
  const urls = Array.isArray(sourceUrls) ? sourceUrls.filter((u) => typeof u === 'string' && u.trim()) : [];
  const results = [];
  for (const sourceUrl of urls) {
    try {
      const url = await processProductImage(sourceUrl, options);
      results.push({ sourceUrl, studioUrl: url, ok: true });
    } catch (error) {
      results.push({ sourceUrl, studioUrl: sourceUrl, ok: false, error: error.message });
    }
  }
  return results;
}
