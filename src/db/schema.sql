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
  channel TEXT NOT NULL CHECK (channel IN ('ebay', 'own_site', 'amazon', 'tiktok_shop', 'allegro')),
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

-- Partenaires (plateformes de gros, distributeurs locaux, transporteurs
-- internationaux…) enregistrés une fois pour toutes, afin qu'un import se
-- rattache à une fiche au lieu d'un texte retapé. margin_coefficient NULL est
-- volontaire et signifie « utiliser le coefficient global » : un fournisseur
-- sans marge négociée n'a pas de marge propre, et confondre les deux ferait
-- disparaître la distinction. Pour un transporteur la colonne garde la même
-- signification technique mais n'a pas de sens métier : un transporteur vend un
-- service, pas une marchandise — voir le commentaire de carrier-catalogue.js.
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('fournisseur', 'distributeur', 'transporteur')),
  name TEXT NOT NULL,
  site_url TEXT,
  margin_coefficient REAL,
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'inactif')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Distributeurs : entreprises à qui Megalomarket vend en gros (aval), à ne pas
-- confondre avec le `kind = 'distributeur'` de la table `suppliers`, qui
-- désigne une plateforme de sourcing (amont, on y achète). Table séparée
-- car la relation est inverse : pas de marge à négocier, pas d'import
-- rattaché — juste un carnet de contacts commerciaux.
CREATE TABLE IF NOT EXISTS distributors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_email TEXT,
  region TEXT,
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'inactif')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Lots de suggestions générées par l'agent « chasseur de pépites » (voir
-- src/ai/nicheHunter.js). batch_id regroupe les 20 lignes d'une même
-- génération ; l'historique des lots précédents est conservé.
CREATE TABLE IF NOT EXISTS trend_finds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  target_audience TEXT NOT NULL DEFAULT '',
  price_range TEXT NOT NULL DEFAULT '',
  sourcing_hint TEXT NOT NULL DEFAULT '',
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
  -- Partenaire d'où vient l'import, quand il a été choisi à l'extraction.
  -- ON DELETE SET NULL : retirer un partenaire ne doit jamais effacer l'import
  -- (ni ses fiches, ni l'historique des publications) — voir la route DELETE.
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
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

-- Traçabilité de la chaîne Dénicheur -> Rédacteur -> Tarification/Logistique
-- -> Inspecteur qualité (voir src/routes/pipeline.js). Chaque ligne est UNE
-- exécution : soit publiée automatiquement (tous les contrôles ont passé),
-- soit mise en brouillon avec le rapport détaillé de ce qui a échoué —
-- jamais publiée à moitié. report est un JSON {steps:[{agent, ok, detail/error}, ...]}.
-- purchase_price est le coût d'achat fournisseur ; sell_price le prix de
-- vente calculé automatiquement (coût x3 minimum, voir src/services/pricing.js) ;
-- net_margin = sell_price - purchase_price - shipping_cost.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_url TEXT,
  image_urls TEXT NOT NULL DEFAULT '[]',
  purchase_price REAL,
  sell_price REAL,
  shipping_carrier TEXT,
  shipping_cost REAL,
  net_margin REAL,
  category TEXT,
  seo_title TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'brouillon' CHECK (status IN ('publie', 'brouillon')),
  report TEXT NOT NULL DEFAULT '{}',
  published_product_id TEXT,
  published_url TEXT,
  created_at INTEGER NOT NULL
);
