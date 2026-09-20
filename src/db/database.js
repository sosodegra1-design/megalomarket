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

export async function initDatabase() {
  await client.execute('PRAGMA foreign_keys = ON');
  const schemaSql = readFileSync(`${__dirname}/schema.sql`, 'utf8');
  await client.executeMultiple(schemaSql);
}

export async function logActivity(kind, message) {
  await dbRun('INSERT INTO activity_log (kind, message, created_at) VALUES (?, ?, ?)', [kind, message, Date.now()]);
}
