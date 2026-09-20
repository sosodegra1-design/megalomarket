import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schemaSql = readFileSync(`${__dirname}/schema.sql`, 'utf8');
db.exec(schemaSql);

export function logActivity(kind, message) {
  db.prepare('INSERT INTO activity_log (kind, message, created_at) VALUES (?, ?, ?)').run(
    kind,
    message,
    Date.now(),
  );
}
