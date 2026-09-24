import { dbAll, dbRun, logActivity } from '../db/database.js';
import { inspectImages } from '../ai/visionInspector.js';

/*
 * Superviseur qualité périodique des fiches déjà PUBLIÉES (planifié toutes
 * les 30 min, voir services/scheduler.js) — répond à un bug réel : une photo
 * sans rapport avec le produit (un câble USB dans la galerie d'un blender)
 * publiée sans qu'aucun contrôle ne l'ait repérée. L'agent de contrôle
 * visuel (inspectImages, src/ai/visionInspector.js) existait déjà mais
 * n'était jusque-là déclenché que sur demande explicite (pipeline Dénicheur,
 * bouton "Vérifier les photos" de l'import) — jamais de façon récurrente sur
 * ce qui est déjà en ligne.
 *
 * Chaque fiche n'est relue QU'UNE FOIS (quality_checked_at marqué après le
 * premier passage, succès ou échec) : ni pour économiser le quota Anthropic,
 * ni parce qu'un signalement raté se corrigerait tout seul au tour suivant —
 * mais parce qu'un import déjà publié ne change pas de photos tout seul (les
 * modifier repasse par PATCH /api/imports/:id, qui ne touche pas ce statut :
 * une vraie remise à zéro demanderait un geste explicite, hors périmètre
 * ici). Ça couvre aussi, en tâche de fond et sans rien reconfigurer, tout ce
 * qui a été publié AVANT ce correctif : quality_checked_at y est NULL, donc
 * rattrapé au fil des cycles suivants comme n'importe quelle fiche neuve.
 */
const BATCH_LIMIT = 5; // borne le coût (appel vision) et la latence d'un cycle

export async function runQualitySupervision() {
  const rows = await dbAll(
    `SELECT il.id AS listing_id, il.title, il.marketplace, i.image_urls
     FROM import_listings il
     JOIN imports i ON i.id = il.import_id
     WHERE il.status = 'publie' AND il.quality_checked_at IS NULL
     ORDER BY il.updated_at ASC
     LIMIT ?`,
    [BATCH_LIMIT],
  );
  if (!rows.length) return { checked: 0, flagged: 0 };

  let flagged = 0;
  for (const row of rows) {
    let imageUrls = [];
    try {
      imageUrls = JSON.parse(row.image_urls || '[]');
    } catch { /* photos illisibles : inspectImages le signalera via "Aucune image fournie" */ }

    let verdict;
    try {
      verdict = await inspectImages({ title: row.title, imageUrls });
    } catch (error) {
      // inspectImages() ne lève normalement pas (elle renvoie overallOk:false
      // pour ses propres échecs) — ce filet couvre uniquement l'imprévu, pour
      // qu'une seule fiche en erreur n'empêche jamais le reste du lot.
      verdict = { overallOk: false, summary: error?.message ?? String(error) };
    }

    await dbRun(
      'UPDATE import_listings SET quality_checked_at = ?, quality_ok = ?, quality_issue = ? WHERE id = ?',
      [Date.now(), verdict.overallOk ? 1 : 0, verdict.overallOk ? null : (verdict.summary || null), row.listing_id],
    );

    if (!verdict.overallOk) {
      flagged += 1;
      await logActivity(
        'CONTROLE_QUALITE_ALERTE',
        `Contrôle qualité : photo(s) suspecte(s) sur « ${row.title} » (${row.marketplace}) — ${verdict.summary || 'voir le détail dans la fiche'}.`,
      );
    }
  }

  return { checked: rows.length, flagged };
}
