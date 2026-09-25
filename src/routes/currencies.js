import { Router } from 'express';
import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';

/*
 * Tableau des devises — lecture et correction des taux.
 *
 * Pourquoi une route plutôt qu'une constante dans le code : le taux de change
 * n'est pas une vérité technique, c'est une donnée commerciale qui vieillit et
 * que le propriétaire doit pouvoir corriger sans redéployer. Le jour où le yuan
 * bouge de 5 %, il ajuste une ligne au lieu d'attendre une livraison de code.
 *
 * Les taux sont SAISIS À LA MAIN, sans API : une API de change tomberait en
 * panne au moment précis où l'on calcule un prix, et ferait bouger des prix de
 * vente tout seuls. Voir currency-data.js pour le raisonnement complet.
 */

export const currenciesRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

/* Le tri est alphabétique sur le PAYS : c'est ce que l'utilisateur cherche —
   « Chine », pas « CNY ». Trier par code obligerait à connaître les sigles. */
currenciesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json(await dbAll(
      'SELECT code, country, name, rate_to_eur, updated_at FROM currencies ORDER BY country COLLATE NOCASE',
    ));
  }),
);

/** Valide un taux : strictement positif, fini, et pas une chaîne numérique. */
function parseRate(value) {
  if (typeof value === 'string') {
    throw new Error('Le taux doit être un nombre, pas une chaîne.');
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Taux invalide : un nombre strictement supérieur à 0 est attendu (valeur en euros d’une unité).');
  }
  return value;
}

currenciesRouter.patch(
  '/:code',
  asyncRoute(async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const { rateToEur, country, name } = req.body || {};

    const existing = await dbGet('SELECT code FROM currencies WHERE code = ?', [code]);
    if (!existing) throw new Error(`Devise inconnue : ${code}.`);

    const fields = [];
    const values = [];

    if (rateToEur !== undefined) {
      fields.push('rate_to_eur = ?');
      values.push(parseRate(rateToEur));
    }
    if (country !== undefined) {
      if (typeof country !== 'string' || !country.trim()) throw new Error('Pays invalide.');
      fields.push('country = ?');
      values.push(country.trim());
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('Nom de devise invalide.');
      fields.push('name = ?');
      values.push(name.trim());
    }
    if (!fields.length) throw new Error('Aucun champ à modifier.');

    fields.push('updated_at = ?');
    values.push(Date.now(), code);
    await dbRun(`UPDATE currencies SET ${fields.join(', ')} WHERE code = ?`, values);

    /* Le journal garde la trace du CHANGEMENT de taux, pas seulement de l'acte :
       six mois plus tard, « pourquoi ce prix était-il si bas ? » se répond en
       retrouvant le taux qui avait cours ce jour-là. */
    if (rateToEur !== undefined) {
      await logActivity('DEVISE', `Taux ${code} mis à jour : 1 ${code} = ${rateToEur} EUR.`);
    }

    res.json(await dbGet('SELECT code, country, name, rate_to_eur, updated_at FROM currencies WHERE code = ?', [code]));
  }),
);

/**
 * Ajoute une devise absente du catalogue. Utile le jour où un fournisseur
 * facture dans une monnaie que le hub ne connaît pas encore : sans cette route,
 * l'import resterait incalculable jusqu'au prochain déploiement.
 */
currenciesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { code, country, name, rateToEur } = req.body || {};

    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(clean)) {
      throw new Error('Code de devise invalide : trois lettres attendues (ex. CNY).');
    }
    if (typeof country !== 'string' || !country.trim()) throw new Error('Pays manquant.');
    if (typeof name !== 'string' || !name.trim()) throw new Error('Nom de devise manquant.');

    const existing = await dbGet('SELECT code FROM currencies WHERE code = ?', [clean]);
    if (existing) throw new Error(`La devise ${clean} existe déjà — modifie-la plutôt que de la recréer.`);

    await dbRun(
      'INSERT INTO currencies (code, country, name, rate_to_eur, updated_at) VALUES (?, ?, ?, ?, ?)',
      [clean, country.trim(), name.trim(), parseRate(rateToEur), Date.now()],
    );
    await logActivity('DEVISE', `Devise ajoutée : ${country.trim()} — ${name.trim()} (${clean}).`);

    res.status(201).json(await dbGet('SELECT code, country, name, rate_to_eur, updated_at FROM currencies WHERE code = ?', [clean]));
  }),
);
