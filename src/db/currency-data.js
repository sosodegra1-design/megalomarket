/*
 * Données des devises — AUCUN import, volontairement.
 *
 * Ce fichier ne contient que la liste, séparée du code qui l'installe, pour une
 * raison précise : `database.js` doit pouvoir la lire au moment où il crée le
 * schéma, et il ne peut pas importer `currency-catalogue.js` — celui-ci importe
 * déjà `database.js`. Deux modules qui s'importent l'un l'autre forment un
 * cycle, et un cycle qui « marche » finit toujours par casser à la première
 * refactorisation. Une donnée pure ne se cycle pas.
 */

export const CURRENCY_CATALOGUE = [
  // --- Devises de référence ---
  { code: 'EUR', country: 'Zone euro', name: 'Euro', rateToEur: 1 },
  { code: 'USD', country: 'États-Unis', name: 'Dollar américain', rateToEur: 0.92 },
  { code: 'GBP', country: 'Royaume-Uni', name: 'Livre sterling', rateToEur: 1.17 },
  { code: 'CHF', country: 'Suisse', name: 'Franc suisse', rateToEur: 1.05 },

  // --- Asie : la zone de sourcing principale ---
  { code: 'CNY', country: 'Chine', name: 'Yuan chinois', rateToEur: 0.13 },
  { code: 'HKD', country: 'Hong Kong', name: 'Dollar de Hong Kong', rateToEur: 0.118 },
  { code: 'TWD', country: 'Taïwan', name: 'Dollar taïwanais', rateToEur: 0.029 },
  { code: 'JPY', country: 'Japon', name: 'Yen japonais', rateToEur: 0.006 },
  { code: 'KRW', country: 'Corée du Sud', name: 'Won sud-coréen', rateToEur: 0.00067 },
  { code: 'SGD', country: 'Singapour', name: 'Dollar de Singapour', rateToEur: 0.68 },
  { code: 'INR', country: 'Inde', name: 'Roupie indienne', rateToEur: 0.011 },
  { code: 'PKR', country: 'Pakistan', name: 'Roupie pakistanaise', rateToEur: 0.0033 },
  { code: 'BDT', country: 'Bangladesh', name: 'Taka bangladais', rateToEur: 0.0077 },
  { code: 'VND', country: 'Viêt Nam', name: 'Dong vietnamien', rateToEur: 0.000036 },
  { code: 'THB', country: 'Thaïlande', name: 'Baht thaïlandais', rateToEur: 0.026 },
  { code: 'MYR', country: 'Malaisie', name: 'Ringgit malaisien', rateToEur: 0.2 },
  { code: 'IDR', country: 'Indonésie', name: 'Roupie indonésienne', rateToEur: 0.000057 },
  { code: 'PHP', country: 'Philippines', name: 'Peso philippin', rateToEur: 0.016 },

  // --- Europe hors zone euro ---
  { code: 'PLN', country: 'Pologne', name: 'Zloty polonais', rateToEur: 0.23 },
  { code: 'CZK', country: 'Tchéquie', name: 'Couronne tchèque', rateToEur: 0.04 },
  { code: 'SEK', country: 'Suède', name: 'Couronne suédoise', rateToEur: 0.088 },
  { code: 'NOK', country: 'Norvège', name: 'Couronne norvégienne', rateToEur: 0.086 },
  { code: 'DKK', country: 'Danemark', name: 'Couronne danoise', rateToEur: 0.134 },
  { code: 'HUF', country: 'Hongrie', name: 'Forint hongrois', rateToEur: 0.0025 },
  { code: 'RON', country: 'Roumanie', name: 'Leu roumain', rateToEur: 0.2 },
  { code: 'BGN', country: 'Bulgarie', name: 'Lev bulgare', rateToEur: 0.51 },
  { code: 'TRY', country: 'Turquie', name: 'Livre turque', rateToEur: 0.027 },
  { code: 'RUB', country: 'Russie', name: 'Rouble russe', rateToEur: 0.01 },
  { code: 'UAH', country: 'Ukraine', name: 'Hryvnia ukrainienne', rateToEur: 0.022 },

  // --- Amériques ---
  { code: 'CAD', country: 'Canada', name: 'Dollar canadien', rateToEur: 0.67 },
  { code: 'BRL', country: 'Brésil', name: 'Réal brésilien', rateToEur: 0.17 },
  { code: 'MXN', country: 'Mexique', name: 'Peso mexicain', rateToEur: 0.048 },

  // --- Afrique et Moyen-Orient ---
  { code: 'MAD', country: 'Maroc', name: 'Dirham marocain', rateToEur: 0.092 },
  { code: 'TND', country: 'Tunisie', name: 'Dinar tunisien', rateToEur: 0.29 },
  { code: 'EGP', country: 'Égypte', name: 'Livre égyptienne', rateToEur: 0.019 },
  { code: 'ZAR', country: 'Afrique du Sud', name: 'Rand sud-africain', rateToEur: 0.05 },
  { code: 'AED', country: 'Émirats arabes unis', name: 'Dirham des Émirats', rateToEur: 0.25 },
  { code: 'SAR', country: 'Arabie saoudite', name: 'Riyal saoudien', rateToEur: 0.245 },
  { code: 'ILS', country: 'Israël', name: 'Shekel israélien', rateToEur: 0.25 },

  // --- Océanie ---
  { code: 'AUD', country: 'Australie', name: 'Dollar australien', rateToEur: 0.6 },
  { code: 'NZD', country: 'Nouvelle-Zélande', name: 'Dollar néo-zélandais', rateToEur: 0.55 },
];
