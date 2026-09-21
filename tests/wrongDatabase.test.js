/* Le réflexe naturel, quand on a déjà une base chez le même hébergeur, est de
 * la réutiliser. Ici ce serait fatal : le site BBVOLTEX possède lui aussi une
 * table `products` — et une table `orders` — avec des colonnes entièrement
 * différentes. Comme `CREATE TABLE IF NOT EXISTS` ne dit rien quand la table
 * existe déjà, brancher Megalomarket sur la base du site ne produit AUCUNE
 * erreur au démarrage : les requêtes échouent plus tard sur un
 * « no such column: sku » qui n'évoque jamais la vraie cause.
 *
 * Ce test verrouille le contrôle qui la nomme.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-wrongdb-')), 'alien.db');

const { client, initDatabase, dbAll } = await import('../src/db/database.js');

/* Réduction fidèle de la table products du site BBVOLTEX : mêmes colonnes
   typiques, aucune qui ressemble à celles de Megalomarket. */
const SITE_PRODUCTS_TABLE = `
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    universe TEXT,
    price REAL NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT NOT NULL,
    colors TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
`;

test("une base appartenant à un autre projet est refusée, et la cause est nommée", async () => {
  await client.executeMultiple(SITE_PRODUCTS_TABLE);
  await client.execute(
    "INSERT INTO products (id, category, price, name, name_en, colors) VALUES ('p1', 'jouets', 29.9, 'Camion', 'Truck', '[]')",
  );

  // Le service doit refuser de démarrer plutôt que de servir une base étrangère.
  await assert.rejects(() => initDatabase(), /n'est pas celle de Megalomarket/);
  // Le message doit dire QUELLES colonnes manquent...
  await assert.rejects(() => initDatabase(), /sku, cost_price/);
  // ...et désigner le suspect le plus probable, sans laisser l'utilisateur chercher.
  await assert.rejects(() => initDatabase(), /BBVOLTEX/);
  await assert.rejects(() => initDatabase(), /base distincte/);
});

test('la donnée étrangère est intacte : on refuse, on ne détruit rien', async () => {
  const rows = await dbAll('SELECT id, name FROM products');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Camion');
});

test('sur une base vierge, le schéma est créé et le contrôle laisse passer', async () => {
  // On simule la base distincte que l'utilisateur doit créer.
  await client.execute('DROP TABLE products');

  await initDatabase();

  const columns = (await dbAll('PRAGMA table_info(products)')).map((column) => column.name);
  assert.ok(columns.includes('sku'), 'le vrai schéma doit être en place');
  assert.ok(columns.includes('cost_price'));
});

test('un second démarrage ne déclenche pas le contrôle à tort', async () => {
  await initDatabase();
  await initDatabase();
  const rows = await dbAll('SELECT name FROM products');
  assert.equal(rows.length, 0);
});
