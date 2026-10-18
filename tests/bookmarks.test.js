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

import { mkdirSync, writeFileSync } from 'node:fs';
import { listChromeBookmarkFiles, resolveBookmarkFiles, collectBookmarks } from '../src/services/bookmarks.js';

function fakeChrome() {
  const base = mkdtempSync(join(tmpdir(), 'chrome-'));
  const bar = (urls) => JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: urls.map((url, i) => ({ type: 'url', name: `n${i}`, url })) } } });
  for (const [profile, urls] of [['Default', []], ['Profile 1', ['https://www.alibaba.com/product-detail/a.html', 'https://fr.aliexpress.com/item/1.html']], ['Profile 2', ['https://www.alibaba.com/product-detail/a.html']]]) {
    mkdirSync(join(base, profile), { recursive: true });
    writeFileSync(join(base, profile, 'Bookmarks'), bar(urls));
  }
  mkdirSync(join(base, 'Crashpad'), { recursive: true });
  writeFileSync(join(base, 'Crashpad', 'Bookmarks'), '{}');
  return base;
}

test('every Chrome profile is found, other folders are ignored', async () => {
  const files = await listChromeBookmarkFiles(fakeChrome());
  assert.deepEqual(files.map((f) => f.split('/').slice(-2, -1)[0]), ['Default', 'Profile 1', 'Profile 2']);
});

test('links are merged across profiles even when Default is empty', async () => {
  const files = await listChromeBookmarkFiles(fakeChrome());
  const result = await collectBookmarks({ files, folderName: 'Barre de favoris' });
  assert.equal(result.accepted.length, 2, 'dédoublonné : le lien commun à deux profils compte une fois');
  assert.equal(result.perFile.length, 3);
  assert.equal(result.perFile[0].accepted, 0);
});

test('an unreadable file does not stop the others', async () => {
  const base = fakeChrome();
  const files = [...(await listChromeBookmarkFiles(base)), join(base, 'absent', 'Bookmarks')];
  const result = await collectBookmarks({ files, folderName: 'Barre de favoris' });
  assert.equal(result.accepted.length, 2);
  assert.ok(result.perFile.at(-1).error);
});

test('CHROME_BOOKMARKS_PATH wins over auto-detection and accepts several paths', async () => {
  assert.deepEqual(await resolveBookmarkFiles('/a/Bookmarks | /b/Bookmarks'), ['/a/Bookmarks', '/b/Bookmarks']);
  assert.ok((await resolveBookmarkFiles('', fakeChrome())).length === 3);
});
