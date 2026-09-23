import crypto from 'node:crypto';
import { config } from '../config/env.js';

/**
 * Authentification unique du service.
 *
 * Megalomarket n'est pas une boutique publique : c'est un back-office qui
 * expose les commandes clients, le catalogue, le journal d'activité et — le
 * plus grave — des routes capables de publier sur les marketplaces et sur le
 * site. Aucune de ses routes n'était protégée : `POST
 * /api/imports/:id/listings/own_site/publish` était donc joignable par
 * n'importe qui et publiait pour de bon.
 *
 * Seule exception : `/api/health`, laissé public parce qu'il ne divulgue rien
 * et qu'il sert à la surveillance (le plan gratuit Render s'endort, un ping
 * externe doit pouvoir le réveiller sans détenir la clé).
 *
 * Trois façons de présenter la clé, pour couvrir les deux usages :
 *   - `X-Admin-Key: <clé>`      scripts, curl, intégrations
 *   - `Authorization: Bearer <clé>`   idem, plus standard
 *   - `Authorization: Basic <base64(user:clé)>`   navigateur
 *
 * Le mode Basic n'est pas un gadget : le navigateur affiche sa boîte de
 * dialogue native, met les identifiants en cache, puis les renvoie sur chaque
 * requête — y compris celles que le tableau de bord déclenche en JavaScript.
 * Le futur tableau de bord n'aura donc aucune page de connexion à gérer.
 */

/* Comparaison à durée constante : comparer avec === laisserait fuir, par le
   temps de réponse, le nombre de caractères corrects du début de la clé.
   timingSafeEqual exige des tampons de même longueur, d'où le test préalable —
   qui, lui, ne révèle que la longueur. */
function safeEqual(presented, expected) {
  const left = Buffer.from(String(presented));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function presentedSecret(req) {
  const headerKey = req.get('x-admin-key');
  if (headerKey) return headerKey;

  const authorization = (req.get('authorization') || '').trim();

  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) return bearer[1];

  const basic = /^Basic\s+(.+)$/i.exec(authorization);
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator !== -1) return decoded.slice(separator + 1);
  }

  return null;
}

/* Le webhook Sendcloud ne peut évidemment pas présenter ADMIN_API_KEY — il
   est protégé autrement (signature HMAC vérifiée dans routes/orders.js,
   voir services/sendcloud.js:verifyWebhookSignature), pas par ce
   middleware. */
const PUBLIC_PATHS = new Set(['/api/health', '/api/orders/sendcloud/webhook']);

export function requireAdmin(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const expected = config.admin.apiKey;

  /* Échec en fermé. Le défaut dangereux serait « pas de clé configurée, donc
     pas de contrôle » : une variable oubliée lors d'un déploiement ouvrirait
     alors tout le back-office, y compris la publication. Ici, l'absence de clé
     ferme le service au lieu de l'ouvrir. */
  if (!expected) {
    return res.status(503).json({
      error: "Service verrouillé : ADMIN_API_KEY n'est pas configurée sur le serveur.",
    });
  }

  const presented = presentedSecret(req);
  if (!presented || !safeEqual(presented, expected)) {
    /* L'en-tête WWW-Authenticate est ce qui déclenche la boîte de dialogue du
       navigateur : sans lui, un accès direct au tableau de bord afficherait un
       JSON 401 au lieu de demander les identifiants. */
    res.set('WWW-Authenticate', 'Basic realm="Megalomarket AI Core", charset="UTF-8"');
    return res.status(401).json({ error: 'Clé d’accès absente ou invalide.' });
  }

  return next();
}
