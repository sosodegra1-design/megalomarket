import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { config } from './config/env.js';
import { api } from './routes/api.js';
import { importsRouter } from './routes/imports.js';
import { suppliersRouter } from './routes/suppliers.js';
import { distributorsRouter } from './routes/distributors.js';
import { nichesRouter } from './routes/niches.js';
import { requireAdmin } from './middleware/auth.js';
import { startScheduler } from './services/scheduler.js';
import { initDatabase, logActivity } from './db/database.js';
import { seedSuppliersIfEmpty } from './db/supplier-catalogue.js';
import { seedCarriersIfEmpty } from './db/carrier-catalogue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const app = express();

/* L'authentification est montée avant tout le reste, et avant même le parsing
   du corps des requêtes : une requête sans clé est refusée sans que son contenu
   soit lu. Elle couvre l'API, le module d'import et les fichiers statiques
   (donc le tableau de bord), à la seule exception de /api/health. */
app.use(requireAdmin);

app.use(express.json());
app.use('/api', api);
app.use('/api/imports', importsRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/distributors', distributorsRouter);
app.use('/api/niches', nichesRouter);
app.use(express.static(join(__dirname, 'public')));

/* Décrit la base visée sans jamais exposer le jeton : l'hôte suffit à voir d'un
   coup d'œil si l'adresse est bien celle qu'on croit. */
function describeDatabase() {
  const url = config.turso.url;
  if (url.startsWith('file:')) return 'locale (perdue à chaque redéploiement)';
  try {
    return `distante (${new URL(url).host})`;
  } catch {
    return 'distante (adresse illisible)';
  }
}

/* Une erreur de connexion brute ne dit rien d'exploitable : « SERVER_ERROR:
   Server returned HTTP status 400 » ne permet pas de savoir si l'adresse est
   fausse, le jeton périmé, ou la base inexistante — et comme le service refuse
   de démarrer, il ne reste aucun autre moyen de diagnostiquer. On traduit donc
   les cas courants en actions concrètes. */
function describeDatabaseStartupError(error) {
  const url = config.turso.url;
  if (url.startsWith('file:')) return error;

  let host = url;
  try { host = new URL(url).host; } catch { /* adresse illisible : on la montre telle quelle */ }

  const status = error?.cause?.status ?? error?.status;
  const hints = [];

  /* Le jeton est la cause la plus fréquente, et la plus difficile à voir : deux
     valeurs recopiées dans la mauvaise case restent « présentes » du point de
     vue de la configuration, donc rien ne les signale. Les jetons Turso sont
     des JWT et commencent toujours par « eyJ » : tout le reste est suspect. */
  const token = String(config.turso.authToken ?? '');
  if (token) {
    if (token !== token.trim()) {
      hints.push("TURSO_AUTH_TOKEN commence ou finit par un espace ou un retour à la ligne : recopie-le sans caractère parasite");
    } else if (/^(libsql|https?|wss?):\/\//i.test(token)) {
      hints.push("TURSO_AUTH_TOKEN contient une ADRESSE et non un jeton : les deux valeurs sont probablement croisées ou décalées");
    } else if (!token.startsWith('eyJ')) {
      hints.push("TURSO_AUTH_TOKEN ne ressemble pas à un jeton Turso (ils commencent par « eyJ ») : il vient probablement d'une autre base, ou a été tronqué au copier-coller");
    }
  }

  // 400 et 404 sont ce que Turso renvoie quand l'adresse ne désigne aucune base
  // accessible avec ce jeton (vérifié : 404 pour une base inexistante).
  if (status === 400 || status === 404) {
    hints.push("Turso ne trouve aucune base à cette adresse avec ce jeton : l'adresse ou le jeton est faux, ou ne correspond pas à la même base");
  } else if (status === 401 || status === 403) {
    hints.push('jeton refusé : il est peut-être révoqué, expiré, ou destiné à une autre base');
  } else if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(String(error?.message))) {
    hints.push("l'hôte est injoignable : l'adresse comporte probablement une faute de frappe");
  }

  hints.push('vérifie les deux variables avec « turso db show <base> --url » et « turso db tokens create <base> »');
  hints.push('pour repartir tout de suite, vide TURSO_DATABASE_URL : le service démarrera sur une base locale');

  return new Error(
    `Connexion à la base distante impossible (${host})${status ? ` — HTTP ${status}` : ''}. `
    + `Pistes : ${hints.join(' ; ')}. `
    + `Erreur d'origine : ${error?.message ?? error}`,
  );
}

