/*
 * Lecteur GRATUIT — remplace Perplexity quand aucune clé payante n'est configurée.
 *
 * Deux briques gratuites : r.jina.ai (lit la page et en renvoie le texte, sans
 * clé) puis le modèle déjà configuré (Ollama en local, Groq en ligne).
 *
 * Ce qui est verrouillé ici :
 *  - aucune requête ne part vers api.perplexity.ai ;
 *  - une page lue donne un prix, une devise et une provenance HONNÊTE
 *    (`agent-gratuit`, jamais `agent-perplexity`) ;
 *  - les mêmes refus qu'avant : titre d'annuaire, prix à 0, devise absente ;
 *  - une saturation du lecteur gratuit (429) est expliquée, pas masquée.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'https://api.groq.example/openai/v1';
process.env.AI_API_KEY = 'cle-de-test';
process.env.AI_MODEL = 'modele-de-test';
process.env.ANTHROPIC_API_KEY = '';
// Aucune clé Perplexity : c'est précisément le cas qu'on teste.
delete process.env.PERPLEXITY_API_KEY;

const { readProductPageWithAgent } = await import('../src/importer/aiReader.js');

const URL_PRODUIT = 'https://www.alibaba.com/product-detail/bottine_123.html';
const publicLookup = async () => ['93.184.216.34'];

const PAGE = `Title: Bottine femme cuir véritable
Price: US$1.20 - 1.50 / piece (min. order 100 pieces)
Material: cuir véritable
Images: https://cbu01.alicdn.com/img/bottine.jpg`;

function reponseTexte(texte, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => texte, json: async () => ({}) };
}

function reponseModele(objet) {
  const payload = { choices: [{ message: { content: JSON.stringify(objet) } }] };
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

const EXTRACTION = {
  pageRead: true,
  pageKind: 'fiche produit',
  title: 'Bottine femme cuir véritable',
  price: 1.2,
  currency: 'USD',
  priceNote: 'US$1.20 - 1.50 / piece',
  description: 'Bottine en cuir véritable pour femme.',
  images: ['https://cbu01.alicdn.com/img/bottine.jpg'],
  evidence: 'US$1.20 - 1.50 / piece',
};

/* Intercepte les deux appels : r.jina.ai puis le fournisseur IA. */
function stubFetch({ jina = PAGE, jinaStatus = 200, extraction = EXTRACTION, modeleStatus = 200 } = {}) {
  const original = global.fetch;
  const appels = [];
  global.fetch = async (url, options) => {
    appels.push(String(url));
    if (String(url).startsWith('https://r.jina.ai/')) return reponseTexte(jina, { status: jinaStatus });
    if (String(url).includes('/chat/completions')) {
      if (modeleStatus !== 200) {
        return { ok: false, status: modeleStatus, json: async () => ({}), text: async () => 'erreur modele' };
      }
      return reponseModele(extraction);
    }
    throw new Error(`appel inattendu : ${url}`);
  };
  return { appels, restore: () => { global.fetch = original; } };
}

/* ===================== LE CAS NOMINAL ===================== */

test('une page lue donne un prix, une devise et une provenance honnête', async () => {
  const { appels, restore } = stubFetch();
  let resultat;
  try {
    resultat = await readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup });
  } finally {
    restore();
  }

  assert.equal(resultat.title, 'Bottine femme cuir véritable');
  assert.equal(resultat.purchasePrice, 1.2);
  assert.equal(resultat.currency, 'USD');
  assert.equal(resultat.sourceSite, 'alibaba');

  // Le badge de l'import doit dire la VÉRITÉ sur la façon dont la page a été lue.
  assert.equal(resultat.strategy, 'agent-gratuit');
  assert.match(resultat.agentNotes, /r\.jina\.ai/);
  assert.ok(!resultat.agentNotes.includes('Perplexity'), 'la note ne doit pas citer un service non utilisé');

  // Aucun appel payant.
  assert.ok(!appels.some((u) => u.includes('api.perplexity.ai')), 'aucune requête vers Perplexity');
  assert.ok(appels.some((u) => u.startsWith('https://r.jina.ai/')), 'r.jina.ai doit être sollicité');
});

/* ===================== LES REFUS RESTENT LES MÊMES ===================== */

