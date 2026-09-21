import { Router } from 'express';
import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';

/*
 * Registre des distributeurs (GET/POST/PATCH/DELETE /api/distributors).
 *
 * Un distributeur est une entreprise à qui Megalomarket vend en gros — la
 * relation inverse d'un fournisseur ou d'un `kind: 'distributeur'` de
 * suppliers.js (qui, eux, désignent des plateformes où l'on ACHÈTE). Pas de
 * marge à négocier ici, pas d'import rattaché : juste un carnet de contacts
 * commerciaux pour ne pas retaper un nom et un e-mail à chaque échange.
 */

export const distributorsRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

export const DISTRIBUTOR_STATUSES = ['actif', 'inactif'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Identifiant de distributeur invalide.');
  return id;
}

function parseName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error("Nom invalide : un nom non vide est attendu (c'est lui qui identifie le distributeur dans la liste).");
  }
  return value.trim();
}

function parseEmail(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim())) {
    throw new Error(`E-mail de contact invalide : « ${String(value).slice(0, 80)} » ne ressemble pas à une adresse valide.`);
  }
  return value.trim();
}

function parseRegion(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Région invalide : une chaîne de texte est attendue.');
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseStatus(value) {
  if (!DISTRIBUTOR_STATUSES.includes(value)) {
    throw new Error(`Statut invalide : valeurs acceptées ${DISTRIBUTOR_STATUSES.join(', ')} (reçu : ${JSON.stringify(value)}).`);
  }
  return value;
}

function parseNotes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Notes invalides : une chaîne de texte est attendue.');
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function readDistributor(id) {
  return dbGet('SELECT * FROM distributors WHERE id = ?', [id]);
}

// --- Liste des distributeurs, filtrable par statut ---
distributorsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { status } = req.query;
    const rows = status === undefined || status === ''
      ? await dbAll('SELECT * FROM distributors ORDER BY name COLLATE NOCASE ASC')
      : await dbAll('SELECT * FROM distributors WHERE status = ? ORDER BY name COLLATE NOCASE ASC', [parseStatus(status)]);
    res.json(rows);
  }),
);

// --- Création ---
distributorsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { name, contactEmail, region, status, notes } = req.body || {};

    const now = new Date().toISOString();
    const info = await dbRun(
      `INSERT INTO distributors (name, contact_email, region, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        parseName(name),
        parseEmail(contactEmail),
        parseRegion(region),
        status === undefined ? 'actif' : parseStatus(status),
        parseNotes(notes),
        now,
        now,
      ],
    );

    const row = await readDistributor(info.lastInsertRowid);
    await logActivity('DISTRIBUTEUR_CREE', `Distributeur enregistré : ${row.name}.`);
    res.status(201).json(row);
  }),
);

// --- Modification partielle ---
distributorsRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await dbGet('SELECT id FROM distributors WHERE id = ?', [id]);
    if (!existing) throw new Error(`Distributeur introuvable (id=${id}).`);

    const body = req.body || {};
    const fields = [];
    const values = [];

    if (body.name !== undefined) { fields.push('name = ?'); values.push(parseName(body.name)); }
    if (body.contactEmail !== undefined) { fields.push('contact_email = ?'); values.push(parseEmail(body.contactEmail)); }
    if (body.region !== undefined) { fields.push('region = ?'); values.push(parseRegion(body.region)); }
    if (body.status !== undefined) { fields.push('status = ?'); values.push(parseStatus(body.status)); }
    if (body.notes !== undefined) { fields.push('notes = ?'); values.push(parseNotes(body.notes)); }

    if (!fields.length) throw new Error('Aucune modification fournie.');

    fields.push('updated_at = ?');
    values.push(new Date().toISOString(), id);
    await dbRun(`UPDATE distributors SET ${fields.join(', ')} WHERE id = ?`, values);

    const row = await readDistributor(id);
    await logActivity('DISTRIBUTEUR_MODIFIE', `Distributeur modifié : ${row.name}.`);
    res.json(row);
  }),
);

// --- Suppression ---
distributorsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await dbGet('SELECT * FROM distributors WHERE id = ?', [id]);
    if (!existing) throw new Error(`Distributeur introuvable (id=${id}).`);

    await dbRun('DELETE FROM distributors WHERE id = ?', [id]);
    await logActivity('DISTRIBUTEUR_SUPPRIME', `Distributeur supprimé : ${existing.name}.`);
    res.json({ ok: true });
  }),
);
