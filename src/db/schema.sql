CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cost_price REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('ebay', 'own_site', 'amazon', 'tiktok_shop')),
  external_id TEXT,
  price REAL NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  stock INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'out_of_stock')),
  updated_at INTEGER NOT NULL,
  UNIQUE (product_id, channel)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  UNIQUE (channel, external_order_id)
);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('price', 'description', 'support')),
  channel TEXT,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  source_site TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_description TEXT NOT NULL DEFAULT '',
  purchase_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  image_urls TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'brouillon' CHECK (status IN ('brouillon', 'pret')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS import_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('amazon', 'tiktok_shop', 'allegro', 'ebay', 'own_site')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggested_price REAL NOT NULL,
  -- Fiche complète destinée au site propre, en JSON : celui-ci exige catégorie,
  -- univers, âge, clé d'icône et libellés bilingues, que les marketplaces ne
  -- demandent pas. NULL tant qu'aucune fiche détaillée n'a été préparée.
  site_payload TEXT,
  status TEXT NOT NULL DEFAULT 'a_valider' CHECK (status IN ('a_valider', 'valide', 'publie', 'echec')),
  published_external_id TEXT,
  publish_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (import_id, marketplace)
);
