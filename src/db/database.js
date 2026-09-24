import { createClient } from '@libsql/client';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/*
 * Une variable d'environnement saisie dans la mauvaise case, sur la plateforme
 * d'hébergement, produit sinon une erreur libsql qui ne dit pas d'où elle vient
 * (« The URL 'openai/gpt-oss-120b' is not in a valid format »). Le service
 * refuse alors de démarrer sans que rien n'indique QUELLE variable corriger :
 * c'est exactement ce qu'on cherche pendant dix minutes à 2 h du matin. Ces
 * deux contrôles nomment la variable fautive et la valeur reçue.
 */
const DATABASE_URL_PROTOCOLS = ['libsql:', 'https:', 'http:', 'ws:', 'wss:', 'file:'];

function assertDatabaseConfigIsCoherent() {
  const { url, authToken } = config.turso;

  if (process.env.TURSO_DATABASE_URL && !DATABASE_URL_PROTOCOLS.some((p) => url.startsWith(p))) {
    throw new Error(
      `TURSO_DATABASE_URL n'est pas une adresse de base valide : ${JSON.stringify(String(url).slice(0, 80))}. `
      + "Attendu : libsql://… (Turso), https://…, ou file:./data/megalomarket.db en local. "
      + "Cause la plus fréquente : les variables d'environnement de la plateforme sont décalées "
      + "et une valeur a été collée dans la mauvaise case. "
      + 'Pour redémarrer immédiatement, vide TURSO_DATABASE_URL : le service repartira sur une base locale.',
    );
  }

  const remote = url.startsWith('libsql:') || url.startsWith('http') || url.startsWith('ws');
  if (remote && !authToken) {
    throw new Error(
      'TURSO_DATABASE_URL pointe vers une base distante mais TURSO_AUTH_TOKEN est absente : '
      + 'la connexion sera refusée. Renseigne le jeton (turso db tokens create <base>), '
      + 'ou vide TURSO_DATABASE_URL pour utiliser une base locale.',
    );
  }
}

assertDatabaseConfigIsCoherent();

if (config.turso.url.startsWith('file:')) {
  mkdirSync(dirname(config.turso.url.slice('file:'.length)), { recursive: true });
}

export const client = createClient({
  url: config.turso.url,
  authToken: config.turso.authToken,
});

function toRows(result) {
  return result.rows.map((row) => Object.fromEntries(result.columns.map((col, i) => [col, row[i]])));
}

export async function dbAll(sql, args = []) {
  const result = await client.execute({ sql, args });
  return toRows(result);
}

export async function dbGet(sql, args = []) {
  const rows = await dbAll(sql, args);
  return rows[0];
}

export async function dbRun(sql, args = []) {
  const result = await client.execute({ sql, args });
  return {
    lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
    changes: result.rowsAffected,
  };
}

/**
 * SQLite ne sait pas modifier une contrainte CHECK en place : l'assouplir
 * impose de reconstruire la table. `CREATE TABLE IF NOT EXISTS` ne touche pas
 * une table déjà existante, donc les bases créées avant l'évolution ont besoin
 * de cette reconstruction explicite.
 *
 * `marker` est un fragment de la définition cible : s'il figure déjà dans le SQL
 * de la table, la migration a eu lieu et on ne fait rien. La reconstruction est
 * atomique (`batch` en mode write) : en cas d'échec, tout est annulé et
 * l'ancienne table reste en place, intacte.
 */
async function rebuildTableIfNeeded({ table, marker, createTable, columns, select }) {
  const existing = await dbGet(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  );
  if (!existing?.sql || existing.sql.includes(marker)) return false;

  const target = `${table}_migrated`;
  await client.batch(
    [
      // Une reconstruction interrompue laisserait la table temporaire derrière
      // elle ; on la reprend à zéro plutôt que d'échouer au redémarrage suivant.
      `DROP TABLE IF EXISTS ${target}`,
      createTable(target),
      `INSERT INTO ${target} (${columns.join(', ')}) SELECT ${select.join(', ')} FROM ${table}`,
      `DROP TABLE ${table}`,
      `ALTER TABLE ${target} RENAME TO ${table}`,
    ],
    'write',
  );
  return true;
}

