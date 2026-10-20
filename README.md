# Megalomarket — AI Core

Service central de recommandations IA et de synchronisation omnicanale pour Megalomarket
(LumiVita, site propre, Amazon, TikTok Shop et Allegro).

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
| LumiVita | Catalogue statique en lecture seule (6 produits, sans prix ni stock) lu depuis `data/lumivita-catalogue.json` ; toute écriture est refusée | `src/connectors/lumivita.js` |
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
   LumiVita) et calcule le prix de vente conseillé (`src/importer/pricing.js` : prix d'achat × coefficient
   de marge + frais fixes, jamais en dessous du prix d'achat — verrou anti-vente à perte).
3. **`GET /api/imports/:id`** — récupère l'import et toutes ses fiches par marketplace (statut
   `a_valider`, `valide`, `publie` ou `echec`).
4. **Option A (validation manuelle)** : `PATCH /api/imports/:id/listings/:marketplace` `{ title?,
   description?, suggestedPrice? }` pour corriger une fiche avant publication.
5. **Option B (publication directe)** : `POST /api/imports/:id/listings/:marketplace/publish` —
   publie réellement sur la marketplace via son connecteur (`src/importer/publisher.js`). Le site
   propre est pris en charge ; LumiVita est en lecture seule et les autres renvoient une erreur claire "pas encore actif" tant
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

## Comment une page produit est lue (et à quel prix)

L'import essaie les couches dans cet ordre :

| # | Couche | Coût | Ce qu'elle fait |
|---|---|---|---|
| 1-6 | Scraping direct (navigateur, mobile, googlebot, hôte alternatif, Wayback, Jina) | gratuit | lit le HTML de la page |
| 7 | **Lecteur gratuit** : `r.jina.ai` + le modèle configuré | **gratuit** | `r.jina.ai` rend le texte de la page, le modèle local en extrait titre / prix / devise |
| 8 | Agent Perplexity (`pro-search`) | **payant** | ouvre la page depuis son propre réseau — utile quand tout le reste est bloqué |

**Le lecteur gratuit (7) est le défaut** : aucune clé à fournir. Ollama en local,
ou Groq en ligne (offre gratuite) — les deux sont gratuits.

**Perplexity (8) est optionnel.** Si `PERPLEXITY_API_KEY` est renseignée, il prend
le relais en dernier recours ; sinon la chaîne s'arrête proprement à la couche 7
avec un message qui renvoie vers la saisie manuelle.

### Ce que le lecteur gratuit ne fait PAS

Il **ne cherche pas** la page ailleurs : si l'URL elle-même est inaccessible,
elle le restera. Perplexity, lui, peut retrouver un produit par recherche. La
différence est réelle, mais elle ne justifie pas une clé payante pour la majorité
des liens.

### Les garde-fous sont les mêmes dans les deux cas

Un titre d'annuaire (« Alibaba Manufacturer Directory »), un prix à 0, ou un prix
sans devise explicite sont **refusés** — jamais devinés. Un prix faux se
propagerait silencieusement jusqu'aux annonces publiées.

La provenance est indiquée dans l'import : `agent-gratuit` ou `agent-perplexity`.
L'interface ne prétend jamais qu'une page a été lue par un service qui n'a pas
servi.

## Installation locale

```bash
npm install
cp .env.example .env
# remplis .env avec tes vraies clés (au minimum une clé IA — ANTHROPIC_API_KEY
# ou les variables AI_BASE_URL / AI_API_KEY / AI_MODEL — pour tester l'IA)
npm run dev
```

Le tableau de bord est servi sur `http://localhost:3000`.

### Tout en local avec Ollama (gratuit, rien ne quitte ta machine)

