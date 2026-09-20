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

  ebay: {
    env: process.env.EBAY_ENV || 'production',
    appId: process.env.EBAY_APP_ID || null,
    certId: process.env.EBAY_CERT_ID || null,
    devId: process.env.EBAY_DEV_ID || null,
    refreshToken: process.env.EBAY_REFRESH_TOKEN || null,
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
};
