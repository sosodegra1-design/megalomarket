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
}

export async function logActivity(kind, message) {
  await dbRun('INSERT INTO activity_log (kind, message, created_at) VALUES (?, ?, ?)', [kind, message, Date.now()]);
}