1. Installe Ollama (https://ollama.com) puis télécharge un modèle : `ollama pull llama3.1`
2. Dans `.env` :
   ```
   AI_PROVIDER=openai
   AI_BASE_URL=http://localhost:11434/v1
   AI_API_KEY=ollama
   AI_MODEL=llama3.1
   AI_TIMEOUT_MS=180000
   ADMIN_API_KEY=<une clé de ton choix : openssl rand -hex 32>
   ```
   Sans `TURSO_DATABASE_URL`, la base est un fichier local (`data/megalomarket.db`).
3. Contrôle le branchement : `npm run verify:ollama` (Ollama répond, modèle installé, appel réel).
4. Lance `npm run dev`.

Aucune clé Anthropic n'est nécessaire. Pour le contrôle visuel des photos, télécharge un modèle
qui lit les images (`ollama pull llama3.2-vision`) et ajoute `AI_VISION_MODEL=llama3.2-vision` ;
sans cette variable, `AI_MODEL` est utilisé et doit lui-même savoir lire des images.

## Installation complète sur Mac (automatique, gratuit, local)

1. `git pull`, puis `npm install`.
2. `cp .env.example .env` et remplis au minimum les blocs IA et `ADMIN_API_KEY` (voir la section Ollama ci-dessus).
3. Dans Chrome, choisis où déposer tes liens Alibaba, AliExpress, Showroomprivé, Veepee : un dossier `Megalomarket` (`BOOKMARKS_FOLDER=Megalomarket`) ou toute la barre de favoris (`BOOKMARKS_FOLDER=Barre de favoris`). Si le dossier contient déjà des favoris, lance une fois `npm run watch:bookmarks -- --baseline` : les liens existants ne seront pas importés, seuls les nouveaux le seront.
4. Dans l'application Ollama, active « Ouvrir à la connexion » (Settings), puis `ollama pull qwen3:8b` et `ollama pull llama3.2-vision`.
5. `npm run autostart:install` : le serveur et le surveillant de favoris démarrent à chaque ouverture de session et redémarrent s'ils s'arrêtent (journaux dans `~/Library/Logs/Megalomarket/`). `npm run autostart:uninstall` les retire.
6. `npm run doctor` (ou `npm run doctor -- --deep` pour tester aussi la lecture d'image) : contrôle complet de l'installation, avec la correction à faire pour chaque point KO.
7. Ouvre `http://localhost:3000` (mot de passe = `ADMIN_API_KEY`). Les fiches générées sont « à valider » : rien n'est publié sans ton clic.
8. Rapport : `npm run report` affiche l'état (services, imports, journal). `npm run autostart:install` installe aussi un agent horaire qui publie ce rapport sur la branche `rapports` du dépôt (aucun secret dedans) ; `npm run report:push` le fait à la main.
9. Catalogue LumiVita : `POST /api/lumivita/sync` l'inscrit en base (6 produits, prix d'achat à saisir).

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
   du site propre si tu les as déjà.
5. Déploie.

### Le service gratuit se met en veille — comment le garder actif

Le plan gratuit de Render arrête le service après ~15 min sans requête, ce qui empêche les
synchronisations planifiées (`src/services/scheduler.js`) de se déclencher pendant la veille.
**Solution : un moniteur HTTP gratuit** (UptimeRobot ou cron-job.org), qui pointe sur
`/api/health`. Il garde le service éveillé *et* prévient en cas de panne — un seul outil pour
les deux besoins. La marche à suivre est dans la section [Supervision](#supervision).

> **Attention :** garder le service éveillé fait fonctionner les synchronisations de stock et
> de commandes, mais **pas** la chasse aux pépites. Son cron interne avait un rendez-vous à 3 h
> du matin qui ne tombait jamais : elle est passée sur un déclencheur externe, voir
> [Déclencheur externe](#déclencheur-externe-dénicheur).

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

## Supervision

La sonde publique est **`GET /api/health`**. Elle est joignable sans clé — c'est
le seul point qu'une surveillance externe peut interroger.

```json
{ "ok": true, "database": "ok", "uptimeSeconds": 3600, "checkedAt": "2026-09-25T…" }
```

Deux propriétés qui comptent :

- **Elle vérifie réellement la base** (`SELECT 1`), pas seulement le processus.
  Un serveur debout devant une base morte est un serveur mort — et une sonde qui
  répond toujours « ok » ne surveille rien, elle rassure.
- **Elle ne divulgue aucun secret.** Elle n'est pas authentifiée : elle ne dit
  que des états.

**Mettre en place une alerte externe** (UptimeRobot, BetterStack, Cronitor…) :
créer un moniteur HTTP sur `https://<service>.onrender.com/api/health`, intervalle
5 minutes, alerte si **le code HTTP n'est pas 200** (503 = base injoignable).

Sur l'offre gratuite Render, le service se met en veille après inactivité : un
moniteur à 5 minutes sert aussi de **ping de maintien en vie** et supprime la
latence de ~20 s du premier appel.

### Mettre en place le moniteur

Un seul outil couvre les deux besoins : **alerte** et **maintien en vie**.

1. Créer un compte sur [UptimeRobot](https://uptimerobot.com) (gratuit).
2. **Add New Monitor** → type **HTTP(s)**.
3. URL : `https://<service>.onrender.com/api/health`
4. Intervalle : **5 minutes**.
5. Alerte : e-mail dès le premier échec.

Ce que ça apporte :

- **Alerte** si le hub tombe, ou si la base devient injoignable (la sonde renvoie
  alors **503** — c'est pour cela qu'elle interroge réellement la base).
- **Maintien en vie** : l'offre gratuite Render endort le service après ~15 min
  sans requête. Un ping toutes les 5 minutes le garde éveillé, ce qui remet en
  marche les synchronisations de stock et de commandes.

> La chasse aux pépites **n'est pas couverte** par ce maintien en vie : elle a
> son propre déclencheur externe, ci-dessous.

## Déclencheur externe (Dénicheur)

La chasse aux pépites **ne peut pas** être planifiée par un `cron` interne : sur
l'offre gratuite, le service s'endort et le cron ne se déclenche jamais (relevé
en production : dernier lot vieux de 7 jours). Le déclencheur vit donc **hors du
processus**, dans GitHub Actions.

| Élément | Rôle |
|---|---|
| `POST /api/cron/denicheur` | Lance une chasse. En-tête `X-Cron-Token`. |
| `GET /api/cron/denicheur` | État du déclencheur, sans lancer de chasse |
| `.github/workflows/denicheur.yml` | Appelle la route **chaque lundi à 6 h UTC** |

**Le jeton est distinct de la clé admin.** Il ne peut que lancer une chasse —
pas lire les commandes, les prix ni les clients.

Mise en place :

```bash
# 1. Générer un jeton
openssl rand -hex 32

# 2. Le poser sur Render (Environment) ET dans GitHub
#    (Settings > Secrets and variables > Actions > New repository secret)
#    Les deux valeurs doivent être IDENTIQUES.

# 3. Vérifier
curl -H "X-Cron-Token: <jeton>" \
  https://<service>.onrender.com/api/cron/denicheur
```

Un **délai de garde de 10 minutes** limite les chasses : un jeton dérobé ne peut
pas brûler le quota du modèle en boucle. Pour forcer une chasse immédiate,
utiliser le bouton du tableau de bord (qui passe par la clé admin).

> **Limite connue :** GitHub ne garantit pas l'heure exacte d'un `schedule` —
> retard de 10 à 20 minutes possible, et une exécution peut être sautée en cas de
> forte charge. Sans conséquence pour une chasse hebdomadaire ; inadapté à une
> tâche toutes les 5 minutes.

## Moindre privilège : le jeton du chien de garde

Le chien de garde (surveillance des favoris Chrome) est un automate qui vit sur
une machine personnelle. Il détenait la **clé administrateur** — donc le droit
de lire les commandes clients, de changer un prix et de publier.

Il a désormais son propre jeton, `IMPORT_TOKEN`, limité à **quatre routes** :

| Méthode | Route |
|---|---|
| GET | `/api/imports` (lister, pour éviter les doublons) |
| POST | `/api/imports` (créer) |
| POST | `/api/imports/:id/generate` (générer les fiches) |
| DELETE | `/api/imports/duplicates` (nettoyage) |

Tout le reste répond **403** avec un message explicite. C'est le principe
« Excessive Agency » de l'OWASP : un automate reçoit le minimum d'actions.

## Idempotence : un import ne se crée pas deux fois

`POST /api/imports` refuse (**409**) une URL déjà importée, et renvoie
l'identifiant existant. Le contrôle a lieu **avant l'extraction** : scraper une
page pour découvrir ensuite qu'on la connaissait déjà serait du travail payé
deux fois — requête réseau, et parfois appel IA.

> Déposer deux fois le même favori ne crée plus deux imports ni deux jeux de
> fiches : la comparaison entre fournisseurs reste lisible.

## Sauvegarde

**Turso assure la durabilité et les points de reprise.** L'export ci-dessous ne
les remplace pas : il sert à **emporter ses données** dans un fichier lisible,
sans dépendre d'un fournisseur.

| Route | Ce qu'elle fait |
|---|---|
| `GET /api/backup` | Export complet en JSON, en téléchargement, nommé `megalomarket-sauvegarde-AAAA-MM-JJ.json` |
| `GET /api/backup?meta=1` | Inventaire seul (tables + nombres de lignes), **sans données personnelles**, avec un contrôle de complétude |

Depuis le hub : **Paramètres → Sauvegarde des données**.

```bash
# En ligne de commande
curl -u "admin:$ADMIN_API_KEY" -o sauvegarde.json \
  https://<service>.onrender.com/api/backup

# Vérifier que la sauvegarde est complète
curl -u "admin:$ADMIN_API_KEY" https://<service>.onrender.com/api/backup?meta=1 \
  | jq '.controle'
```

Le mode inventaire renvoie `{"complete": true}` ou la liste des tables
manquantes. C'est le contrôle à faire **après** chaque export : une sauvegarde
incomplète ne se voit qu'au moment de restaurer, c'est-à-dire trop tard.

## Pages légales

Obligatoires en France. Disponibles dans le hub : **Paramètres → Informations
légales**, ou directement `#/legal`.

Elles sont **pré-remplies avec des emplacements `[À COMPLÉTER]`** : raison
sociale, forme juridique, SIRET, siège, contact, responsable de publication.
Un texte générique ne suffit pas — ces informations doivent être les vraies
avant publication.

Le contenu RGPD est, lui, déjà renseigné et fidèle : données réellement traitées
(commandes, journal, réglages), sous-traitants réellement utilisés (Render,
Turso, Brevo, Sendcloud, Cloudinary, fournisseur d'IA), durée de conservation et
droits des personnes.

## Prochaines étapes concrètes

1. Renseigner `OWN_SITE_API_URL` (`https://bbhappy.onrender.com`) et `OWN_SITE_API_KEY` — la **même
   valeur** que `ADMIN_API_KEY` du site — pour activer le canal `own_site`.
2. Une fois les accès Amazon SP-API et TikTok Shop Partner API approuvés, implémenter
   `src/connectors/amazon.js` et `src/connectors/tiktokShop.js` en suivant exactement
   le même contrat (`listOrders`, `listInventoryItems`, `updateOfferPrice`, `isConfigured`)
   que `ownSite.js` — aucun autre fichier n'a besoin de changer. Un canal qui n'implémente pas une
   méthode est simplement ignoré par les synchronisations.
3. Réparer le tableau de bord (`src/public/index.html`), aujourd'hui tronqué en pleine instruction
   et sans aucun appel à l'API.
