import { Router } from 'express';
import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';
import { config } from '../config/env.js';

/*
 * Partenaires (fournisseurs et distributeurs) enregistrés une fois dans le hub.
 *
 * Le propriétaire travaille avec de nombreux acteurs dans le monde entier. Sans
 * ce registre, chaque import obligeait à retaper un nom et surtout à se souvenir
 * de la marge négociée avec chacun — or la plateforme de gros et le
 * distributeur local ne vendent manifestement pas au même prix. On enregistre
 * donc le partenaire une fois, et l'import ne fait plus que le désigner.
 */

export const suppliersRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

export const SUPPLIER_KINDS = ['fournisseur', 'distributeur'];
export const SUPPLIER_STATUSES = ['actif', 'inactif'];

/* Le nombre d'imports n'est pas une colonne : il se compte. La sous-requête
   évite un GROUP BY qui rendrait le LEFT JOIN fragile et garde la lecture
   simple à relire. */
const SELECT_SUPPLIERS = `
  SELECT s.*,
         (SELECT COUNT(*) FROM imports i WHERE i.supplier_id = s.id) AS import_count
  FROM suppliers s
`;

/**
 * Résout la marge réellement appliquée à un partenaire.
 *
 * `margin_coefficient` à NULL veut dire « utiliser le coefficient global » — ce
 * n'est PAS la même chose qu'une marge propre égale à ce coefficient, puisque le
 * défaut peut changer demain. On expose donc les deux valeurs : le tableau de
 * bord peut afficher « marge propre » ou « défaut global » sans deviner, et
 * l'import sait quel prix il a réellement calculé.
 */
export function withResolvedMargin(row) {
  if (!row) return row;
  const own = row.margin_coefficient;
  return {
    ...row,
    defaultMarginCoefficient: config.pricing.marginCoefficient,
    effectiveMarginCoefficient: own == null ? config.pricing.marginCoefficient : own,
    // Jamais affiché comme une marge « du partenaire » : c'est le défaut du hub.
    usesDefaultMargin: own == null,
  };
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Identifiant de partenaire invalide.');
  return id;
}

function parseKind(value) {
  if (!SUPPLIER_KINDS.includes(value)) {
    throw new Error(
      `Type de partenaire invalide : valeurs acceptées ${SUPPLIER_KINDS.join(', ')} (reçu : ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

function parseName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error("Nom invalide : un nom non vide est attendu (c'est lui qui identifie le partenaire dans la liste d'import).");
  }
  return value.trim();
}

function parseSiteUrl(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('URL de site invalide : une adresse http(s) complète est attendue (ex. https://exemple.com).');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`URL de site invalide : « ${value.trim().slice(0, 80)} » n'est pas une adresse lisible. Une adresse http(s) complète est attendue (ex. https://exemple.com).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`URL de site invalide : seuls http et https sont acceptés (reçu : ${url.protocol}).`);
  }
  return value.trim();
}

function parseMargin(value) {
  if (value === null || value === undefined || value === '') return null;
  // On exige un vrai nombre, pas une chaîne numérique : accepter « 2,5 » ou
  // « 2.5 » en texte laisserait passer des valeurs vides ou mal comprises, et
  // c'est le prix de vente qui en dépendrait.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 1) {
    throw new Error(
      "Coefficient de marge invalide : il doit être strictement supérieur à 1, ou null pour utiliser le coefficient global. "
      + "En dessous de 1, le prix de vente passerait sous le prix d'achat — une vente à perte.",
    );
  }
  return value;
}

function parseStatus(value) {
  if (!SUPPLIER_STATUSES.includes(value)) {
    throw new Error(`Statut invalide : valeurs acceptées ${SUPPLIER_STATUSES.join(', ')} (reçu : ${JSON.stringify(value)}).`);
  }
  return value;
}

function parseNotes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Notes invalides : une chaîne de texte est attendue.');
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function readSupplier(id) {
  return dbGet(`${SELECT_SUPPLIERS} WHERE s.id = ?`, [id]);
}

