/*
 * npm run quotes
 * Génère data/devis-alibaba.md : pour chaque produit importé depuis Alibaba, le lien et le
 * message de demande de devis (MOQ + transport). Rien n'est envoyé.
 * Destination : QUOTE_DESTINATION dans .env (défaut « Switzerland »).
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildQuotesReport } from '../src/services/quotes.js';

const server = (process.env.MEGALOMARKET_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const response = await fetch(`${server}/api/imports`, { headers: { 'X-Admin-Key': process.env.ADMIN_API_KEY || '' } });
if (!response.ok) {
  console.error(`Lecture des imports impossible (HTTP ${response.status}). Le serveur tourne-t-il ? (npm run status)`);
  process.exit(1);
}
const report = buildQuotesReport(await response.json(), { destination: process.env.QUOTE_DESTINATION || 'Switzerland' });
mkdirSync('./data', { recursive: true });
writeFileSync('./data/devis-alibaba.md', report);
console.log(report);
console.log('\nFichier enregistré : data/devis-alibaba.md');
