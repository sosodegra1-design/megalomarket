# Megalomarket — AI Core

Service central de recommandations IA et de synchronisation omnicanale pour Megalomarket
(eBay, site propre, Amazon et TikTok Shop à venir).

## Ce que ça fait aujourd'hui

- **Synchronisation entrante** : le stock et les commandes de chaque canal connecté sont relus et enregistrés (toutes les 15 min pour le stock, 5 min pour les commandes — voir `src/services/scheduler.js`).
- **Propagation sortante** : un prix validé part réellement vers le canal (`src/services/pushSync.js`). Appliquer une recommandation de prix n'est plus une simple étiquette en base — le hub fait autorité, le canal reçoit. Le verrou anti-vente à perte s'applique **avant tout appel réseau**, et un canal qui ne sait pas faire l'opération est ignoré sans bruit au lieu de faire échouer les autres.
- **Recommandations de prix** par canal, générées par l'IA à partir du prix de revient, des prix actuels et de l'historique de ventes (`src/ai/priceOptimizer.js`). Une suggestion en dessous du prix de revient est automatiquement rejetée, jamais stockée.
- **Génération de descriptions produit** adaptées au ton de chaque canal (`src/ai/descriptionWriter.js`).
- **Qualification de messages de support client** (catégorie, urgence, réponse proposée) — la décision finale sur un remboursement ou un litige reste toujours humaine, l'IA ne fait qu'assister (`src/ai/supportAgent.js`).
- **Tableau de bord** (`src/public/index.html`) : import d'un produit par lien en deux étapes (extraction puis génération IA), édition et publication par canal, produits, recommandations à appliquer, support, synchronisations, journal d'activité.

## Fournisseur IA : Anthropic ou compatible OpenAI (dont le gratuit)

Toutes les fonctions IA passent par **un seul point d'entrée** (`askModel` dans `src/ai/client.js`),
dont le fournisseur est configurable. La raison n'est pas le confort : le moteur était branché sur
un seul vendeur, donc un changement de prix, un modèle retiré ou un compte sans crédit faisait
tomber d'un coup l'import, les prix, les descriptions **et** le support. Groq, Cerebras,
OpenRouter, Google Gemini et Ollama local exposent tous la même API « compatible OpenAI »
(`/chat/completions`) : un seul adaptateur les couvre, et changer de fournisseur ne demande aucune
modification de code.

