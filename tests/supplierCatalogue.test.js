/*
 * Catalogue de partenaires et son installation au démarrage.
 *
 * Le registre `suppliers` existait mais restait vide sur un déploiement neuf :
 * le propriétaire devait retaper chaque plateforme à la main et l'écran
 * d'import n'avait personne à proposer. Ces tests verrouillent les deux
 * propriétés qui rendent le catalogue utilisable sans être dangereux :
 *
 *   - sa forme est valide (chaque entrée passerait la validation de l'API, et
 *     notamment une marge STRICTEMENT supérieure à 1 — l'API refuse le reste) ;
 *   - son installation est réservée à une table VIDE. Une base de production
 *     déjà garnie, ou un second démarrage, ne reçoit rien : sans ce garde-fou,
 *     rejouer le seed dupliquerait ou écraserait des fiches négociées à la main.
 *
 * Aucun réseau : la base est un fichier temporaire, comme pour les autres tests
 * de base de données.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-catalogue-')), 'catalogue.db');

const { SUPPLIER_CATALOGUE, seedSuppliersIfEmpty } = await import('../src/db/supplier-catalogue.js');
const { client, initDatabase, dbAll, dbRun } = await import('../src/db/database.js');

// Le client libsql est partagé par tout le fichier : on le referme une seule
// fois, sinon les tests suivants échouent sur « CLIENT_CLOSED ».
after(() => client.close());

async function countSuppliers() {
  const rows = await dbAll('SELECT COUNT(*) AS total FROM suppliers');
  return Number(rows[0].total);
}

/* ===================== FORME DU CATALOGUE ===================== */

test('chaque entrée du catalogue est exploitable telle quelle', () => {
  assert.ok(SUPPLIER_CATALOGUE.length > 0, 'un catalogue vide ne réglerait pas le problème');

  // Le catalogue d'origine comptait 25 plateformes généralistes. Le propriétaire
  // vend dans une dizaine de familles de produits : le catalogue doit désormais
  // couvrir chaque rayon, et non plus seulement les places de marché générales.
  assert.ok(
    SUPPLIER_CATALOGUE.length >= 65,
    'le catalogue doit couvrir toutes les familles de produits (au moins 65 entrées)',
  );

  for (const entry of SUPPLIER_CATALOGUE) {
    const label = entry?.name ?? JSON.stringify(entry);
    assert.ok(['fournisseur', 'distributeur'].includes(entry.kind), `${label} : type valide`);
    assert.equal(typeof entry.name, 'string', `${label} : nom textuel`);
    assert.ok(entry.name.trim().length > 0, `${label} : nom non vide`);

    // Sans protocole http(s), la route POST refuserait l'adresse : le catalogue
    // installerait alors des fiches impossibles à reproduire depuis l'écran.
    assert.match(entry.siteUrl, /^https?:\/\/\S+$/, `${label} : adresse http(s)`);

    // La route POST refuse une marge <= 1 (« vente à perte »). Une entrée à 1
    // installerait en base une fiche que le formulaire refuserait de recréer.
    assert.equal(typeof entry.marginCoefficient, 'number', `${label} : marge numérique`);
    assert.ok(entry.marginCoefficient > 1, `${label} : marge strictement supérieure à 1`);

    assert.equal(typeof entry.notes, 'string', `${label} : notes textuelles`);
    assert.ok(entry.notes.trim().length > 0, `${label} : notes non vides — elles expliquent l'usage`);
  }
});

test('aucun nom de partenaire n’est présent deux fois', () => {
  const names = SUPPLIER_CATALOGUE.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, 'un doublon créerait deux fiches indiscernables dans la liste d’import');
});

/*
 * Les 25 fiches du catalogue d'origine sont déjà semées dans la base de
 * production. Les renommer — même pour corriger une faute — désynchroniserait
 * la fiche installée du code : ce test les épingle donc par leur nom exact.
 */
const NOMS_ORIGINAUX = [
  'Alibaba',
  'AliExpress',
  'Made-in-China',
  '1688 (Chine)',
  'Global Sources',
  'DHgate',
  'Banggood',
  'Temu',
  'Taobao',
  'Yiwugo',
  'Alibaba France (revendeurs)',
  'BigBuy',
  'Spocket',
  'Syncee',
  'Modalyst',
  'Faire',
  'Ankorstore',
  'Orderchamp',
  'Tundra',
  'Printful',
  'Printify',
  'Gelato',
  'Cdiscount Pro',
  'ManoMano Pro',
  'Amazon Business',
];

test('les 25 partenaires d’origine sont toujours présents, sous le même nom', () => {
  const names = new Set(SUPPLIER_CATALOGUE.map((entry) => entry.name));

  for (const original of NOMS_ORIGINAUX) {
    assert.ok(
      names.has(original),
      `${original} a disparu ou a été renommé : la fiche semée en production ne correspondrait plus au code`,
    );
  }
});

