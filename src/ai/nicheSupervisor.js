import { askModel, parseJsonFromModel } from './client.js';
import { dbAll, dbRun, logActivity } from '../db/database.js';

/*
 * Agent « superviseur » du Dénicheur.
 *
 * Il ne dispose d'aucune donnée de vente réelle de plus que le chasseur
 * (nicheHunter.js) — ce n'est pas une seconde source de vérité, c'est un
 * second regard qui relit un lot déjà généré pour attraper ce qu'un humain
 * relisant la liste attraperait : une piste de sourcing qui ne correspond
 * pas au produit, un nom de fournisseur précis inventé (la consigne du
 * chasseur l'interdit déjà, mais un modèle peut y déroger), un prix hors de
 * toute réalité pour ce type de produit, ou un doublon déguisé sous un autre
 * titre. Chaque ligne relue est marquée ok/à vérifier, jamais supprimée : la
 * décision finale reste humaine.
 */

const SUPERVISOR_SYSTEM_PROMPT = `Tu es superviseur qualité pour un chasseur de tendances e-commerce IA. On te donne une liste de suggestions de produits, une par ligne, avec leur rang.
Réponds UNIQUEMENT avec un objet JSON valide, au format exact :
{"reviewed": [{"rank": 1, "ok": true, "issue": null}, ...]}
Une entrée par rang reçu, dans l'ordre. "ok" est false si tu repères : une piste de sourcing incohérente avec le produit (ex. un fournisseur textile pour un objet électronique), un nom d'entreprise ou de fournisseur précis (un nom propre, jamais autorisé — seul un TYPE de fournisseur et une région le sont), une fourchette de prix manifestement irréaliste pour ce type de produit, ou un titre quasi identique à un autre rang de la liste.
"issue" décrit le problème en une phrase courte en français ("issue" est null si "ok" est true).`;

function buildReviewPrompt(finds) {
  return finds.map((f) => (
    `#${f.rank} — ${f.title} | catégorie: ${f.category || '—'} | prix: ${f.priceRange || '—'} | sourcing: ${f.sourcingHint || '—'}`
  )).join('\n');
}

/* Normalisation tolérante aux accents/ponctuation : "Gourde isotherme 750ml"
   et "Gourde Isotherme, 750 ml" doivent être reconnus comme le même titre. */
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Doublons détectés en code plutôt qu'espérés du modèle : une comparaison de
   chaînes normalisées est un FAIT vérifiable et gratuit, alors qu'un modèle
   peut simplement l'oublier au milieu de 20 lignes. Les deux mécanismes se
   complètent : le code attrape les doublons, le modèle attrape le reste. */
function findDuplicateIssues(finds) {
  const issues = new Map();
  const seen = new Map();
  for (const find of finds) {
    const key = normalizeTitle(find.title);
    if (!key) continue;
    if (seen.has(key)) {
      const firstRank = seen.get(key);
      issues.set(find.rank, `Titre quasi identique au rang #${firstRank}.`);
      if (!issues.has(firstRank)) issues.set(firstRank, `Titre quasi identique au rang #${find.rank}.`);
    } else {
      seen.set(key, find.rank);
    }
  }
  return issues;
}

/**
 * Relit un lot déjà généré (en mémoire, sans DB — testable seule). Un échec
 * de l'appel IA n'invente jamais de verdict : les lignes retombent à
 * `ok: null` (« non vérifiée »), jamais à un faux "ok".
 */
export async function reviewFinds(finds) {
  const duplicateIssues = findDuplicateIssues(finds);

  const modelReview = new Map();
  let modelError = null;
  try {
    const raw = await askModel({
      system: SUPERVISOR_SYSTEM_PROMPT,
      prompt: buildReviewPrompt(finds),
      maxTokens: 2000,
    });
    const parsed = parseJsonFromModel(raw);
    const reviewed = Array.isArray(parsed?.reviewed) ? parsed.reviewed : [];
    for (const entry of reviewed) {
      if (Number.isInteger(entry?.rank)) {
        modelReview.set(entry.rank, {
          ok: Boolean(entry.ok),
          issue: entry.issue ? String(entry.issue) : null,
        });
      }
    }
  } catch (error) {
    modelError = error.message;
  }

  const reviewed = finds.map((find) => {
    // Un doublon détecté en code l'emporte toujours : c'est un fait vérifiable,
    // pas une opinion, contrairement au reste du contrôle.
    const duplicateIssue = duplicateIssues.get(find.rank);
    if (duplicateIssue) return { rank: find.rank, ok: false, issue: duplicateIssue };

    const fromModel = modelReview.get(find.rank);
    if (fromModel) return { rank: find.rank, ok: fromModel.ok, issue: fromModel.issue };

    return {
      rank: find.rank,
      ok: null,
      issue: modelError ? `Vérification IA indisponible : ${modelError}` : 'Non incluse dans la réponse IA.',
    };
  });

  return { reviewed, error: modelError };
}

/** Relit le lot `batchId` et enregistre le verdict par ligne. */
export async function reviewBatch(batchId) {
  const finds = await dbAll(
    'SELECT rank, title, category, price_range AS priceRange, sourcing_hint AS sourcingHint FROM trend_finds WHERE batch_id = ? ORDER BY rank ASC',
    [batchId],
  );
  if (!finds.length) throw new Error(`Lot introuvable (batch_id=${batchId}).`);

  const { reviewed, error } = await reviewFinds(finds);

  for (const entry of reviewed) {
    await dbRun(
      'UPDATE trend_finds SET review_ok = ?, review_issue = ? WHERE batch_id = ? AND rank = ?',
      [entry.ok === null ? null : (entry.ok ? 1 : 0), entry.issue, batchId, entry.rank],
    );
  }

  const flagged = reviewed.filter((r) => r.ok === false).length;
  await logActivity(
    'DENICHEUR_SUPERVISION',
    `Supervision du lot ${batchId} : ${flagged} suggestion(s) signalée(s) sur ${reviewed.length}`
    + (error ? ` (vérification IA partielle : ${error})` : '') + '.',
  );

  return { batchId, reviewed, error };
}
