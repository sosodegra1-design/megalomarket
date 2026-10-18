/**
 * Tri automatique des annonces : tout ce qui concerne la LUMIÈRE (lampes, luminaires,
 * guirlandes, éclairage LED…) va dans la catégorie « lumivita », le catalogue
 * professionnel d'éclairage. Détection par mots-clés, en français, anglais,
 * allemand, espagnol et polonais.
 *
 * Deux niveaux, pour éviter qu'un jouet « avec son et lumière » parte chez LumiVita :
 *  - mots FORTS (lampe, luminaire, guirlande lumineuse…) : suffisent s'ils sont dans le titre ;
 *  - mots FAIBLES (lumière, lumineux, LED, light) : il en faut au moins deux, et
 *    jamais sur un produit manifestement un jouet ou un accessoire animalier.
 */

export const LUMIVITA_CATEGORY = 'lumivita';

const STRONG = [
  'lampe', 'lampes', 'lamp', 'lamps', 'luminaire', 'luminaires', 'lampara', 'lamparas', 'lampa', 'lampy',
  'lampada', 'leuchte', 'leuchten', 'lampen', 'ampoule', 'ampoules', 'bulb', 'bulbs',
  'guirlande lumineuse', 'guirlandes lumineuses', 'string light', 'string lights', 'fairy light', 'fairy lights',
  'eclairage', 'beleuchtung', 'iluminacion', 'oswietlenie', 'lighting',
  'veilleuse', 'night light', 'nightlight', 'lanterne', 'lanternes', 'lantern', 'lanterns',
  'plafonnier', 'applique murale', 'lustre', 'chandelier', 'suspension lumineuse', 'pendant light',
  'projecteur led', 'spot led', 'led strip', 'bande led', 'ruban led', 'neon sign', 'enseigne lumineuse',
  'lumiere decorative', 'decoration lumineuse', 'lampadaire', 'floor lamp', 'table lamp', 'lampe de table', 'lampe de chevet',
];

const WEAK = ['lumiere', 'lumieres', 'lumineux', 'lumineuse', 'lumineuses', 'light', 'lights', 'led', 'luz', 'licht', 'swiatlo'];

const NOT_LIGHTING = [
  'jouet', 'jouets', 'toy', 'toys', 'spielzeug', 'juguete', 'zabawka', 'balle', 'ball', 'chat', 'chien', 'cat', 'dog', 'pet',
  'bebe', 'baby', 'peluche', 'poupee', 'doll', 'squishy', 'voiture', 'robot', 'drone',
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasTerm(haystack, term) {
  return new RegExp(`(^| )${term.replace(/ /g, ' ')}( |$)`).test(haystack);
}

/** Retourne « lumivita » si l'annonce concerne de l'éclairage, sinon null. */
export function detectCategory({ title = '', rawDescription = '' } = {}) {
  const t = normalize(title);
  const d = normalize(rawDescription).slice(0, 2000);

  // Mots composés allemands (Tischlampe, Wandleuchte, Stehlampen…).
  const compound = /(^| )[a-z]*(lampe|lampen|leuchte|leuchten)( |$)/;
  if (STRONG.some((term) => hasTerm(t, term)) || compound.test(t)) return LUMIVITA_CATEGORY;

  const lightToy = NOT_LIGHTING.some((term) => hasTerm(t, term));
  if (lightToy) return null;

  const weakHits = new Set(WEAK.filter((term) => hasTerm(t, term) || hasTerm(d, term)));
  const strongInDescription = STRONG.filter((term) => hasTerm(d, term)).length;
  if (weakHits.size >= 2 || (weakHits.size >= 1 && strongInDescription >= 2)) return LUMIVITA_CATEGORY;
  return null;
}

/** Clé de comparaison de deux titres : insensible à la casse, aux accents et à la ponctuation. */
export function normalizeTitleKey(title) {
  return normalize(title).replace(/ (buy product on alibaba com|alibaba com)$/, '');
}
