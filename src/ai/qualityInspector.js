import { askModel, parseJsonFromModel } from './client.js';

/*
 * Agent 3b/3c — contrôle éditorial et catégorisation. Le contrôle visuel
 * (Agent 3a) vit à part dans visionInspector.js, car lui seul a besoin de
 * Claude spécifiquement (vision) plutôt que du fournisseur IA générique.
 */

const EDITORIAL_SYSTEM_PROMPT = `Tu es relecteur éditorial pour un site e-commerce familial (BBVOLTEX). On te donne un titre et une description de fiche produit.
Réponds UNIQUEMENT avec un objet JSON valide : {"ok":true,"issues":["..."]}
"ok" est false si tu trouves : des fautes d'orthographe ou de grammaire notables, une incohérence de sens entre le titre et la description, une promesse non vérifiable présentée comme un fait établi (allégation santé, sécurité ou performance non prouvable), ou un contenu inapproprié pour un site familial.
Liste chaque problème trouvé dans "issues" (tableau vide si "ok" est true).`;

/** Contrôle éditorial (Agent 3b) : orthographe, cohérence, éthique. Un appel IA qui échoue est un échec de contrôle, jamais une exception qui plante le pipeline. */
export async function editorialCheck({ title, description }) {
  let raw;
  try {
    raw = await askModel({
      system: EDITORIAL_SYSTEM_PROMPT,
      prompt: `Titre : ${title}\n\nDescription :\n${description}`,
      maxTokens: 400,
    });
  } catch (error) {
    return { ok: false, issues: [error.message] };
  }
  let parsed;
  try {
    parsed = parseJsonFromModel(raw);
  } catch {
    return { ok: false, issues: [`Réponse IA non exploitable (contrôle éditorial) : ${raw.slice(0, 200)}`] };
  }
  return {
    ok: Boolean(parsed.ok),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
  };
}

const CATEGORY_SYSTEM_PROMPT = `Tu es catégoriseur e-commerce. On te donne un titre et une description de produit, ainsi que les listes FERMÉES de valeurs autorisées par le site.
Réponds UNIQUEMENT avec un objet JSON valide : {"category":"...","universe":null,"iconKey":"...","confident":true}
- "category" DOIT être exactement une valeur de la liste "categories" fournie — jamais une valeur inventée.
- "universe" DOIT être null, ou exactement une valeur de la liste "universes" fournie.
- "iconKey" DOIT être exactement une valeur de la liste "iconKeys" fournie (choisis la plus proche visuellement du produit).
- "confident" est false si aucune catégorie ne correspond clairement au produit — choisis quand même la moins mauvaise option, mais indique confident:false dans ce cas.`;

/** Catégorisation intelligente (Agent 3c), toujours validée contre la taxonomie réelle du site — jamais une valeur du modèle prise telle quelle. */
export async function categorize({ title, description }, taxonomy) {
  const prompt = `Titre : ${title}\nDescription : ${description || '(aucune)'}\n\n`
    + `categories autorisées : ${taxonomy.categories.join(', ')}\n`
    + `universes autorisées : ${taxonomy.universes.join(', ')}\n`
    + `iconKeys autorisées : ${taxonomy.iconKeys.join(', ')}`;

  let raw;
  try {
    raw = await askModel({ system: CATEGORY_SYSTEM_PROMPT, prompt, maxTokens: 250 });
  } catch (error) {
    return { category: null, universe: null, iconKey: null, confident: false, error: error.message };
  }
  let parsed;
  try {
    parsed = parseJsonFromModel(raw);
  } catch {
    return { category: null, universe: null, iconKey: null, confident: false, error: `Réponse IA non exploitable (catégorisation) : ${raw.slice(0, 200)}` };
  }

  const category = taxonomy.categories.includes(parsed.category) ? parsed.category : null;
  const universe = parsed.universe && taxonomy.universes.includes(parsed.universe) ? parsed.universe : null;
  const iconKey = taxonomy.iconKeys.includes(parsed.iconKey) ? parsed.iconKey : null;

  return {
    category,
    universe,
    iconKey,
    confident: Boolean(parsed.confident) && Boolean(category) && Boolean(iconKey),
  };
}
