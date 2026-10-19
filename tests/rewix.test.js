/*
 * Connecteur Rewix et synchronisation du catalogue.
 *
 * Aucun réseau : `fetchImpl` est injecté, et les charges utiles reproduisent la
 * forme JSON décrite par la documentation Rewix (TEAL).
 *
 * Ce qui est verrouillé ici, ce sont les décisions qui coûtent cher si elles se
 * perdent :
 *  - `taxable` est le COÛT, pas le prix de vente (confondre les deux ferait
 *    vendre à perte) ;
 *  - le poids est converti en grammes (2 kg ne doit pas devenir 2 g) ;
 *  - un produit local portant le même SKU n'est JAMAIS écrasé ;
 *  - le curseur de synchronisation n'avance pas si le lot est incomplet, sinon
 *    les produits manqués ne seraient plus jamais redemandés.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'megalomarket-rewix-')), 'rewix.db');
process.env.REWIX_API_URL = 'https://fournisseur-exemple.rewixecommerce.com';
process.env.REWIX_API_KEY = 'cle-de-test';
process.env.REWIX_PASSWORD = 'motdepasse-de-test';

const { buildCatalogUrl, fetchCatalog, mapProduct } = await import('../src/connectors/rewix.js');
const { syncRewixCatalog, getSyncCursor } = await import('../src/services/rewixSync.js');
const { initDatabase, dbAll, dbRun } = await import('../src/db/database.js');

before(async () => {
  await initDatabase();
});

/** Réponse HTTP simulée, la plus proche possible de ce que renvoie Rewix. */
function reponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

const PRODUIT_REWIX = {
  id: 82105,
  name: 'Stivaletto donna',
  code: 'GD6423',
  streetPrice: 159,
  suggestedPrice: 79.9,
  taxable: 39.9,
  bestTaxable: 34.9,
  currency: 'EUR',
  weight: 2,
  availability: 74,
  hs: '64035119',
  online: true,
  intangible: false,
  images: [{ id: 164458, url: '/prod/stock_GD6423.jpg' }],
  models: [
    { id: 234225, code: 'GD6423_36', size: '36', color: 'black', availability: 5 },
    { id: 234226, code: 'GD6423_37', size: '37', color: 'black', availability: 3 },
  ],
  productLocalizations: {
    description: { fr_FR: { value: 'Bottine <br/>- cuir véritable' }, en_US: { value: 'Ankle boots' } },
    productName: { fr_FR: { value: 'Bottine femme' } },
  },
};

/* ===================== URL ===================== */

test('l’URL du catalogue porte les paramètres exigés par Rewix', () => {
  const url = buildCatalogUrl({});
  assert.match(url, /\/restful\/export\/api\/products\.json/);
  assert.match(url, /acceptedlocales=fr_FR%2Cen_US/);
  assert.match(url, /v=TEAL/);
  assert.ok(!url.includes('since'), 'sans curseur, la synchronisation est complète');
});

test('« since » est encodé : le + d’un décalage horaire ne doit pas devenir une espace', () => {
  // Rewix signale explicitement que « + » est réservé. C'est exactement le genre
  // d'encodage qui casse en silence : la date arrive mutilée côté serveur.
  const url = buildCatalogUrl({ since: '2026-09-25T10:00:00+02:00' });
  assert.ok(url.includes('since=2026-09-25T10%3A00%3A00%2B02%3A00'), url);
  assert.ok(!/[^%]\+/.test(url.split('since=')[1] || ''), 'aucun + brut dans la valeur');
});

/* ===================== TRADUCTION D'UN PRODUIT ===================== */

test('taxable devient le prix d’ACHAT, pas le prix de vente', () => {
  const produit = mapProduct(PRODUIT_REWIX);
  // Confondre les deux ferait vendre à perte : streetPrice est le prix public.
  assert.equal(produit.costPrice, 39.9);
  assert.notEqual(produit.costPrice, 159);
  assert.equal(produit.streetPrice, 159);
});

test('le poids est converti en grammes', () => {
  const produit = mapProduct(PRODUIT_REWIX);
  // 2 (kg) → 2000 g. Stocker 2 dans une colonne « poids » ferait un produit de 2 g.
  assert.equal(produit.weightGrams, 2000);
});

test('le code douanier et la référence source sont conservés', () => {
  const produit = mapProduct(PRODUIT_REWIX);
  assert.equal(produit.hsCode, '64035119');
  assert.equal(produit.sourceRef, '82105');
});

test('le nom localisé français est préféré, la description est nettoyée du HTML', () => {
  const produit = mapProduct(PRODUIT_REWIX);
  assert.equal(produit.name, 'Bottine femme');
  assert.ok(!produit.description.includes('<br'), 'les balises sont retirées');
  assert.match(produit.description, /cuir véritable/);
});

test('un produit sans code est ignoré, silencieusement mais sûrement', () => {
  assert.equal(mapProduct({ name: 'Sans code', taxable: 10 }), null);
  assert.equal(mapProduct(null), null);
});

test('un produit sans prix reste importable, mais à 0 — et c’est compté', () => {
  const produit = mapProduct({ code: 'X1', name: 'Sans prix', taxable: 0 });
  assert.equal(produit.costPrice, 0);
});

