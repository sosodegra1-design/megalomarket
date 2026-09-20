import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/env.js';
import { api } from './routes/api.js';
import { startScheduler } from './services/scheduler.js';
import { initDatabase, logActivity } from './db/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use('/api', api);
app.use(express.static(join(__dirname, 'public')));

await initDatabase();

app.listen(config.port, () => {
  logActivity('DEMARRAGE', `Serveur Megalomarket AI Core démarré sur le port ${config.port}.`).catch(console.error);
  console.log(`Megalomarket AI Core en écoute sur http://localhost:${config.port}`);
  startScheduler();
});
