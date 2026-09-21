import 'dotenv/config';

function has(...keys) {
  return keys.every((k) => !!process.env[k]);
}

export const config = {
  port: Number(process.env.PORT) || 3000,

  turso: {
    url: process.env.TURSO_DATABASE_URL || `file:${process.env.DATABASE_PATH || './data/megalomarket.db'}`,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  },

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,

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