**Anthropic** (comportement historique) :

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5
```

**Fournisseur compatible OpenAI** (ici Groq, gratuit) :

```bash
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=...
AI_MODEL=<le modèle exact, visible dans la console du fournisseur>
```

`AI_PROVIDER` (`anthropic` | `openai`) est facultatif : sans lui, la clé Anthropic l'emporte si
elle est présente, sinon le chemin compatible OpenAI est utilisé dès que `AI_BASE_URL` et
`AI_API_KEY` sont renseignées. `AI_MODEL` est **obligatoire** sur le chemin compatible OpenAI — il
n'existe aucun nom de modèle commun à ces fournisseurs. Les bases et les paliers gratuits connus
sont détaillés dans `.env.example`.

### Ce qu'il faut savoir sur les paliers gratuits

Ils changent leurs limites souvent, et un plafond journalier atteint **arrête la fonction IA
jusqu'au lendemain** (un plafond par minute, jusqu'à la minute suivante). L'erreur HTTP 429 le dit
explicitement plutôt que de laisser croire à une panne.

Un point de confidentialité compte plus que les quotas : sur le **palier gratuit de Google
Gemini**, Google utilise le contenu envoyé pour améliorer ses produits. L'agent de support traite
des **messages clients** (données personnelles) : un palier qui s'entraîne sur les données est un
vrai problème RGPD/vie privée. Pour cette fonction, n'utilise donc pas le palier gratuit Gemini —
son palier payant, lui, ne s'entraîne pas sur ton contenu. Groq, Cerebras et OpenRouter
n'entraînent pas sur tes données. Ollama local est gratuit et totalement privé, mais ne peut pas
tourner quand le hub est hébergé.

## État des connecteurs

| Canal | État | Fichier |
|---|---|---|
| eBay | Implémenté (OAuth2 + Sell API), y compris la publication de nouvelles fiches | `src/connectors/ebay.js` |
| Site propre | Implémenté (contrat vérifié contre l'API réelle de BBVOLTEX) | `src/connectors/ownSite.js` |
| Amazon | En attente d'approbation SP-API — squelette prêt | `src/connectors/amazon.js` |
| TikTok Shop | En attente d'approbation Partner API — squelette prêt | `src/connectors/tiktokShop.js` |
| Allegro | En attente d'inscription développeur — squelette prêt | `src/connectors/allegro.js` |

## Import produit par lien (Alibaba, AliExpress, ...)

Permet de créer une fiche produit prête à vendre à partir d'une simple URL fournisseur.

1. **`POST /api/imports`** `{ "url": "https://..." }` — extrait titre, description, prix d'achat et
   photos de la page (`src/importer/scraper.js`). Sites protégés contre les robots (Alibaba,
   AliExpress) : l'extraction peut échouer si le contenu est chargé en JavaScript — l'erreur le
   signale clairement plutôt que de renvoyer une fiche vide.
2. **`POST /api/imports/:id/generate`** — envoie les données brutes à Claude, qui génère une fiche
   (titre + description en français) adaptée à chaque marketplace (Amazon, TikTok Shop, Allegro,
   eBay) et calcule le prix de vente conseillé (`src/importer/pricing.js` : prix d'achat × coefficient
   de marge + frais fixes, jamais en dessous du prix d'achat — verrou anti-vente à perte).
3. **`GET /api/imports/:id`** — récupère l'import et toutes ses fiches par marketplace (statut
   `a_valider`, `valide`, `publie` ou `echec`).
4. **Option A (validation manuelle)** : `PATCH /api/imports/:id/listings/:marketplace` `{ title?,
   description?, suggestedPrice? }` pour corriger une fiche avant publication.
5. **Option B (publication directe)** : `POST /api/imports/:id/listings/:marketplace/publish` —
   publie réellement sur la marketplace via son connecteur (`src/importer/publisher.js`). eBay et le
   site propre sont pris en charge ; les autres renvoient une erreur claire "pas encore actif" tant
   que leurs clés API ne sont pas renseignées.

Un connecteur non configuré (clés manquantes dans `.env`) est automatiquement ignoré par
les synchronisations — il ne fait jamais planter les autres canaux.

### Connecteur "site propre" — contrat vérifié

Le contrat a été relevé sur l'API réellement en ligne. L'hypothèse d'origine était fausse sur
quatre points, ce qui rendait ce connecteur inopérant :

| Hypothèse initiale | Réalité |
|---|---|
| `GET /products` | `GET /api/products` |
| champ `sku` | champ `id` (`p1`, `bj1`…) |
| champ `stock` | **n'existe pas** — le site ne gère pas de stock |
| `Authorization: Bearer` | en-tête `X-Admin-Key` |

L'écriture passe par des routes d'administration, et le site exige une fiche bien plus riche que
les marketplaces (catégorie, univers, âge, clé d'icône, libellés bilingues) : ces champs sont
stockés dans `import_listings.site_payload` et générés par un appel IA dédié, contraint par la
taxonomie lue sur `/api/admin/taxonomy`.

## Installation locale

```bash
npm install
cp .env.example .env
# remplis .env avec tes vraies clés (au minimum une clé IA — ANTHROPIC_API_KEY
# ou les variables AI_BASE_URL / AI_API_KEY / AI_MODEL — pour tester l'IA)
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
   `ANTHROPIC_API_KEY` (ou les variables `AI_*` d'un fournisseur compatible OpenAI), puis les clés
   eBay si tu les as déjà.
5. Déploie.

### Le service gratuit se met en veille — comment le garder actif

Le plan gratuit de Render arrête le service après ~15 min sans requête, ce qui empêche les
synchronisations planifiées (`src/services/scheduler.js`) de se déclencher pendant la veille.
Solution gratuite : configure un ping régulier (toutes les 10-14 min) vers
`https://<ton-service>.onrender.com/api/health` avec un service comme
[cron-job.org](https://cron-job.org) (gratuit, sans carte). Ça garde le service éveillé et
les synchronisations internes tournent normalement.

## Authentification

Tout le service est protégé par une clé partagée (`ADMIN_API_KEY`) : les routes d'API, le module
d'import **et** le tableau de bord. Seul `/api/health` reste public, pour que la surveillance et le
ping anti-veille puissent fonctionner sans détenir la clé.

Sans `ADMIN_API_KEY` configurée, le service **refuse tout** (503 partout sauf `/api/health`) :
l'échec est en fermé, jamais en ouvert. Une variable oubliée lors d'un déploiement verrouille le
service au lieu de l'exposer.

Trois façons de présenter la clé :

```bash
# 1. En-tête dédié — le plus simple en script
curl -H "X-Admin-Key: $ADMIN_API_KEY" https://<ton-service>.onrender.com/api/products

# 2. Jeton Bearer — même usage, plus standard
curl -H "Authorization: Bearer $ADMIN_API_KEY" https://<ton-service>.onrender.com/api/products

# 3. HTTP Basic — pour le navigateur : mot de passe = la clé, utilisateur libre
open "https://<ton-service>.onrender.com/"
```

Le mode Basic n'est pas un détail : le navigateur affiche sa boîte de dialogue native, garde les
identifiants en cache et les renvoie sur **chaque** requête, y compris celles que le tableau de
bord déclenche en JavaScript. Le tableau de bord n'a donc aucune page de connexion à gérer.

La comparaison de la clé se fait à durée constante (`crypto.timingSafeEqual`), pour qu'on ne puisse
pas la deviner caractère par caractère en mesurant les temps de réponse.

Génère une clé solide avec `openssl rand -hex 32`.

## Prochaines étapes concrètes

1. Renseigner `OWN_SITE_API_URL` (`https://bbhappy.onrender.com`) et `OWN_SITE_API_KEY` — la **même
   valeur** que `ADMIN_API_KEY` du site — pour activer le canal `own_site`.
2. Une fois les accès Amazon SP-API et TikTok Shop Partner API approuvés, implémenter
   `src/connectors/amazon.js` et `src/connectors/tiktokShop.js` en suivant exactement
   le même contrat (`listOrders`, `listInventoryItems`, `updateOfferPrice`, `isConfigured`)
   que `ebay.js` — aucun autre fichier n'a besoin de changer. Un canal qui n'implémente pas une
   méthode est simplement ignoré par les synchronisations.
3. Réparer le tableau de bord (`src/public/index.html`), aujourd'hui tronqué en pleine instruction
   et sans aucun appel à l'API.