test('un titre d’annuaire est refusé, comme sur le chemin payant', async () => {
  // Alibaba répond « Alibaba Manufacturer Directory » : ce n'est pas une fiche.
  const { restore } = stubFetch({
    extraction: { ...EXTRACTION, title: 'Alibaba Manufacturer Directory', pageRead: true },
  });
  try {
    await assert.rejects(
      () => readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup }),
      /fiche produit|annuaire/i,
    );
  } finally {
    restore();
  }
});

test('un prix à 0 est refusé plutôt que publié', async () => {
  const { restore } = stubFetch({ extraction: { ...EXTRACTION, price: 0 } });
  try {
    await assert.rejects(
      () => readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup }),
      /aucun prix/i,
    );
  } finally {
    restore();
  }
});

test('un prix sans devise est refusé : deviner le dollar publierait un prix faux', async () => {
  const { restore } = stubFetch({ extraction: { ...EXTRACTION, currency: null } });
  try {
    await assert.rejects(
      () => readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup }),
      /devise/i,
    );
  } finally {
    restore();
  }
});

test('si le lecteur n’a pas lu la page, on refuse au lieu d’inventer', async () => {
  const { restore } = stubFetch({ extraction: { ...EXTRACTION, pageRead: false, title: '' } });
  try {
    await assert.rejects(
      () => readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup }),
      /n'a pas pu lire|pas pu lire/i,
    );
  } finally {
    restore();
  }
});

/* ===================== PANNES DU LECTEUR GRATUIT ===================== */

test('une saturation du lecteur gratuit est expliquée, pas masquée', async () => {
  const { restore } = stubFetch({ jina: '', jinaStatus: 429 });
  try {
    await assert.rejects(
      () => readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup }),
      /saturé|429/i,
    );
  } finally {
    restore();
  }
});

test('une page vide est signalée comme telle', async () => {
  const { restore } = stubFetch({ jina: '   ' });
  try {
    await assert.rejects(
      () => readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup }),
      /aucun texte|vide/i,
    );
  } finally {
    restore();
  }
});

test('un modèle indisponible est signalé sans laisser croire à un succès', async () => {
  const { restore } = stubFetch({ modeleStatus: 500 });
  try {
    await assert.rejects(
      () => readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup }),
      /modèle|analyser/i,
    );
  } finally {
    restore();
  }
});

/* ===================== SÉCURITÉ ===================== */

test('une adresse privée est refusée avant que r.jina.ai n’en entende parler', async () => {
  const { appels, restore } = stubFetch();
  const lookupPrive = async () => ['10.0.0.5'];
  try {
    await assert.rejects(
      () => readProductPageWithAgent({
        url: 'https://interne.exemple.com/x',
        lookupHost: lookupPrive,
      }),
      /privée|interne|adresse/i,
    );
    assert.equal(appels.length, 0, 'aucune requête ne doit partir vers un tiers');
  } finally {
    restore();
  }
});

/* ===================== PERPLEXITY EST OPT-IN ===================== */

test('une clé Perplexity présente ne réactive PAS le payant sans le drapeau', async () => {
  // Le cas réel : une clé oubliée dans l'environnement d'un déploiement ne doit
  // pas facturer en silence. Il faut USE_PERPLEXITY_AGENT=true, explicitement.
  const sauveCle = process.env.PERPLEXITY_API_KEY;
  const sauveDrapeau = process.env.USE_PERPLEXITY_AGENT;
  process.env.PERPLEXITY_API_KEY = 'cle-qui-ne-doit-pas-servir';
  delete process.env.USE_PERPLEXITY_AGENT;

  const { appels, restore } = stubFetch();
  let resultat;
  try {
    resultat = await readProductPageWithAgent({ url: URL_PRODUIT, lookupHost: publicLookup });
  } finally {
    restore();
    if (sauveCle === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = sauveCle;
    if (sauveDrapeau === undefined) delete process.env.USE_PERPLEXITY_AGENT;
    else process.env.USE_PERPLEXITY_AGENT = sauveDrapeau;
  }

  assert.equal(resultat.strategy, 'agent-gratuit', 'le gratuit doit rester le défaut');
  assert.ok(!appels.some((u) => u.includes('api.perplexity.ai')), 'aucun appel payant');
});
