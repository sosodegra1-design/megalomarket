import 'dotenv/config';

function has(...keys) {
  return keys.every((k) => !!process.env[k]);
}

// Modèle Anthropic par défaut. Une constante (et non une chaîne recopiée) pour
// que config.anthropicModel et config.ai.model ne puissent pas diverger.
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

/**
 * Fournisseur IA effectif, résolu à chaque lecture (un test ou un redémarrage
 * peut changer les variables d'environnement) :
 *   1. un AI_PROVIDER explicite gagne toujours — une valeur inconnue est
 *      traitée comme « non configuré » plutôt que devinée en silence ;
 *   2. sinon Anthropic dès qu'une clé existe : les installations actuelles
 *      continuent de fonctionner sans rien changer ;
 *   3. sinon « openai » si la base ET la clé sont renseignées.
 */
function resolveAiProvider() {
  const explicit = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;
  if (explicit) return null;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) return 'openai';
  return null;
}

/**
 * Raison, en français, pour laquelle l'IA n'est pas utilisable — ou null si
 * elle l'est. Un couple ready/reason (plutôt qu'un simple booléen) permet à
 * l'appelant de nommer précisément la variable manquante : « IA non
 * configurée » n'aide personne à réparer.
 */
function aiNotReadyReason() {
  const explicit = (process.env.AI_PROVIDER || '').trim();
  if (explicit && explicit.toLowerCase() !== 'anthropic' && explicit.toLowerCase() !== 'openai') {
    return `AI_PROVIDER="${explicit}" inconnu — valeurs acceptées : "anthropic" ou "openai".`;
  }

  const provider = resolveAiProvider();
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY
      ? null
      : "Fournisseur IA « anthropic » sélectionné mais ANTHROPIC_API_KEY est manquante — renseigne-la dans .env.";
  }

  if (provider === 'openai') {
    // AI_MODEL n'a volontairement aucun défaut : il n'existe pas de nom de
    // modèle commun à Groq, Cerebras, OpenRouter, Gemini et Ollama, et un
    // défaut inventé ferait échouer chaque appel avec une erreur obscure.
    const missing = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'].filter((k) => !process.env[k]);
    if (missing.length) {
      return (
        `Fournisseur IA « openai » sélectionné mais ${missing.join(', ')} manque(nt) dans .env — ` +
        "AI_MODEL est obligatoire : indique le modèle exact de ton fournisseur."
      );
    }
    return null;
  }

  return (
    'Aucun fournisseur IA configuré — renseigne soit ANTHROPIC_API_KEY (Anthropic), ' +
    'soit AI_BASE_URL + AI_API_KEY + AI_MODEL (tout fournisseur compatible OpenAI : ' +
    'Groq, Cerebras, OpenRouter, Gemini, Ollama local…).'
  );
}