// --- Liste des partenaires, filtrable par type ---
suppliersRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { kind } = req.query;
    // COLLATE NOCASE : « Éditions » et « editions » doivent se suivre, pas se
    // retrouver aux deux extrémités de la liste. Un filtre inconnu est refusé
    // plutôt qu'ignoré : sinon `?kind=fournissuer` renverrait tout, en silence.
    const rows = kind === undefined || kind === ''
      ? await dbAll(`${SELECT_SUPPLIERS} ORDER BY s.name COLLATE NOCASE ASC`)
      : await dbAll(`${SELECT_SUPPLIERS} WHERE s.kind = ? ORDER BY s.name COLLATE NOCASE ASC`, [parseKind(kind)]);
    res.json(rows.map(withResolvedMargin));
  }),
);

// --- Création d'un partenaire ---
suppliersRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { kind, name, siteUrl, marginCoefficient, status, notes } = req.body || {};

    const now = new Date().toISOString();
    const info = await dbRun(
      `INSERT INTO suppliers (kind, name, site_url, margin_coefficient, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parseKind(kind),
        parseName(name),
        parseSiteUrl(siteUrl),
        parseMargin(marginCoefficient),
        status === undefined ? 'actif' : parseStatus(status),
        parseNotes(notes),
        now,
        now,
      ],
    );

    const row = await readSupplier(info.lastInsertRowid);
    await logActivity('PARTENAIRE_CREE', `Partenaire enregistré : ${row.name} (${row.kind}).`);
    res.status(201).json(withResolvedMargin(row));
  }),
);

// --- Modification partielle ---
suppliersRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await dbGet('SELECT id FROM suppliers WHERE id = ?', [id]);
    if (!existing) throw new Error(`Partenaire introuvable (id=${id}).`);

    const body = req.body || {};
    const fields = [];
    const values = [];

    // Chaque champ n'est validé que s'il est fourni : un PATCH partiel ne doit
    // pas écraser ce qu'il ne mentionne pas (même règle que PATCH /api/imports).
    if (body.kind !== undefined) { fields.push('kind = ?'); values.push(parseKind(body.kind)); }
    if (body.name !== undefined) { fields.push('name = ?'); values.push(parseName(body.name)); }
    if (body.siteUrl !== undefined) { fields.push('site_url = ?'); values.push(parseSiteUrl(body.siteUrl)); }
    if (body.marginCoefficient !== undefined) {
      fields.push('margin_coefficient = ?');
      values.push(parseMargin(body.marginCoefficient));
    }
    if (body.status !== undefined) { fields.push('status = ?'); values.push(parseStatus(body.status)); }
    if (body.notes !== undefined) { fields.push('notes = ?'); values.push(parseNotes(body.notes)); }

    // Aucun champ exploitable : on refuse plutôt que de répondre « ok » sur une
    // requête qui n'a rien changé.
    if (!fields.length) throw new Error('Aucune modification fournie.');

    fields.push('updated_at = ?');
    values.push(new Date().toISOString(), id);
    await dbRun(`UPDATE suppliers SET ${fields.join(', ')} WHERE id = ?`, values);

    const row = await readSupplier(id);
    await logActivity('PARTENAIRE_MODIFIE', `Partenaire modifié : ${row.name} (${row.kind}).`);
    res.json(withResolvedMargin(row));
  }),
);

// --- Suppression : on détache, on ne détruit jamais l'historique ---
suppliersRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await dbGet('SELECT * FROM suppliers WHERE id = ?', [id]);
    if (!existing) throw new Error(`Partenaire introuvable (id=${id}).`);

    /* Un import est une archive : prix d'achat, fiches générées, identifiants de
       publication déjà envoyés aux canaux. Supprimer ces lignes parce qu'on
       retire un partenaire de la liste effacerait des ventes passées et
       fausserait l'historique. On coupe donc le lien (supplier_id = NULL) avant
       de supprimer la fiche : l'import reste lisible, simplement « sans
       partenaire enregistré ». */
    const detached = await dbRun('UPDATE imports SET supplier_id = NULL WHERE supplier_id = ?', [id]);
    await dbRun('DELETE FROM suppliers WHERE id = ?', [id]);
    await logActivity(
      'PARTENAIRE_SUPPRIME',
      `Partenaire supprimé : ${existing.name} (${existing.kind}) — ${detached.changes} import(s) conservé(s) et détaché(s).`,
    );
    res.json({ ok: true, detachedImports: detached.changes });
  }),
);
