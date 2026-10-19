import { dbGet, dbRun } from '../db/database.js';
import { config } from '../config/env.js';

/*
 * Le multiplicateur de marge — un choix simple, pas un décimal libre.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * Le hub portait TROIS mécanismes de marge, dont un seul était lisible :
 *
 *   1. `PRICING_MARGIN_COEFFICIENT` (variable d'environnement) — appliqué, mais
 *      invisible dans l'interface et modifiable seulement par un redéploiement ;
 *   2. un « barème par paliers » dans le navigateur — affiché, modifiable… et
 *      **jamais appliqué** (le code le disait lui-même : « pas une nouvelle
 *      règle de calcul ») ;
 *   3. `margin_coefficient` par partenaire — appliqué.
 *
 * Un réglage qu'on peut modifier sans effet est pire qu'absent : on croit avoir
 * changé sa marge, et le prix reste le même.
 *
 * ICI, UN SEUL ENDROIT, UNE SEULE RÈGLE
 * -------------------------------------
 *   prix de vente = (prix d'achat + transport) × multiplicateur
 *
 * Le multiplicateur est un choix parmi une liste courte (×2, ×3, ×4…), stocké en
 * base pour être modifiable sans redéploiement. Il n'y a plus de décimal libre
 * à interpréter : « ×3 » se comprend sans calculette.
 *
 * L'ordre de priorité reste celui qui avait du sens :
 *   multiplicateur du partenaire (négocié) > multiplicateur du hub > défaut 3.
 */

const CLE = 'pricing_multiplier';

/* Liste courte et fermée, mais qui doit couvrir la marge RÉELLE.
 *
 * La première version s'arrêtait à ×5, en supposant que c'était large. Faux :
 * revendre 3 € à 19,90 € demande ×6,63. Une liste trop courte ne simplifie pas,
 * elle rend le prix cible INATTEIGNABLE — c'est pire qu'un décimal libre.
 *
 * D'où ×6 et ×8. Elles couvrent les reventes à forte valeur ajoutée (petit
 * objet acheté en gros, vendu au détail) sans réintroduire un champ libre.
 * Toutes restent des entiers ou des demi-entiers, lisibles d'un coup d'œil. */
export const MULTIPLICATEURS = [1.5, 2, 2.5, 3, 4, 5, 6, 8];

export function multiplicateurValide(valeur) {
  const n = Number(valeur);
  return MULTIPLICATEURS.includes(n) ? n : null;
}

/** Le multiplicateur du hub : celui enregistré, sinon le défaut de configuration. */
export async function getMultiplicateur() {
  const ligne = await dbGet('SELECT value FROM app_state WHERE key = ?', [CLE]);
  const enBase = ligne ? multiplicateurValide(ligne.value) : null;
  if (enBase != null) return enBase;

  /* Repli sur la variable d'environnement : elle existe déjà en production et
     vaut souvent un décimal hérité (1.8 ou 6.6333). On ne le rejette pas — un
     multiplicateur reste un multiplicateur — mais on ne le propose plus. */
  const configure = Number(config.pricing.marginCoefficient);
  return Number.isFinite(configure) && configure > 0 ? configure : 3;
}

/** Enregistre le multiplicateur. Refuse tout ce qui n'est pas dans la liste. */
export async function setMultiplicateur(valeur) {
  const n = multiplicateurValide(valeur);
  if (n == null) {
    throw new Error(
      `Multiplicateur invalide : ${valeur}. Valeurs acceptées : ${MULTIPLICATEURS.map((m) => '×' + m).join(', ')}.`,
    );
  }
  await dbRun(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [CLE, String(n), Date.now()],
  );
  return n;
}
