import { dbAll } from '../db/database.js';

/*
 * Export complet de la base, en un seul fichier JSON.
 *
 * À QUOI ÇA SERT — ET À QUOI ÇA NE SERT PAS.
 *
 * Turso (la base distante) assure déjà la durabilité et les points de reprise :
 * ce module ne prétend pas la remplacer. Ce qu'il apporte, c'est la
 * PORTABILITÉ : pouvoir sortir toutes ses données dans un fichier lisible, sans
 * dépendre d'un fournisseur, et pouvoir les relire dans six mois avec un simple
 * éditeur de texte.
 *
 * C'est la différence entre « mes données existent quelque part » et « je peux
 * les emporter ». La seconde est la seule qui protège vraiment.
 *
 * POURQUOI PAS UNE SAUVEGARDE AUTOMATIQUE DANS LA BASE ELLE-MÊME : stocker la
 * copie dans la table d'à côté ne protège de rien — si la base disparaît, la
 * copie disparaît avec elle. Une fausse sécurité est pire que pas de sécurité,
 * parce qu'elle fait relâcher la vraie.
 */

/* Un nom de table ne doit contenir que des caractères d'identifiant : il vient
   de `sqlite_master`, jamais d'une entrée utilisateur, mais on ne l'interpole
   pas dans du SQL sans le vérifier — la règle vaut pour toutes les
   interpolations, y compris celles qui semblent sûres. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Liste les tables applicatives (celles qui portent des données). */
export async function listTables() {
  const rows = await dbAll(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((row) => row.name).filter((name) => TABLE_NAME.test(name));
}

/**
 * Exporte toutes les tables dans un objet sérialisable.
 *
 * `includeData = false` produit un inventaire (noms de tables et nombre de
 * lignes) sans les données : utile pour vérifier qu'une sauvegarde est complète
 * sans transporter des données personnelles.
 */
export async function dumpDatabase({ includeData = true } = {}) {
  const tables = await listTables();
  const data = {};
  const counts = {};
  let totalRows = 0;

  for (const table of tables) {
    const rows = await dbAll(`SELECT * FROM ${table}`);
    counts[table] = rows.length;
    totalRows += rows.length;
    if (includeData) data[table] = rows;
  }

  return {
    format: 'megalomarket-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    tableCount: tables.length,
    rowCount: totalRows,
    counts,
    ...(includeData ? { data } : {}),
  };
}

/**
 * Vérifie qu'un export contient bien les tables essentielles.
 *
 * Sert au contrôle après coup : une sauvegarde qui ne contient que la table des
 * produits n'est pas une sauvegarde, et on ne s'en aperçoit normalement qu'au
 * moment où on en a besoin — c'est-à-dire trop tard.
 */
export function checkDumpCompleteness(dump, { required = ['imports', 'products', 'suppliers', 'import_listings'] } = {}) {
  const presentes = Object.keys(dump.counts || {});
  const manquantes = required.filter((table) => !presentes.includes(table));
  return {
    complete: manquantes.length === 0,
    missing: manquantes,
    tableCount: presentes.length,
    rowCount: dump.rowCount,
  };
}
