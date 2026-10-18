/**
 * Demandes de devis fournisseurs : un message par produit importé depuis Alibaba, posant
 * les deux questions utiles pour calculer un prix de revient — quantité minimale de
 * commande (MOQ) et coût du transport. Le texte est en anglais, langue des fournisseurs.
 */

export function cleanTitle(title) {
  return String(title || '').replace(/\s*-\s*Buy Product on Alibaba\.com\s*$/i, '').trim();
}

export function buildQuoteMessage({ title, destination }) {
  return [
    'Hello,',
    '',
    `I am interested in your product: "${cleanTitle(title)}".`,
    'Could you please tell me:',
    '1) What is your minimum order quantity (MOQ)?',
    `2) What is the shipping cost to ${destination} (per unit and for a full order), and the delivery time?`,
    '',
    'Thank you, I look forward to your reply.',
  ].join('\n');
}

export function buildQuotesReport(imports, { destination = 'Switzerland' } = {}) {
  const items = imports.filter((i) => i.source_url && /alibaba\./i.test(i.source_url));
  const lines = [
    '# Demandes de devis Alibaba — MOQ et transport',
    '',
    `${items.length} produit(s). Destination indiquée : ${destination}.`,
    '',
    "Consigne pour l'envoi : pour chaque produit, ouvrir le lien depuis le compte Alibaba connecté, cliquer",
    '« Contacter le fournisseur », coller le message, envoyer, puis noter la réponse. Un produit à la fois,',
    'avec une pause entre deux envois : Alibaba peut bloquer un compte qui écrit en série.',
    '',
  ];
  items.forEach((imp, index) => {
    lines.push(
      `## ${index + 1}. ${cleanTitle(imp.title)}`,
      `- Lien : ${imp.source_url}`,
      `- Import n°${imp.id}`,
      '',
      '```',
      buildQuoteMessage({ title: imp.title, destination }),
      '```',
      '',
    );
  });
  return lines.join('\n');
}