/* Récapitulatif au démarrage. Sur une plateforme gratuite on jongle avec une
   dizaine de variables, et une seule oubliée se traduit par un 503 opaque ou
   une fonction silencieusement inerte : ce journal dit en quelques lignes ce
   qui est réellement actif. Aucune valeur secrète n'est affichée, seulement
   leur présence. */
function logConfigurationSummary() {
  const state = (value) => (value ? 'ok' : 'MANQUANT');

  const lines = [
    ['base de données', describeDatabase()],
    ['accès au service', config.admin.apiKey ? 'protégé par clé' : 'VERROUILLÉ — ADMIN_API_KEY manquante, tout répond 503'],
    ['fournisseur IA', config.ai?.ready
      ? `${config.ai.provider} (${config.ai.model})`
      : 'AUCUN — import, prix, descriptions et support resteront inertes'],
    ['site propre', state(config.ownSite.ready)],
    ['eBay', state(config.ebay.ready)],
  ];

  console.log('Configuration :');
  for (const [label, value] of lines) console.log(`  - ${label.padEnd(18)} ${value}`);
}

export async function start() {
  // La base est indispensable : sans elle il n'y a rien à servir. L'échec reste
  // donc fatal, mais il doit être lisible.
  try {
    await initDatabase();
  } catch (error) {
    throw describeDatabaseStartupError(error);
  }

  /* Le catalogue de partenaires est installé juste après le schéma : sur un
     déploiement neuf, la table suppliers serait sinon vide, et l'écran d'import
     n'aurait aucun partenaire à proposer. Le seed ne remplit que la table vide,
     donc sur la base de production déjà garnie il ne fait rien.

     Cet échec n'est PAS fatal, contrairement à celui de la base : un catalogue
     de confort ne vaut pas un service à l'arrêt. On le signale et on démarre
     quand même — l'ajout manuel de partenaires reste possible. */
  try {
    const { seeded } = await seedSuppliersIfEmpty();
    if (seeded > 0) {
      console.log(`Catalogue de partenaires installé : ${seeded} fournisseurs et distributeurs par défaut.`);
    }
  } catch (error) {
    console.error('Catalogue de partenaires non installé (le service démarre quand même) :', error);
  }

  /* Même principe pour les transporteurs, mais avec son propre garde-fou et son
     propre try/catch : le catalogue logistique ne dépend pas de celui des
     fournisseurs, et un échec de l'un ne doit jamais empêcher l'autre ni le
     démarrage. Le seed ne remplit la table que s'il n'existe encore AUCUN
     transporteur, il est donc sans effet sur une base déjà garnie. */
  try {
    const { seeded } = await seedCarriersIfEmpty();
    if (seeded > 0) {
      console.log(`Catalogue de transporteurs installé : ${seeded} transporteurs internationaux par défaut.`);
    }
  } catch (error) {
    console.error('Catalogue de transporteurs non installé (le service démarre quand même) :', error);
  }

  return app.listen(config.port, () => {
    logActivity('DEMARRAGE', `Serveur Megalomarket AI Core démarré sur le port ${config.port}.`).catch(console.error);
    console.log(`Megalomarket AI Core en écoute sur http://localhost:${config.port}`);
    logConfigurationSummary();
    startScheduler();
  });
}

/* En ESM il n'y a pas de `require.main === module` : on compare le chemin du
   script lancé à ce module. Les tests peuvent ainsi importer `app` et l'écouter
   sur un port éphémère sans démarrer le planificateur. */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  start().catch((error) => {
    console.error('Échec du démarrage de Megalomarket AI Core :', error);
    process.exit(1);
  });
}