/* ===================== ERREURS D'APPEL ===================== */

test('un 401 explique quoi corriger', async () => {
  await assert.rejects(
    () => fetchCatalog({ fetchImpl: async () => reponse({}, { status: 401 }) }),
    /401.*REWIX_API_KEY|REWIX_API_KEY.*401/s,
  );
});

test('un 412 dit que la fenêtre incrémentale est dépassée, sans parler de bug', async () => {
  await assert.rejects(
    () => fetchCatalog({ since: '2026-01-01T00:00:00Z', fetchImpl: async () => reponse({}, { status: 412 }) }),
    /412.*4 heures|4 heures.*412/s,
  );
});

test('une réponse non-JSON est refusée explicitement', async () => {
  await assert.rejects(
    () => fetchCatalog({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } }),
    }),
    /JSON valide/,
  );
});

/* ===================== SYNCHRONISATION ===================== */

test('une première synchronisation crée les produits et pose le curseur', async () => {
  const rapport = await syncRewixCatalog({
    fetchImpl: async () => reponse({
      pageItems: [PRODUIT_REWIX, { ...PRODUIT_REWIX, id: 99, code: 'GD9999', name: 'Autre' }],
      totalItems: 2,
      lastUpdate: '2026-09-25T10:00:00.000Z',
    }),
  });

  assert.equal(rapport.mode, 'complet');
  assert.equal(rapport.crees, 2);
  assert.equal(rapport.tronque, false);
  assert.equal(rapport.curseur, '2026-09-25T10:00:00.000Z');

  const enBase = await dbAll('SELECT sku, cost_price, weight_g, hs_code FROM products ORDER BY sku');
  assert.equal(enBase.length, 2);
  assert.equal(enBase[0].cost_price, 39.9);
  assert.equal(enBase[0].weight_g, 2000);
  assert.equal(enBase[0].hs_code, '64035119');
});

test('une synchronisation suivante MET À JOUR au lieu de dupliquer', async () => {
  const rapport = await syncRewixCatalog({
    fetchImpl: async () => reponse({
      // On modifie le NOM LOCALISE : c'est lui qui fait foi. Changer seulement
      // `name` ne suffirait pas — et ce n'est pas un bug, c'est la regle : une
      // traduction francaise dediee est plus fiable que le nom generique.
      pageItems: [{
        ...PRODUIT_REWIX,
        taxable: 42.5,
        name: 'Generic name ignored',
        productLocalizations: {
          description: { fr_FR: { value: 'Bottine <br/>- cuir veritable' } },
          productName: { fr_FR: { value: 'Bottine femme (nouveau nom)' } },
        },
      }],
      totalItems: 1,
      lastUpdate: '2026-09-25T11:00:00.000Z',
    }),
  });

  assert.equal(rapport.misAJour, 1);
  assert.equal(rapport.crees, 0);

  const lignes = await dbAll("SELECT name, cost_price FROM products WHERE sku = 'GD6423'");
  assert.equal(lignes.length, 1, 'aucun doublon');
  assert.equal(lignes[0].cost_price, 42.5);
  assert.equal(lignes[0].name, 'Bottine femme (nouveau nom)');
});

test('un produit LOCAL portant le même SKU n’est JAMAIS écrasé', async () => {
  // Le cas qui coûterait une fiche écrite à la main : même SKU, origine locale.
  await dbRun(
    "INSERT INTO products (sku, name, description, cost_price, created_at) VALUES ('LOCAL-1', 'Mon produit à moi', 'écrit à la main', 12, ?)",
    [Date.now()],
  );

  const rapport = await syncRewixCatalog({
    fetchImpl: async () => reponse({
      pageItems: [{ ...PRODUIT_REWIX, id: 99, code: 'LOCAL-1', name: 'Version Rewix' }],
      totalItems: 1,
      lastUpdate: '2026-09-25T12:00:00.000Z',
    }),
  });

  assert.equal(rapport.ignores, 1);
  assert.deepEqual(rapport.conflits, ['LOCAL-1']);

  const ligne = await dbAll("SELECT name, source_ref FROM products WHERE sku = 'LOCAL-1'");
  assert.equal(ligne[0].name, 'Mon produit à moi', 'le produit local est intact');
  assert.equal(ligne[0].source_ref, null);
});

test('le curseur n’avance PAS si le catalogue est tronqué', async () => {
  // Sinon les produits non reçus ne seraient plus jamais redemandés.
  const avant = await getSyncCursor();
  const rapport = await syncRewixCatalog({
    fetchImpl: async () => reponse({
      pageItems: [PRODUIT_REWIX],
      totalItems: 500,
      lastUpdate: '2026-09-25T13:00:00.000Z',
    }),
  });

  assert.equal(rapport.tronque, true);
  assert.equal(rapport.curseur, avant, 'le curseur ne bouge pas');
});

test('le mode complet ignore le curseur', async () => {
  const rapport = await syncRewixCatalog({
    incremental: false,
    fetchImpl: async () => reponse({ pageItems: [], totalItems: 0, lastUpdate: null }),
  });
  assert.equal(rapport.mode, 'complet');
  assert.equal(rapport.depuis, null);
});
