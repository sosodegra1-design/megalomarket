/*
 * Lecture d'une fiche produit par un agent web (importer/aiReader.js).
 *
 * Cette couche est la réponse au « HTTP 400 répétitif » d'Alibaba : les six
 * couches de scraping se présentent toutes comme un client HTTP automatisé et se
 * font refuser de la même façon, alors qu'un agent qui ouvre réellement la page
 * passe. Ces tests verrouillent les deux propriétés qui rendent la couche
 * acceptable en production :
 *
 *  1. elle ne DEVINE jamais rien — sans lecture réelle, sans prix ou sans
 *     devise, elle refuse au lieu de fabriquer une fiche plausible ;
 *  2. elle ne transmet jamais une adresse privée à un tiers, exactement comme le
 *     scraper le fait avant de confier une URL à Wayback ou Jina.
 *
 * Aucun test ne touche au réseau : `fetchImpl` et `lookupHost` sont injectés.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProductPageWithAgent } from '../src/importer/aiReader.js';

const publicLookup = async () => ['93.184.216.34'];
const privateLookup = async () => ['127.0.0.1'];
const URL_PRODUIT = 'https://www.alibaba.com/product-detail/x_123.html';

/** Réponse d'agent simulée : le texte du modèle arrive dans `output_text`. */
function agentReply(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => String(text),
    json: async () => ({ output_text: String(text) }),
  };
}

/** Un fetch injecté qui compte ses appels, pour prouver qu'il n'est pas appelé. */
function countingFetch(reply) {
  const state = { calls: 0 };
  return {
    state,
    fetchImpl: async () => {
      state.calls += 1;
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

function withPerplexityKey(value, fn) {
  const saved = process.env.PERPLEXITY_API_KEY;
  if (value === undefined) delete process.env.PERPLEXITY_API_KEY;
  else process.env.PERPLEXITY_API_KEY = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = saved;
  }
}

const PRODUIT_JSON = JSON.stringify({
  pageRead: true,
  pageKind: 'fiche produit',
  title: 'Memo Pad electronique pour enfants',
  price: 3.85,
  currency: 'usd',
  priceNote: 'US$3.85 / piece, min. order 100 pieces',
  description: 'Bloc-notes électronique avec stylet, écran LCD, pour enfants.',
  images: ['https://sc04.alicdn.com/kf/H1.jpg'],
  evidence: 'US$3.85',
});

test('une fiche réellement lue est normalisée (devise en majuscules, stratégie tracée)', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const result = await readProductPageWithAgent({
      url: URL_PRODUIT,
      lookupHost: publicLookup,
      fetchImpl: async () => agentReply(PRODUIT_JSON),
    });

    assert.equal(result.title, 'Memo Pad electronique pour enfants');
    assert.equal(result.purchasePrice, 3.85);
    assert.equal(result.currency, 'USD', 'la devise doit être normalisée en majuscules');
    assert.equal(result.strategy, 'agent-perplexity');
    assert.equal(result.sourceSite, 'alibaba');
    assert.deepEqual(result.imageUrls, ['https://sc04.alicdn.com/kf/H1.jpg']);
    // La preuve de lecture doit accompagner le résultat, pas être perdue.
    assert.match(result.agentNotes, /lue par un agent web/);
    assert.match(result.agentNotes, /US\$3\.85 \/ piece/);
  });
});

test('le JSON est extrait même entouré de texte et de balises de code', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const text = `Voici la fiche :\n\`\`\`json\n${PRODUIT_JSON}\n\`\`\`\nJ'espère que cela aide.`;
    const result = await readProductPageWithAgent({
      url: URL_PRODUIT,
      lookupHost: publicLookup,
      fetchImpl: async () => agentReply(text),
    });
    assert.equal(result.purchasePrice, 3.85);
  });
});

test('une page non lue (mur anti-robot) est refusée, avec renvoi vers la saisie manuelle', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const text = JSON.stringify({
      pageRead: false,
      pageKind: 'mur anti-robot',
      title: '',
      price: null,
      currency: null,
      priceNote: '',
      description: '',
      images: [],
      evidence: '',
    });
    await assert.rejects(
      () => readProductPageWithAgent({
        url: URL_PRODUIT,
        lookupHost: publicLookup,
        fetchImpl: async () => agentReply(text),
      }),
      (error) => {
        assert.match(error.message, /n'a pas pu lire la page/);
        assert.match(error.message, /saisie manuelle/);
        return true;
      },
    );
  });
});

test('un titre d’annuaire est refusé, même si l’agent prétend avoir lu la page', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const text = JSON.stringify({
      pageRead: true,
      pageKind: 'annuaire',
      title: 'Alibaba Manufacturer DirectoryAlibaba Manufacturer Directory',
      price: 0,
      currency: 'USD',
      priceNote: '',
      description: '',
      images: [],
      evidence: '',
    });
    await assert.rejects(
      () => readProductPageWithAgent({
        url: URL_PRODUIT,
        lookupHost: publicLookup,
        fetchImpl: async () => agentReply(text),
      }),
      /pas de fiche produit/,
    );
  });
});

