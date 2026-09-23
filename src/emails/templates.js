/*
 * Gabarits des 3 e-mails post-achat. Chacun est une fonction pure : elle ne
 * fait ni appel réseau ni décision d'envoi, elle ne fait que mettre en forme
 * les données réelles qu'on lui donne (nom du client, produit, transporteur,
 * lien de suivi...) — jamais une valeur inventée pour combler un champ vide.
 */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BRAND = 'BBVOLTEX';
const GOLD = '#c8a24a';

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f1e7;font-family:Georgia,'Times New Roman',serif;color:#2c2620;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:${GOLD};padding:20px 32px;">
          <span style="font-size:20px;font-weight:bold;color:#2c2620;letter-spacing:.5px;">${BRAND}</span>
        </td></tr>
        <tr><td style="padding:32px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f6f1e7;font-size:12px;color:#8a7f6c;">
          ${BRAND} — cet e-mail vous a été envoyé car il concerne une commande passée sur notre boutique.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function itemsListHtml(items) {
  return (items || []).map((item) => (
    `<li style="margin-bottom:4px;">${esc(item.name)}${item.qty > 1 ? ` × ${item.qty}` : ''}</li>`
  )).join('');
}

/* E-mail 1 — Expédition. Déclenché UNIQUEMENT par un vrai colis Sendcloud
   (voir routes/orders.js) : transporteur et lien de suivi viennent de cet
   appel, jamais fabriqués. */
export function shippingEmailTemplate({ customerName, orderNumber, items, carrier, trackingNumber, trackingUrl }) {
  const subject = `Votre commande ${orderNumber} est en route !`;
  const html = layout(subject, `
    <h1 style="font-size:22px;margin:0 0 16px;">Votre colis est parti, ${esc(customerName)} !</h1>
    <p style="line-height:1.6;">Bonne nouvelle : votre commande <strong>${esc(orderNumber)}</strong> vient d'être expédiée.</p>
    <ul style="line-height:1.6;padding-left:20px;">${itemsListHtml(items)}</ul>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#f6f1e7;border-radius:8px;width:100%;">
      <tr><td style="padding:16px;">
        <p style="margin:0 0 6px;"><strong>Transporteur :</strong> ${esc(carrier)}</p>
        <p style="margin:0;"><strong>Numéro de suivi :</strong> ${esc(trackingNumber)}</p>
      </td></tr>
    </table>
    <p style="text-align:center;margin:24px 0;">
      <a href="${esc(trackingUrl)}" style="background:${GOLD};color:#2c2620;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:bold;display:inline-block;">Suivre mon colis →</a>
    </p>
    <p style="line-height:1.6;color:#5a5142;">À très vite,<br>L'équipe ${BRAND}</p>
  `);
  return { subject, html };
}

/* E-mail 2 — SAV & Retours. `instructionsText` est rédigé par l'IA (voir
   scheduler.js) à partir de la commande et du motif réel du client — jamais
   un texte générique fixe. `labelUrl` est absent si la création de
   l'étiquette retour a échoué : le mail reste honnête sur ce qui est prêt
   plutôt que de prétendre qu'une étiquette existe. */
export function returnEmailTemplate({ customerName, orderNumber, instructionsText, labelUrl }) {
  const subject = `Votre demande de retour — commande ${orderNumber}`;
  const instructionsHtml = esc(instructionsText).replace(/\n{2,}/g, '</p><p style="line-height:1.6;">').replace(/\n/g, '<br>');
  const labelBlock = labelUrl
    ? `<p style="text-align:center;margin:24px 0;">
         <a href="${esc(labelUrl)}" style="background:${GOLD};color:#2c2620;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:bold;display:inline-block;">Télécharger l'étiquette de retour →</a>
       </p>`
    : `<p style="line-height:1.6;background:#fff6e0;border-radius:8px;padding:16px;">Votre étiquette de retour est en cours de préparation et vous parviendra séparément — ou notre équipe vous recontactera directement si besoin.</p>`;
  const html = layout(subject, `
    <h1 style="font-size:22px;margin:0 0 16px;">Votre demande de retour a bien été reçue</h1>
    <p style="line-height:1.6;">Bonjour ${esc(customerName)}, voici la marche à suivre pour votre commande <strong>${esc(orderNumber)}</strong> :</p>
    <p style="line-height:1.6;">${instructionsHtml}</p>
    ${labelBlock}
    <p style="line-height:1.6;color:#5a5142;">Une question ? Il vous suffit de répondre directement à cet e-mail.<br>L'équipe ${BRAND}</p>
  `);
  return { subject, html };
}

/* E-mail 3 — Remerciement & Fidélisation. Déclenché par une vraie livraison
   confirmée (webhook Sendcloud, ou repli manuel côté vendeur) — jamais par
   un délai écoulé. `recommendedProducts` vient du catalogue réel du site. */
export function thankYouEmailTemplate({ customerName, orderNumber, items, recommendedProducts }) {
  const subject = `Merci pour votre commande, ${customerName} !`;
  const recoHtml = (recommendedProducts || []).length
    ? `<h2 style="font-size:17px;margin:28px 0 12px;">Ça pourrait vous plaire aussi</h2>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
         ${recommendedProducts.slice(0, 3).map((p) => `
           <td style="padding:6px;text-align:center;">
             <a href="${esc(p.url)}" style="text-decoration:none;color:#2c2620;">
               ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" width="120" height="120" style="border-radius:8px;object-fit:cover;" alt="${esc(p.name)}">` : ''}
               <p style="font-size:13px;margin:8px 0 0;">${esc(p.name)}</p>
             </a>
           </td>
         `).join('')}
       </tr></table>`
    : '';
  const html = layout(subject, `
    <h1 style="font-size:22px;margin:0 0 16px;">Votre colis est arrivé — merci ${esc(customerName)} !</h1>
    <p style="line-height:1.6;">Nous espérons que vous êtes ravi(e) de votre commande <strong>${esc(orderNumber)}</strong> :</p>
    <ul style="line-height:1.6;padding-left:20px;">${itemsListHtml(items)}</ul>
    <p style="line-height:1.6;">Votre avis compte énormément pour nous et pour les autres clients — dites-nous ce que vous en pensez en répondant simplement à cet e-mail.</p>
    ${recoHtml}
    <p style="line-height:1.6;color:#5a5142;margin-top:24px;">Merci de votre confiance,<br>L'équipe ${BRAND}</p>
  `);
  return { subject, html };
}