export const config = {
  port: Number(process.env.PORT) || 3000,

  turso: {
    url: process.env.TURSO_DATABASE_URL || `file:${process.env.DATABASE_PATH || './data/megalomarket.db'}`,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  },

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,

  // Modèle utilisé pour toutes les fonctions IA. Configurable pour ne pas
  // dépendre d'un déploiement le jour où un modèle est retiré : Anthropic
  // annonce ces retraits à l'avance (claude-sonnet-4-5, le précédent choix,
  // n'était plus garanti au-delà du 29 septembre 2026) et changer une variable
  // d'environnement est plus rapide qu'une modification de code.
  anthropicModel: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,

  // Fournisseur IA : Anthropic, ou n'importe quel service « compatible
  // OpenAI ». Ce n'est pas un détail de confort — l'IA était branchée sur un
  // seul vendeur, donc un changement de prix, un modèle retiré ou un compte
  // sans crédit faisait tomber TOUTES les fonctions IA d'un coup. Groq,
  // Cerebras, OpenRouter, Gemini et Ollama local exposent tous la même route
  // /chat/completions : un seul adaptateur les couvre, ce qui laisse le choix
  // du fournisseur (et de son prix) au propriétaire sans toucher au code.
  ai: {
    get provider() {
      return resolveAiProvider();
    },
    // Base de l'API compatible OpenAI, sans slash final propre : l'adaptateur
    // le retire avant de composer l'URL.
    get baseUrl() {
      return process.env.AI_BASE_URL || null;
    },
    get apiKey() {
      return process.env.AI_API_KEY || null;
    },
    // Modèle effectif. En Anthropic on retombe sur le modèle historique ; en
    // compatible OpenAI il n'y a pas de défaut universel possible.
    get model() {
      return resolveAiProvider() === 'anthropic'
        ? process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL
        : process.env.AI_MODEL || null;
    },
    get ready() {
      return aiNotReadyReason() === null;
    },
    get reason() {
      return aiNotReadyReason();
    },
  },

  // Clé partagée protégeant l'ensemble du service : routes d'API, module
  // d'import et tableau de bord. Lue via un getter, donc à chaque requête —
  // c'est ce qui permet de vérifier le comportement « échec en fermé » quand
  // elle n'est pas configurée.
  admin: {
    get apiKey() {
      return process.env.ADMIN_API_KEY || null;
    },
  },

  ebay: {
    env: process.env.EBAY_ENV || 'production',
    appId: process.env.EBAY_APP_ID || null,
    certId: process.env.EBAY_CERT_ID || null,
    devId: process.env.EBAY_DEV_ID || null,
    refreshToken: process.env.EBAY_REFRESH_TOKEN || null,
    // Optionnel : requis par certains comptes eBay pour la création d'offre (createListing).
    merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY || null,
    get ready() {
      return has('EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_DEV_ID', 'EBAY_REFRESH_TOKEN');
    },
  },

  ownSite: {
    apiUrl: process.env.OWN_SITE_API_URL || null,
    apiKey: process.env.OWN_SITE_API_KEY || null,
    get ready() {
      return has('OWN_SITE_API_URL', 'OWN_SITE_API_KEY');
    },
  },

  amazon: {
    refreshToken: process.env.AMAZON_REFRESH_TOKEN || null,
    clientId: process.env.AMAZON_CLIENT_ID || null,
    clientSecret: process.env.AMAZON_CLIENT_SECRET || null,
    sellerId: process.env.AMAZON_SELLER_ID || null,
    get ready() {
      return has('AMAZON_REFRESH_TOKEN', 'AMAZON_CLIENT_ID', 'AMAZON_CLIENT_SECRET', 'AMAZON_SELLER_ID');
    },
  },

  tiktokShop: {
    appKey: process.env.TIKTOKSHOP_APP_KEY || null,
    appSecret: process.env.TIKTOKSHOP_APP_SECRET || null,
    accessToken: process.env.TIKTOKSHOP_ACCESS_TOKEN || null,
    shopId: process.env.TIKTOKSHOP_SHOP_ID || null,
    get ready() {
      return has('TIKTOKSHOP_APP_KEY', 'TIKTOKSHOP_APP_SECRET', 'TIKTOKSHOP_ACCESS_TOKEN', 'TIKTOKSHOP_SHOP_ID');
    },
  },

  allegro: {
    clientId: process.env.ALLEGRO_CLIENT_ID || null,
    clientSecret: process.env.ALLEGRO_CLIENT_SECRET || null,
    refreshToken: process.env.ALLEGRO_REFRESH_TOKEN || null,
    get ready() {
      return has('ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET', 'ALLEGRO_REFRESH_TOKEN');
    },
  },

  // Coefficient de marge et frais fixes utilisés pour calculer le prix de vente conseillé
  // lors de l'import produit (prix suggéré = prix d'achat * coefficient + frais fixes,
  // jamais en dessous de prix d'achat + frais fixes).
  pricing: {
    marginCoefficient: Number(process.env.PRICING_MARGIN_COEFFICIENT) || 1.8,
    fixedFee: Number(process.env.PRICING_FIXED_FEE) || 0,
  },
};