test('aucun prix lu : refus, jamais un import à 0', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const text = JSON.stringify({
      pageRead: true,
      pageKind: 'fiche produit',
      title: 'Memo Pad electronique',
      price: null,
      currency: null,
      priceNote: 'Prix visible uniquement après connexion',
      description: 'Bloc-notes.',
      images: [],
      evidence: '',
    });
    await assert.rejects(
      () => readProductPageWithAgent({
        url: URL_PRODUIT,
        lookupHost: publicLookup,
        fetchImpl: async () => agentReply(text),
      }),
      (error) => {
        assert.match(error.message, /aucun prix/);
        assert.match(error.message, /après connexion/, 'la note de prix doit être remontée');
        return true;
      },
    );
  });
});

test('un prix sans devise est refusé : pas de dollar supposé', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const text = JSON.stringify({
      pageRead: true,
      pageKind: 'fiche produit',
      title: 'Memo Pad electronique',
      price: 3.85,
      currency: null,
      priceNote: '3.85',
      description: 'Bloc-notes.',
      images: [],
      evidence: '3.85',
    });
    await assert.rejects(
      () => readProductPageWithAgent({
        url: URL_PRODUIT,
        lookupHost: publicLookup,
        fetchImpl: async () => agentReply(text),
      }),
      (error) => {
        assert.match(error.message, /devise/);
        // Le message doit dire pourquoi c'est grave, pas seulement que c'est absent.
        assert.match(error.message, /prix de vente faux/);
        return true;
      },
    );
  });
});

test('une adresse privée n’est JAMAIS transmise à l’agent (garde SSRF)', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const probe = countingFetch(agentReply(PRODUIT_JSON));
    await assert.rejects(
      () => readProductPageWithAgent({
        url: 'http://127.0.0.1:8080/produit',
        lookupHost: privateLookup,
        fetchImpl: probe.fetchImpl,
      }),
      /privée|interne|local/i,
    );
    assert.equal(probe.state.calls, 0, 'aucune requête ne doit partir vers l’agent pour une adresse privée');
  });
});

test('un schéma non HTTP est refusé avant tout appel', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const probe = countingFetch(agentReply(PRODUIT_JSON));
    await assert.rejects(
      () => readProductPageWithAgent({
        url: 'file:///etc/passwd',
        lookupHost: publicLookup,
        fetchImpl: probe.fetchImpl,
      }),
      /schémas http/,
    );
    assert.equal(probe.state.calls, 0);
  });
});

test('sans clé Perplexity, l’erreur nomme la variable à renseigner', async () => {
  await withPerplexityKey(undefined, async () => {
    const probe = countingFetch(agentReply(PRODUIT_JSON));
    await assert.rejects(
      () => readProductPageWithAgent({
        url: URL_PRODUIT,
        lookupHost: publicLookup,
        fetchImpl: probe.fetchImpl,
      }),
      /PERPLEXITY_API_KEY/,
    );
    assert.equal(probe.state.calls, 0, 'inutile d’appeler l’API sans clé');
  });
});

test('un HTTP 400 est remonté tel quel, avec le détail de la réponse', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    await assert.rejects(
      () => readProductPageWithAgent({
        url: URL_PRODUIT,
        lookupHost: publicLookup,
        fetchImpl: async () => agentReply('Bad Request: preset inconnu', { status: 400 }),
      }),
      (error) => {
        assert.match(error.message, /HTTP 400/);
        assert.match(error.message, /preset inconnu/);
        return true;
      },
    );
  });
});

test('une réponse non-JSON est refusée explicitement', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    await assert.rejects(
      () => readProductPageWithAgent({
        url: URL_PRODUIT,
        lookupHost: publicLookup,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => { throw new Error('pas du JSON'); },
        }),
      }),
      /JSON valide/,
    );
  });
});

test('les images non HTTP et les doublons sont écartés, la liste est bornée', async () => {
  await withPerplexityKey('cle-de-test', async () => {
    const images = ['javascript:alert(1)', 'https://a.example/1.jpg', 'https://a.example/1.jpg'];
    for (let i = 0; i < 12; i += 1) images.push(`https://a.example/${i}.jpg`);
    const text = JSON.stringify({
      pageRead: true,
      pageKind: 'fiche produit',
      title: 'Memo Pad electronique',
      price: 3.85,
      currency: 'USD',
      priceNote: 'US$3.85',
      description: 'Bloc-notes.',
      images,
      evidence: 'US$3.85',
    });
    const result = await readProductPageWithAgent({
      url: URL_PRODUIT,
      lookupHost: publicLookup,
      fetchImpl: async () => agentReply(text),
    });
    assert.ok(result.imageUrls.length <= 8, 'la liste doit être bornée');
    assert.ok(result.imageUrls.every((url) => url.startsWith('https://')), 'aucune URL non HTTP');
    assert.equal(new Set(result.imageUrls).size, result.imageUrls.length, 'aucun doublon');
  });
});
