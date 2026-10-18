import { execFileSync } from 'node:child_process';

/**
 * Rapport d'état de Megalomarket, en texte lisible.
 *
 * Il ne contient AUCUN secret (ni clé, ni jeton) : des comptes, des statuts, des
 * titres de produits importés et les dernières lignes du journal d'activité.
 */

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] || 0) + 1;
  return counts;
}

export function buildReport({ now = new Date(), server, ollama, config, imports, activity, watcher }) {
  const lines = [`# Rapport Megalomarket — ${now.toLocaleString('fr-FR')}`, ''];
  const problems = [];

  lines.push('## Services');
  lines.push(`- Serveur : ${server.up ? 'en ligne' : 'HORS LIGNE'}`);
  if (!server.up) problems.push('serveur hors ligne');
  if (ollama) {
    lines.push(`- Ollama : ${ollama.up ? `en ligne (${ollama.models.length} modèle(s))` : 'HORS LIGNE'}`);
    if (!ollama.up) problems.push('Ollama hors ligne');
    for (const wanted of ollama.wanted || []) {
      const found = ollama.models.some((n) => n === wanted || n === `${wanted}:latest` || n.split(':')[0] === wanted);
      lines.push(`- Modèle ${wanted} : ${found ? 'installé' : 'ABSENT'}`);
      if (ollama.up && !found) problems.push(`modèle ${wanted} absent`);
    }
  }
  if (config) {
    lines.push(`- IA vue par le serveur : ${config.ai?.configured ? 'configurée' : 'NON configurée'}`);
    if (!config.ai?.configured) problems.push('IA non configurée côté serveur');
    for (const [channel, configured] of Object.entries(config.channels || {})) {
      lines.push(`- Canal ${channel} : ${configured ? 'configuré' : 'non configuré'}`);
    }
  }

  if (imports) {
    const byStatus = countBy(imports, 'status');
    lines.push('', '## Imports');
    lines.push(`- Total : ${imports.length} (brouillon : ${byStatus.brouillon || 0}, fiches générées : ${byStatus.pret || 0})`);
    const waiting = byStatus.brouillon || 0;
    if (waiting > 0) problems.push(`${waiting} import(s) sans fiches générées`);
    const lights = imports.filter((i) => i.category === 'lumivita').length;
    lines.push(`- Catégorie LumiVita (éclairage) : ${lights}`);
    for (const imp of imports.slice(0, 5)) {
      lines.push(`- #${imp.id} ${imp.title} — ${imp.source_site} — ${imp.status}`);
    }
  }

  if (watcher) {
    lines.push('', '## Surveillance des favoris');
    lines.push(`- Liens déjà traités : ${watcher.seen}`);
  }

  if (activity) {
    const errors = activity.filter((entry) => /ERREUR|ECHEC|FAIL/i.test(entry.kind));
    lines.push('', '## Journal récent');
    lines.push(`- ${activity.length} ligne(s) lue(s), dont ${errors.length} erreur(s)`);
    for (const entry of activity.slice(0, 8)) {
      lines.push(`- [${entry.kind}] ${String(entry.message).slice(0, 160)}`);
    }
    if (errors.length > 0) problems.push(`${errors.length} erreur(s) dans le journal récent`);
  }

  lines.push('', '## Bilan', problems.length === 0 ? '- Rien à signaler.' : problems.map((p) => `- À regarder : ${p}`).join('\n'), '');
  return { text: lines.join('\n'), problems };
}

/**
 * Publie le rapport sur la branche `rapports` du dépôt, SANS toucher à l'arbre de
 * travail ni à la branche courante : un seul commit orphelin, remplacé à chaque
 * fois (force). C'est le canal par lequel un lecteur distant voit l'état du Mac.
 */
export function publishReport({ cwd, content, remote = 'origin', branch = 'rapports' }) {
  const git = (args, input) => execFileSync('git', args, {
    cwd,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Megalomarket', GIT_AUTHOR_EMAIL: 'megalomarket@localhost',
      GIT_COMMITTER_NAME: 'Megalomarket', GIT_COMMITTER_EMAIL: 'megalomarket@localhost',
    },
  }).toString().trim();

  const blob = git(['hash-object', '-w', '--stdin'], content);
  const tree = git(['mktree'], `100644 blob ${blob}\trapport.md\n`);
  const commit = git(['commit-tree', tree, '-m', `Rapport ${new Date().toISOString()}`]);
  git(['push', '--force', remote, `${commit}:refs/heads/${branch}`]);
  return commit;
}
