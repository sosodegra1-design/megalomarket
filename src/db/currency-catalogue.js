import { dbAll, dbRun } from './database.js';
import { CURRENCY_CATALOGUE } from './currency-data.js';

/*
 * Catalogue des devises, avec leur PAYS et leur NOM en clair.
 *
 * Pourquoi un tableau plutôt qu'une conversion à la volée : le hub importe
 * depuis la Chine (prix en dollars ou en yuans) et revend en euros. Sans taux,
 * `computeSuggestedPrice` multipliait un prix en dollars par un coefficient et
 * appelait le résultat des euros — un prix faux, silencieusement faux. C'est le
 * défaut que ce tableau corrige.
 *
 * LES TAUX SONT SAISIS À LA MAIN, ET C'EST VOLONTAIRE.
 * Une API de change, c'est une clé de plus, une panne possible au moment précis
 * où l'on calcule un prix, et un chiffre qui bouge sous les pieds sans
 * prévenir — un prix de vente recalculé tout seul parce que le dollar a glissé
 * de 2 % serait ingérable. Ici le taux est une donnée que le propriétaire
 * contrôle et voit. En contrepartie, il vieillit : d'où la colonne
 * `updated_at`, qui permet de repérer un taux périmé.
 *
 * `rate_to_eur` = valeur en euros d'UNE unité de la devise.
 *   EUR → 1        (par définition)
 *   USD → 0,92     (1 dollar = 0,92 euro)
 *   CNY → 0,13     (1 yuan = 0,13 euro)
 *
 * Les valeurs ci-dessous sont des POINTS DE DÉPART, pas des cours certifiés :
 * elles servent à ce que le hub soit utilisable immédiatement, et sont destinées
 * à être corrigées depuis l'écran Paramètres.
 */

/* Le pays est celui de la zone d'émission, pas la nationalité de la devise :
   l'euro est rattaché à « Zone euro » parce qu'il n'appartient à aucun pays en
   particulier — écrire « France » ferait croire que l'euro n'est que français. */


/* Table de correspondance code → taux, telle que l'attend `pricing.js`.
   Une seule requête, réutilisable pour tout un import : recalculer le taux à
   chaque ligne ferait autant d'allers-retours que de fiches. */
export async function loadCurrencyRates() {
  const rows = await dbAll('SELECT code, rate_to_eur FROM currencies');
  const rates = {};
  for (const row of rows) rates[row.code] = row.rate_to_eur;
  return rates;
}

/* Installation unique : la table n'est remplie que si elle est vide, donc un
   taux corrigé à la main n'est JAMAIS écrasé par un redéploiement. C'est la
   même règle que le catalogue des partenaires et celui des transporteurs. */
export async function seedCurrenciesIfEmpty() {
  const existing = await dbAll('SELECT code FROM currencies');
  if (existing.length > 0) return { seeded: 0 };

  const now = Date.now();
  for (const devise of CURRENCY_CATALOGUE) {
    await dbRun(
      'INSERT INTO currencies (code, country, name, rate_to_eur, updated_at) VALUES (?, ?, ?, ?, ?)',
      [devise.code, devise.country, devise.name, devise.rateToEur, now],
    );
  }
  return { seeded: CURRENCY_CATALOGUE.length };
}
