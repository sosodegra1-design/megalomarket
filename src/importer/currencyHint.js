/*
 * QUELLE DEVISE POUR UNE URL FOURNISSEUR ?
 *
 * LE DÉFAUT CONSTATÉ : un produit Alibaba saisi à la main partait en EUR. Le
 * prix affiché par le fournisseur était alors lu comme des euros — un jouet à
 * 9,99 USD devenait 9,99 €, soit environ 7,7 fois son vrai coût. Toute la
 * chaîne de prix héritait de l'erreur, et rien ne la signalait.
 *
 * On déduit donc la devise de l'URL, dans cet ordre :
 *   1. le domaine exact, quand il impose sa devise (Alibaba quote en USD pour
 *      les acheteurs internationaux, 1688 et Taobao en CNY, Amazon par pays) ;
 *   2. le domaine de premier niveau, qui trahit le pays de la boutique
 *      (.fr, .de, .es, .it, .be, .nl, .pt → EUR ; .co.uk → GBP) ;
 *   3. à défaut, USD — la devise par défaut du commerce international.
 *
 * CETTE VALEUR EST UNE ESTIMATION, PAS UNE LECTURE. Elle ne remplace jamais ce
 * que la page déclare (balise meta, JSON-LD) : elle sert de point de départ
 * quand la page ne dit rien. L'utilisateur peut toujours corriger.
 */

/** Domaines qui imposent leur devise, quel que soit le pays de l'acheteur. */
const DEVISES_PAR_DOMAINE = [
  // Plateformes chinoises : le grossiste affiche en dollars US pour l'export…
  { motif: /(^|\.)alibaba\.com$/, devise: 'USD', pourquoi: 'Alibaba affiche en USD pour les acheteurs internationaux' },
  { motif: /(^|\.)made-in-china\.com$/, devise: 'USD', pourquoi: 'Made-in-China affiche en USD à l\'export' },
  { motif: /(^|\.)globalsources\.com$/, devise: 'USD', pourquoi: 'Global Sources affiche en USD' },
  // …mais le marché intérieur chinois est en yuans.
  { motif: /(^|\.)1688\.com$/, devise: 'CNY', pourquoi: '1688 est le marché intérieur chinois, en yuans' },
  { motif: /(^|\.)taobao\.com$/, devise: 'CNY', pourquoi: 'Taobao est le marché intérieur chinois, en yuans' },
  { motif: /(^|\.)tmall\.com$/, devise: 'CNY', pourquoi: 'Tmall est le marché intérieur chinois, en yuans' },
  // Amazon par pays.
  { motif: /(^|\.)amazon\.fr$/, devise: 'EUR' },
  { motif: /(^|\.)amazon\.de$/, devise: 'EUR' },
  { motif: /(^|\.)amazon\.es$/, devise: 'EUR' },
  { motif: /(^|\.)amazon\.it$/, devise: 'EUR' },
  { motif: /(^|\.)amazon\.nl$/, devise: 'EUR' },
  { motif: /(^|\.)amazon\.be$/, devise: 'EUR' },
  { motif: /(^|\.)amazon\.co\.uk$/, devise: 'GBP' },
  { motif: /(^|\.)amazon\.com$/, devise: 'USD' },
  // Autres places de marché internationales.
  { motif: /(^|\.)ebay\.(fr|de|es|it|be|nl|at|ie)$/, devise: 'EUR' },
  { motif: /(^|\.)ebay\.co\.uk$/, devise: 'GBP' },
  { motif: /(^|\.)ebay\.com$/, devise: 'USD' },
  { motif: /(^|\.)aliexpress\.com$/, devise: 'EUR', pourquoi: 'AliExpress facture dans la devise de l\'acheteur ; EUR par défaut en France' },
  { motif: /(^|\.)etsy\.com$/, devise: 'EUR', pourquoi: 'Etsy facture dans la devise de l\'acheteur' },
];

/** Domaine de premier niveau → devise du pays. */
const DEVISES_PAR_TLD = {
  fr: 'EUR', de: 'EUR', es: 'EUR', it: 'EUR', be: 'EUR', nl: 'EUR',
  pt: 'EUR', at: 'EUR', ie: 'EUR', lu: 'EUR', fi: 'EUR', gr: 'EUR',
  uk: 'GBP', ch: 'CHF', ca: 'CAD', jp: 'JPY', cn: 'CNY', us: 'USD',
};

/** Domaine à deux niveaux qui change tout (co.uk n'est pas « uk »). */
const TLD_COMPOSES = { 'co.uk': 'GBP', 'org.uk': 'GBP', 'com.au': 'AUD', 'co.jp': 'JPY' };

/**
 * Devise probable d'une URL fournisseur.
 * Renvoie `{ devise, source, pourquoi }` — `source` dit d'où vient la réponse,
 * pour que l'écran puisse l'expliquer au lieu de l'imposer.
 */
export function devisePourUrl(url) {
  const brut = String(url || '').trim();
  if (!brut) return { devise: null, source: 'aucune', pourquoi: 'aucune URL fournie' };

  let hote;
  try {
    hote = new URL(brut.includes('://') ? brut : `https://${brut}`).hostname.toLowerCase();
  } catch {
    return { devise: null, source: 'aucune', pourquoi: 'URL illisible' };
  }

  for (const regle of DEVISES_PAR_DOMAINE) {
    if (regle.motif.test(hote)) {
      return {
        devise: regle.devise,
        source: 'domaine',
        pourquoi: regle.pourquoi || `le domaine ${hote} publie ses prix en ${regle.devise}`,
      };
    }
  }

  // TLD composé d'abord (co.uk, com.au…), sinon le dernier segment.
  const parties = hote.split('.');
  const deuxDerniers = parties.slice(-2).join('.');
  if (TLD_COMPOSES[deuxDerniers]) {
    return { devise: TLD_COMPOSES[deuxDerniers], source: 'pays', pourquoi: `extension .${deuxDerniers}` };
  }
  const tld = parties[parties.length - 1];
  if (DEVISES_PAR_TLD[tld]) {
    return { devise: DEVISES_PAR_TLD[tld], source: 'pays', pourquoi: `extension .${tld}` };
  }

  return {
    devise: 'USD',
    source: 'defaut',
    pourquoi: 'devise du commerce international quand le pays n\'est pas identifiable',
  };
}