test('chaque famille de produits de la boutique a ses grossistes', () => {
  const corpus = SUPPLIER_CATALOGUE
    .map((entry) => `${entry.name} ${entry.notes}`)
    .join(' ')
    .toLowerCase();

  // Un mot-clé par famille vendue. Le test échoue si une famille entière
  // disparaît du catalogue, pas si telle plateforme précise est retirée.
  const familles = [
    'jouets',
    'puériculture',
    'vêtements enfants',
    'prêt-à-porter',
    'chaussures',
    'électronique',
    'informatique',
    'maison',
    'beauté',
    'sport',
    'bijoux',
    'emballage',
    'destockage',
    'papeterie',
    'animalerie',
    'bricolage',
    'auto et moto',
  ];
  assert.ok(familles.length >= 12, 'au moins une douzaine de familles doivent être couvertes');

  for (const famille of familles) {
    assert.ok(corpus.includes(famille), `aucune plateforme ne couvre « ${famille} »`);
  }
});

test('aucune plateforme n’est présente deux fois sous deux adresses', () => {
  const parHote = new Map();
  for (const entry of SUPPLIER_CATALOGUE) {
    const hote = new URL(entry.siteUrl).hostname.replace(/^www\./, '');
    if (!parHote.has(hote)) parHote.set(hote, []);
    parHote.get(hote).push(entry.name);
  }

  // Seule exception, héritée du catalogue d'origine : Alibaba figure deux fois
  // volontairement (la racine et l'annuaire des fournisseurs français), et ces
  // deux fiches sont conservées telles quelles pour ne pas casser la production.
  const exceptions = new Set(['alibaba.com']);

  for (const [hote, noms] of parHote) {
    if (noms.length === 1) continue;
    assert.ok(exceptions.has(hote), `${hote} apparaît deux fois : ${noms.join(', ')}`);
    assert.deepEqual(noms.slice().sort(), ['Alibaba', 'Alibaba France (revendeurs)']);
  }
});

/* ===================== INSTALLATION ===================== */

test('sur une table vide, tout le catalogue est installé', async () => {
  await initDatabase();

  assert.equal(await countSuppliers(), 0, 'la table doit être vide avant de semer');

  const result = await seedSuppliersIfEmpty();
  assert.deepEqual(result, { seeded: SUPPLIER_CATALOGUE.length });
  assert.equal(await countSuppliers(), SUPPLIER_CATALOGUE.length);

  // Les lignes installées doivent être complètes : une fiche sans statut ni
  // dates ne s'afficherait pas comme les autres dans l'écran Partenaires.
  const rows = await dbAll('SELECT * FROM suppliers');
  assert.ok(rows.every((row) => row.status === 'actif'), 'les partenaires installés sont actifs');
  assert.ok(rows.every((row) => typeof row.created_at === 'string' && row.created_at.length > 0), 'created_at renseigné');
  assert.ok(rows.every((row) => typeof row.updated_at === 'string' && row.updated_at.length > 0), 'updated_at renseigné');

  // Le catalogue contient bien les deux types : un seed limité aux
  // fournisseurs laisserait la moitié de l'écran d'import vide.
  const kinds = new Set(rows.map((row) => row.kind));
  assert.deepEqual([...kinds].sort(), ['distributeur', 'fournisseur']);
});

test('un second appel n’insère rien et ne change pas le total', async () => {
  await initDatabase();

  const before = await countSuppliers();
  assert.ok(before > 0, 'ce test suppose le catalogue déjà installé par le test précédent');

  const result = await seedSuppliersIfEmpty();
  assert.deepEqual(result, { seeded: 0 }, 'le catalogue ne doit pas être réinstallé');
  assert.equal(await countSuppliers(), before, 'aucune ligne n’a été ajoutée');
});

test('une table contenant déjà un partenaire personnalisé ne reçoit rien', async () => {
  await initDatabase();

  // On simule la base de production : elle n'est pas vide, mais elle ne
  // contient AUCUN nom du catalogue. C'est le cas qui prouve que le garde-fou
  // est « table vide » et non « noms manquants » — sinon le seed ajouterait ses
  // 25 plateformes à côté du partenaire négocié à la main.
  await dbRun('DELETE FROM suppliers');
  await dbRun(
    `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
     VALUES ('fournisseur', 'Mon fournisseur négocié', 'https://mon-fournisseur.example.com', 3.4, 'actif', 'marge négociée à la main', ?, ?)`,
    [new Date().toISOString(), new Date().toISOString()],
  );

  const result = await seedSuppliersIfEmpty();
  assert.deepEqual(result, { seeded: 0 });
  assert.equal(await countSuppliers(), 1, 'la fiche personnalisée doit rester seule, intacte');

  const rows = await dbAll('SELECT * FROM suppliers');
  assert.equal(rows[0].name, 'Mon fournisseur négocié');
  assert.equal(rows[0].margin_coefficient, 3.4, 'la marge négociée n’est jamais écrasée');
});
