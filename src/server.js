import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { config } from './config/env.js';
import { api } from './routes/api.js';
import { importsRouter } from './routes/imports.js';
import { requireAdmin } from './middleware/auth.js';
import { startScheduler } from './services/scheduler.js';
import { initDatabase, logActivity } from './db/database.js';

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
app.use(express.static(join(__dirname, 'public')));

export async function start() {
  await initDatabase();
  return app.listen(config.port, () => {
    logActivity('DEMARRAGE', `Serveur Megalomarket AI Core démarré sur le port ${config.port}.`).catch(console.error);
    console.log(`Megalomarket AI Core en écoute sur http://localhost:${config.port}`);
    if (!config.admin.apiKey) {
      console.warn('ADMIN_API_KEY absente : toutes les routes répondent 503 (échec en fermé), sauf /api/health.');
    }
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
