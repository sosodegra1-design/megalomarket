# Megalomarket — AI Core

Service central de recommandations IA et de synchronisation omnicanale pour Megalomarket
(eBay, site propre, Amazon et TikTok Shop à venir).

## Ce que ça fait aujourd'hui

- **Synchronisation de stock et de commandes** depuis chaque canal connecté (planifiée automatiquement toutes les 15 min pour le stock, 5 min pour les commandes — voir `src/services/scheduler.js`).
- **Recommandations de prix** par canal, générées par l'IA à partir du prix de revient, des prix actuels et de l'historique de ventes (`src/ai/priceOptimizer.js`). Une suggestion en dessous du prix de revient est automatiquement rejetée, jamais stockée.
- **Génération de descriptions produit** adaptées au ton de chaque canal (`src/ai/descriptionWriter.js`).
- **Qualification de messages de support client** (catégorie, urgence, réponse proposée) — la décision finale sur un remboursement ou un litige reste toujours humaine, l'IA ne fait qu'assister (`src/ai/supportAgent.js`).
- **Tableau de bord** (`src/public/index.html`) pour voir l'état des canaux, gérer les produits, valider ou ignorer les recommandations, et qualifier un message client.

## État des connecteurs

| Canal | État | Fichier |
|---|---|---|
| eBay | Implémenté (OAuth2 + Sell API) | `src/connectors/ebay.js` |
| Site propre | Implémenté (contrat REST générique, à ajuster à ton vrai backend) | `src/connectors/ownSite.js` |
| Amazon | En attente d'approbation SP-API — squelette prêt | `src/connectors/amazon.js` |
| TikTok Shop | En attente d'approbation Partner API — squelette prêt | `src/connectors/tiktokShop.js` |

Un connecteur non configuré (clés manquantes dans `.env`) est automatiquement ignoré par
les synchronisations — il ne fait jamais planter les autres canaux.

### Connecteur "site propre" — hypothèse à valider

Ce connecteur suppose que ton site expose (ou pourra exposer) trois routes :
`GET /products`, `POST /products/:sku/price`, `POST /products/:sku/stock`,
authentifiées par un jeton Bearer. Si ton site (actuellement en HTML) n'a pas encore
de backend avec ces routes, il faudra les ajouter avant que ce connecteur fonctionne
réellement — dis-moi comment ton site est hébergé/codé et j'adapterai ce fichier.

## Installation locale

```bash
npm install
cp .env.example .env
# remplis .env avec tes vraies clés (au minimum ANTHROPIC_API_KEY pour tester l'IA)
npm run dev
```

Le tableau de bord est servi sur `http://localhost:3000`.

## Tests

```bash
npm test
```

Les tests couvrent la configuration, les garde-fous des connecteurs (erreurs claires
si mal configurés) et le schéma de base de données. Ils ne nécessitent aucune vraie
clé d'API ni connexion réseau.

## Déploiement sur Render (gratuit)

Ce dépôt inclut `render.yaml` configuré pour le **plan gratuit** de Render (aucune carte
bancaire requise). La base de données ne vit donc pas sur un disque Render (payant), mais sur
**Turso** (SQLite hébergé, gratuit, sans carte) :

1. Crée un compte sur [turso.tech](https://turso.tech), puis une base :
   `turso db create megalomarket` et `turso db tokens create megalomarket`.
   Récupère l'URL (`turso db show megalomarket --url`, commence par `libsql://`) et le jeton.
2. Pousse ce projet sur un dépôt GitHub.
3. Sur Render, "New" → "Blueprint" → sélectionne ce dépôt. Render détecte `render.yaml`.
4. Renseigne les variables secrètes demandées : `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   `ANTHROPIC_API_KEY`, puis les clés eBay si tu les as déjà.
5. Déploie.

### Le service gratuit se met en veille — comment le garder actif

Le plan gratuit de Render arrête le service après ~15 min sans requête, ce qui empêche les
synchronisations planifiées (`src/services/scheduler.js`) de se déclencher pendant la veille.
Solution gratuite : configure un ping régulier (toutes les 10-14 min) vers
`https://<ton-service>.onrender.com/api/health` avec un service comme
[cron-job.org](https://cron-job.org) (gratuit, sans carte). Ça garde le service éveillé et
les synchronisations internes tournent normalement.

## Prochaines étapes concrètes

1. Confirmer les vraies routes API de ton site (`OWN_SITE_API_URL`) pour finaliser `ownSite.js`.
2. Une fois les accès Amazon SP-API et TikTok Shop Partner API approuvés, implémenter
   `src/connectors/amazon.js` et `src/connectors/tiktokShop.js` en suivant exactement
   le même contrat (`listOrders`, `listInventoryItems`, `updateOfferPrice`, `isConfigured`)
   que `ebay.js` — aucun autre fichier n'a besoin de changer.
3. Ajouter l'authentification sur le tableau de bord avant toute mise en production
   publique (il n'y en a aucune pour l'instant).
