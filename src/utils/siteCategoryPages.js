/*
 * Nom de fichier HTML réel de chaque page de catégorie du site (BBVOLTEX).
 *
 * Bug signalé en production : un lien produit du type
 * "bijoux.html?product=p2" renvoyait "Cannot GET /bijoux.html" — la page
 * réelle est "bijoux-accessoires.html". La valeur de catégorie stockée
 * ("bijoux", la liste fermée que le site accepte, voir CATEGORIES dans
 * server/products-repo.js côté BBhappy) ne correspond donc PAS toujours au
 * nom de fichier de la page qui l'affiche — un lien construit en
 * concaténant naïvement `${category}.html` casse pour ce seul cas.
 *
 * Cette liste explicite est la seule source de vérité pour ce
 * rapprochement, utilisée par tous les endroits qui construisent un lien
 * vers une fiche produit du site (routes/orders.js, routes/site.js) — pour
 * qu'un futur mésalignement de nom de fichier ne puisse plus se reproduire
 * en silence à un troisième ou quatrième endroit.
 */
const CATEGORY_PAGE_OVERRIDES = {
  bijoux: 'bijoux-accessoires.html',
};

export function categoryPageFile(category) {
  return CATEGORY_PAGE_OVERRIDES[category] || `${category}.html`;
}
