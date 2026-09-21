import { createClient } from '@libsql/client';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * SQLite ne sait pas modifier une contrainte CHECK en place : ajouter
 * `own_site` à import_listings.marketplace impose de reconstruire la table.
 * `CREATE TABLE IF NOT EXISTS` ne touche pas une table déjà existante, donc les
 * bases créées avant cette évolution ont besoin de cette migration explicite.
 * Idempotente : on ne reconstruit que si la contrainte n'accepte pas encore
 * `own_site`. La reconstruction est atomique (batch en mode write).
 */
async function migrateImportListingsForOwnSite() {
  const existing = await dbGet(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_listings'",
  );
  if (!existing?.sql || existing.sql.includes('own_site')) return false;

  await client.batch(
    [
      `CREATE TABLE import_listings_migrated (
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
      `INSERT INTO import_listings_migrated
         (id, import_id, marketplace, title, description, suggested_price, site_payload,
          status, published_external_id, publish_error, created_at, updated_at)
       SELECT id, import_id, marketplace, title, description, suggested_price, NULL,
              status, published_external_id, publish_error, created_at, updated_at
       FROM import_listings`,
      'DROP TABLE import_listings',
      'ALTER TABLE import_listings_migrated RENAME TO import_listings',
    ],
    'write',
  );

  await logActivity('MIGRATION', "Table import_listings reconstruite : canal 'own_site' autorisé, colonne site_payload ajoutée.");
  return true;
}

export async function initDatabase() {
  await client.execute('PRAGMA foreign_keys = ON');
  const schemaSql = readFileSync(`${__dirname}/schema.sql`, 'utf8');
  await client.executeMultiple(schemaSql);
  await migrateImportListingsForOwnSite();
}

export async function logActivity(kind, message) {
  await dbRun('INSERT INTO activity_log (kind, message, created_at) VALUES (?, ?, ?)', [kind, message, Date.now()]);
}
