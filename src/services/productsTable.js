/*
 * Rendu HTML du tableau « Produits » (fragment partiel, voir GET
 * /api/products/fragment) — même logique de filtre/tri/pagination que le
 * moteur client historique (createTable() dans src/public/index.html), mais
 * exécutée côté serveur : la page envoie une requête AJAX par changement de
 * filtre/tri/page et reçoit directement du HTML prêt à afficher, au lieu de
 * charger tout le catalogue en JSON et de le filtrer en mémoire dans le
 * navigateur. Fonction pure (aucun accès base ici) pour rester testable sans
 * DB ni HTTP — la route ne fait que charger les lignes et lui déléguer le
 * filtre/tri/pagination/rendu.
 */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(2).replace('.', ',') + ' €';
}

/* Comparateur identique à src/public/index.html (compareValues) : deux
 * valeurs numériques se comparent en nombre, tout le reste en texte
 * français insensible à la casse — pour que le tri ne change pas de
 * comportement en migrant de local à serveur. */
function compareValues(a, b) {
  const na = Number(a);
  const nb = Number(b);
  const aNum = a !== '' && a != null && Number.isFinite(na);
  const bNum = b !== '' && b != null && Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''), 'fr', { numeric: true, sensitivity: 'base' });
}

const SORT_COLUMNS = {
  name: (p) => p.name,
  sku: (p) => p.sku,
  cost_price: (p) => Number(p.cost_price),
};

// Même pagination que l'ancien moteur client (createTable({ pageSize: 10 })).
export const PRODUCTS_PAGE_SIZE = 10;

function listingSummary(listings) {
  if (!listings || !listings.length) return 'aucune fiche par canal';
  return listings.map((l) => esc(l.channel) + ' ' + money(l.price)).join(' · ');
}

function rowHtml(p, aiReady) {
  const id = esc(p.id);
  const aiDisabled = aiReady ? '' : ' disabled';
  return '<tr class="row-in">'
    + '<td data-label="Produit"><span class="cell-strong">' + esc(p.name) + '</span></td>'
    + '<td data-label="SKU"><span class="pill off">' + esc(p.sku) + '</span></td>'
    + '<td data-label="Prix de revient" class="num">' + money(p.cost_price) + '</td>'
    + '<td data-label="Fiches canaux" class="cell-muted">' + listingSummary(p.listings) + '</td>'
    + '<td data-label="Actions" class="cell-actions">'
    + '<div class="actions">'
    + '<button class="btn btn-ghost btn-xs" type="button" data-action="suggest" data-id="' + id + '" data-needs-ai' + aiDisabled + '>Suggérer un prix</button>'
    + '<button class="btn btn-ghost btn-xs" type="button" data-action="describe" data-id="' + id + '" data-needs-ai' + aiDisabled + '>Générer une description</button>'
    + '</div>'
    + '<div class="actions">'
    + '<input class="input input-xs" type="number" id="pp-' + id + '" step="0.01" min="0" placeholder="prix à pousser">'
    + '<button class="btn btn-xs" type="button" data-action="push" data-id="' + id + '">Pousser ce prix</button>'
    + '</div>'
    + '</td>'
    + '</tr>';
}

/**
 * @param {object} options
 * @param {object[]} options.products - lignes déjà chargées (avec `listings`), non filtrées.
 * @param {string} [options.query] - texte de filtre (nom, SKU, description).
 * @param {string} [options.sortKey] - 'name' | 'sku' | 'cost_price' (repli sur 'name' si inconnu).
 * @param {string} [options.sortDir] - 'asc' | 'desc' (repli sur 'asc').
 * @param {number} [options.page] - page demandée, 1-indexée (bornée à [1, pages]).
 * @param {boolean} [options.aiReady] - active/désactive les boutons IA de chaque ligne.
 * @returns {{ html: string, total: number, page: number, pages: number, pageSize: number }}
 */
export function buildProductsFragment({
  products, query = '', sortKey = 'name', sortDir = 'asc', page = 1, aiReady = false,
} = {}) {
  const all = Array.isArray(products) ? products : [];
  const q = String(query || '').trim().toLowerCase();
  let rows = all;
  if (q) {
    rows = rows.filter((p) => [p.name, p.sku, p.description].join(' ').toLowerCase().includes(q));
  }

  const valueOf = SORT_COLUMNS[sortKey] || SORT_COLUMNS.name;
  const dir = sortDir === 'desc' ? -1 : 1;
  rows = rows.slice().sort((a, b) => compareValues(valueOf(a), valueOf(b)) * dir);

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PRODUCTS_PAGE_SIZE));
  const requestedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const safePage = Math.min(requestedPage, pages);
  const start = (safePage - 1) * PRODUCTS_PAGE_SIZE;
  const slice = rows.slice(start, start + PRODUCTS_PAGE_SIZE);

  let html;
  if (!all.length) {
    html = '<tr class="table-empty"><td colspan="5">Aucun produit. Crée-en un ci-dessus.</td></tr>';
  } else if (!slice.length) {
    html = '<tr class="table-empty"><td colspan="5">Aucun résultat pour « ' + esc(query) + ' ».</td></tr>';
  } else {
    html = slice.map((p) => rowHtml(p, aiReady)).join('');
  }

  return { html, total, page: safePage, pages, pageSize: PRODUCTS_PAGE_SIZE };
}
