import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';
import { scrapeProductFromUrl } from '../importer/scraper.js';

/*
 * L'AGENT QUI COMPLÈTE UNE FICHE INCOMPLÈTE.
 *
 * CONSTAT. Les imports arrivent régulièrement amputés : la veste de pluie est
 * entrée avec son prix mais SANS photo et SANS poids — le scraping avait rendu
 * une page partielle, et personne ne s'en apercevait avant d'ouvrir la fiche.
 * Or sans photo le site refuse de publier, et sans poids le port est facturé au
 * forfait de 28 €, ce qui triple le prix.
 *
 * CE QUE FAIT CET AGENT. Il regarde ce qui manque, retourne sur la page
 * fournisseur, et ne remplit QUE les trous — jamais ce qui est déjà là. Un
 * import complet n'est pas retouché : on ne réécrit pas une donnée validée à la
 * main sur la foi d'un scraping.
 *
 * CE QU'IL NE FAIT PAS. Il n'invente rien. Si la page ne donne pas le poids, il
 * le dit et laisse le champ vide : un poids deviné fausserait le prix de vente
 * sans que personne ne le voie.
 */

/** Ce qui manque à une fiche, dans l'ordre où ça bloque. */
export function manquesImport(imp, images) {
  const manques = [];
  if (!images.length) manques.push('photos');
  if (!imp.weight_g) manques.push('poids');
  if (!imp.moq) manques.push('MOQ');
  return manques;
}

/**
 * Complète un import depuis sa page fournisseur.
 * Renvoie `{ complet, remplis, restants, raison }` — jamais une exception pour
 * un simple manque de données : l'appelant doit pouvoir continuer.
 */
export async function repairImport(importId, { timeoutMs = 60000 } = {}) {
  const imp = await dbGet('SELECT * FROM imports WHERE id = ?', [importId]);
  if (!imp) throw new Error(`Import introuvable (id=${importId}).`);

  const images = (() => {
    try { return JSON.parse(imp.image_urls || '[]'); } catch { return []; }
  })();

  const manques = manquesImport(imp, images);
  if (!manques.length) {
    return { complet: true, remplis: [], restants: [], raison: null };
  }
  if (!imp.source_url) {
    return { complet: false, remplis: [], restants: manques, raison: 'aucun lien fournisseur : impossible de relire la page' };
  }

  let page;
  try {
    page = await scrapeProductFromUrl(imp.source_url, { timeoutMs });
  } catch (error) {
    return { complet: false, remplis: [], restants: manques, raison: `page illisible : ${String(error.message).slice(0, 120)}` };
  }

  const aEcrire = {};
  const remplis = [];

  if (!images.length && Array.isArray(page.imageUrls) && page.imageUrls.length) {
    aEcrire.image_urls = JSON.stringify(page.imageUrls);
    remplis.push(`photos (${page.imageUrls.length})`);
  }
  if (!imp.weight_g && Number(page.weightGrams) > 0) {
    aEcrire.weight_g = Math.round(Number(page.weightGrams));
    remplis.push(`poids (${aEcrire.weight_g} g)`);
  }
  if (!imp.moq && Number(page.moq) > 0) {
    aEcrire.moq = Math.round(Number(page.moq));
    aEcrire.lot_quantity = aEcrire.moq;
    remplis.push(`MOQ (${aEcrire.moq})`);
  }

  if (!remplis.length) {
    return {
      complet: false,
      remplis: [],
      restants: manques,
      raison: `la page ne donne pas : ${manques.join(', ')}`,
    };
  }

  const colonnes = Object.keys(aEcrire).map((c) => `${c} = ?`).join(', ');
  await dbRun(`UPDATE imports SET ${colonnes} WHERE id = ?`, [...Object.values(aEcrire), importId]);

  const imagesApres = aEcrire.image_urls ? JSON.parse(aEcrire.image_urls) : images;
  const impApres = { ...imp, ...aEcrire };
  const restants = manquesImport(impApres, imagesApres);

  await logActivity(
    'FICHE_COMPLETEE',
    `Import #${importId} complété : ${remplis.join(', ')}.`
      + (restants.length ? ` Reste à renseigner : ${restants.join(', ')}.` : ''),
  );

  return { complet: restants.length === 0, remplis, restants, raison: null };
}

/** Passe tous les imports en revue et complète ceux qui peuvent l'être. */
export async function repairAllImports({ limite = 40, timeoutMs = 60000 } = {}) {
  const rows = await dbAll(
    `SELECT id FROM imports
     WHERE (image_urls IS NULL OR image_urls = '[]' OR length(image_urls) < 5)
        OR weight_g IS NULL
     ORDER BY id DESC LIMIT ?`,
    [limite],
  );
  const resultats = [];
  for (const r of rows) {
    try {
      resultats.push({ importId: r.id, ...(await repairImport(r.id, { timeoutMs })) });
    } catch (error) {
      resultats.push({ importId: r.id, complet: false, remplis: [], restants: [], raison: String(error.message).slice(0, 140) });
    }
  }
  return {
    examines: rows.length,
    completes: resultats.filter((r) => r.complet).length,
    amendes: resultats.filter((r) => r.remplis.length).length,
    resultats,
  };
}
