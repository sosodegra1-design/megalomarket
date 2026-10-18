import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractBookmarkUrls, isAllowedSource, loadSeen, saveSeen } from '../src/services/bookmarks.js';

const CHROME_JSON = {
  roots: {
    bookmark_bar: {
      type: 'folder', name: 'Barre de favoris', children: [
        { type: 'url', name: 'Hors dossier', url: 'https://www.alibaba.com/product-detail/hors.html' },
        {
          type: 'folder', name: 'Megalomarket', children: [
            { type: 'url', name: 'Lampe', url: 'https://www.alibaba.com/product-detail/lampe_1.html' },
            { type: 'url', name: 'Doublon', url: 'https://www.alibaba.com/product-detail/lampe_1.html' },
            { type: 'url', name: 'AliExpress', url: 'https://fr.aliexpress.com/item/1005.html' },
            { type: 'url', name: 'Veepee', url: 'https://www.veepee.fr/gr/ventes/1' },
            { type: 'url', name: 'Pas autorisé', url: 'https://www.exemple.com/produit' },
            { type: 'url', name: 'Piège', url: 'https://alibaba.com.evil.example/x' },
            { type: 'folder', name: 'Sous-dossier', children: [
              { type: 'url', name: 'Showroom', url: 'https://www.showroomprive.com/vente/42' },
            ] },
          ],
        },
      ],
    },
    other: { type: 'folder', name: 'Autres favoris', children: [] },
  },
};

test('only the watched folder is read, deduplicated, subfolders included', () => {
  const { accepted, ignored } = extractBookmarkUrls(CHROME_JSON, 'megalomarket');
  assert.deepEqual(accepted.map((e) => e.url), [
    'https://www.alibaba.com/product-detail/lampe_1.html',
    'https://fr.aliexpress.com/item/1005.html',
    'https://www.veepee.fr/gr/ventes/1',
    'https://www.showroomprive.com/vente/42',
  ]);
  assert.equal(ignored.length, 2, 'les sites non autorisés sont écartés, jamais importés');
});

test('a look-alike hostname is not an allowed source', () => {
  assert.equal(isAllowedSource('https://alibaba.com.evil.example/x'), false);
  assert.equal(isAllowedSource('https://www.alibaba.com/x'), true);
  assert.equal(isAllowedSource('ftp://www.alibaba.com/x'), false);
  assert.equal(isAllowedSource('https://fournisseur.example/x', ['fournisseur.example']), true);
});

test('a missing folder gives a clear error', () => {
  assert.throws(() => extractBookmarkUrls(CHROME_JSON, 'Inexistant'), /introuvable dans Chrome/);
});

test('seen links survive a restart', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bookmarks-')), 'seen.json');
  assert.equal((await loadSeen(path)).size, 0);
  await saveSeen(path, new Set(['https://a.example/1']));
  assert.deepEqual([...(await loadSeen(path))], ['https://a.example/1']);
});

test('the bookmarks bar is found under any of its usual names, accents and case ignored', () => {
  for (const name of ['Barre de favoris', 'barre de favoris', 'Bookmarks bar', 'BARRE DE SIGNETS']) {
    const { accepted } = extractBookmarkUrls(CHROME_JSON, name);
    assert.equal(accepted.length, 5, `${name} : toute la barre, sous-dossiers compris`);
  }
});

test('folder names match without accents or case', () => {
  assert.equal(extractBookmarkUrls(CHROME_JSON, 'MEGALOMARKET').accepted.length, 4);
});