/**
 * Ajoute une colonne à une table existante, une seule fois.
 *
 * SQLite ne connaît pas « ADD COLUMN IF NOT EXISTS » : rejouer l'ALTER au
 * démarrage suivant échoue sur « duplicate column name », ce qui empêcherait
 * tout redémarrage après le premier. On interroge donc PRAGMA table_info avant
 * d'agir — même esprit que rebuildTableIfNeeded, mais pour un simple ajout de
 * colonne, qui ne justifie pas de reconstruire la table (et n'y touche pas).
 */
async function addColumnIfMissing(table, column, definition) {
  const columns = await dbAll(`PRAGMA table_info(${table})`);
  if (columns.some((existing) => existing.name === column)) return false;
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/* Le canal own_site a été ajouté à import_listings.marketplace, en même temps
   que la colonne site_payload qui porte la fiche détaillée exigée par le site. */
async function migrateImportListings() {
  const migrated = await rebuildTableIfNeeded({
    table: 'import_listings',
    marker: 'own_site',
    createTable: (name) => `CREATE TABLE ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      marketplace TEXT NOT NULL CHECK (marketplace IN ('amazon', 'tiktok_shop', 'allegro', 'ebay', 'own_site')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      suggested_price REAL NOT NULL,
      site_payload TEXT,
      status TEXT NOT NULL DEFAULT 'a_valider' CHECK (status IN ('a_valider', 'valide', 'publie', 'echec')),
      published_external_id TEXT,
      publish_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (import_id, marketplace)
    )`,
    columns: [
      'id', 'import_id', 'marketplace', 'title', 'description', 'suggested_price', 'site_payload',
      'status', 'published_external_id', 'publish_error', 'created_at', 'updated_at',
    ],
    select: [
      'id', 'import_id', 'marketplace', 'title', 'description', 'suggested_price', 'NULL',
      'status', 'published_external_id', 'publish_error', 'created_at', 'updated_at',
    ],
  });

  if (migrated) {
    await logActivity('MIGRATION', "Table import_listings reconstruite : canal 'own_site' autorisé, colonne site_payload ajoutée.");
  }
  return migrated;
}

/* Le registre des connecteurs expose `allegro`, et import_listings l'acceptait
   déjà, mais channel_listings le refusait. Tant qu'Allegro n'était pas
   configuré le défaut restait invisible ; dès qu'il le serait, chaque
   synchronisation de stock aurait échoué sur cette contrainte, produit par
   produit. */
async function migrateChannelListings() {
  const migrated = await rebuildTableIfNeeded({
    table: 'channel_listings',
    marker: 'allegro',
    createTable: (name) => `CREATE TABLE ${name} (
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
    )`,
    columns: ['id', 'product_id', 'channel', 'external_id', 'price', 'description', 'stock', 'status', 'updated_at'],
    select: ['id', 'product_id', 'channel', 'external_id', 'price', 'description', 'stock', 'status', 'updated_at'],
  });

  if (migrated) {
    await logActivity('MIGRATION', "Table channel_listings reconstruite : canal 'allegro' autorisé.");
  }
  return migrated;
}

/* Le rattachement d'un import à un partenaire enregistré est une colonne
   ajoutée à une table existante : les bases créées avant cette évolution
   doivent la recevoir sans être reconstruites (les imports et leurs fiches
   sont des archives, on ne les recopie pas par plaisir). ON DELETE SET NULL
   laisse la suppression d'un partenaire détacher ses imports au lieu de les
   emporter ; la route DELETE détache elle aussi explicitement, pour pouvoir
   annoncer combien d'imports ont été conservés. */
async function migrateImportsSupplier() {
  const added = await addColumnIfMissing(
    'imports',
    'supplier_id',
    'INTEGER REFERENCES suppliers(id) ON DELETE SET NULL',
  );
  if (added) {
    await logActivity('MIGRATION', 'Colonne imports.supplier_id ajoutée : chaque import peut être rattaché à un partenaire enregistré.');
  }
  return added;
}

/* Coût et délai d'expédition d'un transporteur, saisis à la main (aucune API
   de cotation en temps réel n'est branchée ici — voir src/services/shipping.js).
   NULL tant que non renseigné : un transporteur sans coût connu est ignoré par
   la comparaison automatique plutôt que traité comme gratuit ou instantané. */
async function migrateSuppliersShipping() {
  const addedCost = await addColumnIfMissing('suppliers', 'shipping_cost', 'REAL');
  const addedDays = await addColumnIfMissing('suppliers', 'shipping_days', 'INTEGER');
  if (addedCost || addedDays) {
    await logActivity('MIGRATION', 'Colonnes suppliers.shipping_cost / shipping_days ajoutées : comparaison automatique des transporteurs.');
  }
  return addedCost || addedDays;
}

/* Piste de sourcing suggérée par le Dénicheur (type de fournisseur + région,
   priorité Europe) : colonne ajoutée après coup, les lots déjà générés
   avant cette évolution gardent une valeur vide plutôt que d'échouer. */
async function migrateTrendFindsSourcing() {
  const added = await addColumnIfMissing('trend_finds', 'sourcing_hint', "TEXT NOT NULL DEFAULT ''");
  if (added) {
    await logActivity('MIGRATION', 'Colonne trend_finds.sourcing_hint ajoutée : piste de sourcing (type de fournisseur, région) par suggestion.');
  }
  return added;
}

/* Résultat de l'agent superviseur (src/ai/nicheSupervisor.js), ajouté après
   coup : les lots générés avant cette évolution restent NULL (« jamais
   relus ») plutôt que d'échouer ou de prétendre un résultat. */
async function migrateTrendFindsReview() {
  const addedOk = await addColumnIfMissing('trend_finds', 'review_ok', 'INTEGER');
  const addedIssue = await addColumnIfMissing('trend_finds', 'review_issue', 'TEXT');
  if (addedOk || addedIssue) {
    await logActivity('MIGRATION', 'Colonnes trend_finds.review_ok / review_issue ajoutées : relecture par l\'agent superviseur du Dénicheur.');
  }
  return addedOk || addedIssue;
}

/* Contrôle qualité périodique des photos des fiches déjà publiées (voir
   services/qualitySupervisor.js, planifié toutes les 30 min) — répond au bug
   réel d'une photo sans rapport publiée sans qu'aucun contrôle ne le
   détecte. NULL tant qu'une fiche n'a pas encore été relue, y compris toutes
   celles publiées avant cette évolution : le superviseur les rattrape
   progressivement (voir BATCH_LIMIT), il n'y a rien à recalculer ici. */
async function migrateImportListingsQuality() {
  const addedAt = await addColumnIfMissing('import_listings', 'quality_checked_at', 'INTEGER');
  const addedOk = await addColumnIfMissing('import_listings', 'quality_ok', 'INTEGER');
  const addedIssue = await addColumnIfMissing('import_listings', 'quality_issue', 'TEXT');
  if (addedAt || addedOk || addedIssue) {
    await logActivity('MIGRATION', 'Colonnes import_listings.quality_checked_at / quality_ok / quality_issue ajoutées : contrôle qualité périodique des photos publiées.');
  }
  return addedAt || addedOk || addedIssue;
}

/* Le troisième type de partenaire — `transporteur` (transporteurs
   internationaux, transitaires, agents d'achat) — doit entrer dans la contrainte
   CHECK de `suppliers`. SQLite ne modifie pas un CHECK en place : il faut
   reconstruire la table, comme pour import_listings et channel_listings.

   `suppliers` est pourtant la PREMIÈRE table PARENT reconstruite ici : `imports`
   s'y rattache par `supplier_id … ON DELETE SET NULL`. Or `DROP TABLE` supprime
   implicitement toutes les lignes avant de supprimer la table, et cette
   suppression DÉCLENCHE l'action ON DELETE SET NULL : les imports rattachés
   seraient détachés en silence, alors même que les ids des partenaires sont
   recopiés à l'identique. Recopier les ids ne suffit donc PAS.

   Deux précautions, dans cet ordre :
     1. `PRAGMA foreign_keys = OFF` le temps de la reconstruction atomique — la
        procédure recommandée par SQLite pour modifier une table référencée —
        puis retour à ON dans un `finally` ;
     2. photographier les liens avant, et les réécrire après. Le point 1 suffit
        sur une connexion unique (fichier local, WebSocket), mais un client HTTP
        peut exécuter le PRAGMA et le lot sur deux connexions différentes ; le
        point 2 rend alors les liens à l'identique. Dans le cas nominal il ne
        réécrit que des valeurs déjà en place : rejouable sans danger.
*/
async function migrateSuppliersKinds() {
  const links = await dbAll('SELECT id, supplier_id FROM imports WHERE supplier_id IS NOT NULL');

  await client.execute('PRAGMA foreign_keys = OFF');
  let migrated;
  try {
    migrated = await rebuildTableIfNeeded({
      table: 'suppliers',
      // Marqueur propre à la nouvelle définition : l'ancien CHECK ne contient
      // pas « transporteur », une base à jour ne sera donc jamais reconstruite.
      marker: 'transporteur',
      createTable: (name) => `CREATE TABLE ${name} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('fournisseur', 'distributeur', 'transporteur')),
        name TEXT NOT NULL,
        site_url TEXT,
        margin_coefficient REAL,
        status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'inactif')),
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // Toutes les colonnes, recopiées telles quelles : ids, marges négociées,
      // statuts, notes et dates compris. Aucun NULL de complaisance.
      columns: ['id', 'kind', 'name', 'site_url', 'margin_coefficient', 'status', 'notes', 'created_at', 'updated_at'],
      select: ['id', 'kind', 'name', 'site_url', 'margin_coefficient', 'status', 'notes', 'created_at', 'updated_at'],
    });
  } finally {
    await client.execute('PRAGMA foreign_keys = ON');
  }

  if (!migrated) return false;

  /* Les ids des partenaires sont exactement les mêmes qu'avant la
     reconstruction : la correspondance (import → partenaire) est directe. Le
     lot est atomique, comme la reconstruction elle-même. */
  if (links.length > 0) {
    await client.batch(
      links.map((link) => ({
        sql: 'UPDATE imports SET supplier_id = ? WHERE id = ?',
        args: [link.supplier_id, link.id],
      })),
      'write',
    );
  }

  await logActivity(
    'MIGRATION',
    "Table suppliers reconstruite : type 'transporteur' autorisé, ids et rattachements d'imports conservés.",
  );
  return migrated;
}

/* Vérifie que la base branchée est bien celle de ce projet.
 *
 * Le réflexe naturel, quand on a déjà une base chez le même hébergeur, est de
 * la réutiliser. Ici ce serait fatal : le site BBVOLTEX possède lui aussi une
 * table `products` (et une table `orders`), avec des colonnes entièrement
 * différentes. Comme `CREATE TABLE IF NOT EXISTS` ne dit rien quand la table
 * existe déjà, la mauvaise base ne provoque aucune erreur au démarrage — elle
 * fait échouer les requêtes plus tard sur un « no such column: sku » qui
 * n'évoque jamais la vraie cause. Ce contrôle la nomme.
 */
async function assertSchemaIsOurs() {
  const columns = await dbAll('PRAGMA table_info(products)');
  if (columns.length === 0) return; // table absente : le schéma vient d'être créé

  const names = columns.map((column) => column.name);
  const missing = ['sku', 'cost_price'].filter((column) => !names.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `La base branchée n'est pas celle de Megalomarket : sa table products n'a pas les colonnes ${missing.join(', ')}. `
      + "Elle appartient probablement à un autre projet — le site BBVOLTEX a lui aussi une table products, aux colonnes différentes. "
      + 'Crée une base distincte pour Megalomarket et pointe TURSO_DATABASE_URL dessus, sans jamais réutiliser celle du site.',
    );
  }
}

export async function initDatabase() {
  await client.execute('PRAGMA foreign_keys = ON');
  const schemaSql = readFileSync(`${__dirname}/schema.sql`, 'utf8');
  await client.executeMultiple(schemaSql);
  // Avant les migrations : sur la mauvaise base elles ne trouvent rien à faire
  // et laisseraient passer le problème.
  await assertSchemaIsOurs();
  await migrateImportListings();
  await migrateChannelListings();
  // Après migrateImportsSupplier : la reconstruction de `suppliers` photographie
  // les liens imports.supplier_id, colonne que cette migration vient d'ajouter.
  await migrateImportsSupplier();
  await migrateSuppliersKinds();
  await migrateSuppliersShipping();
  await migrateTrendFindsSourcing();
  await migrateTrendFindsReview();
  await migrateImportListingsQuality();
}

export async function logActivity(kind, message) {
  await dbRun('INSERT INTO activity_log (kind, message, created_at) VALUES (?, ?, ?)', [kind, message, Date.now()]);
}
