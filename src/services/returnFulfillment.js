import { connectors } from '../connectors/index.js';
import { askModel } from '../ai/client.js';
import { config } from '../config/env.js';
import { cheapestSendcloudMethod, createReturnParcel, isSendcloudConfigured } from './sendcloud.js';
import { sendTransactionalEmail, isEmailConfigured } from './email.js';
import { returnEmailTemplate } from '../emails/templates.js';
import { logActivity } from '../db/database.js';

/*
 * E-mail 2 (SAV & Retours) — déclenché par une VRAIE demande de retour
 * enregistrée par le client sur le site (POST /api/returns côté BBhappy),
 * jamais par un délai. Cette tâche planifiée (voir scheduler.js) se contente
 * de repérer les demandes encore au statut "requested" et de les traiter une
 * seule fois : dès qu'un e-mail est parti, le statut avance ('label_sent' ou
 * 'instructions_sent') pour que le prochain passage l'ignore.
 *
 * La marche à suivre est rédigée par l'IA à partir du motif réel donné par
 * le client — mais un texte par défaut, correct et déjà publié sur le site
 * (politique de retour 30 jours), sert de repli si l'IA est indisponible :
 * le client ne doit jamais rester sans réponse faute de fournisseur IA
 * configuré.
 *
 * Poids par défaut du colis retour : aucune fiche produit du site ne porte
 * de poids (voir products-repo.js côté BBhappy), donc ce poids est une
 * estimation prudente, pas une vraie mesure — documenté ici plutôt que
 * caché dans un nombre magique.
 */
const DEFAULT_RETURN_WEIGHT_KG = 1;

const FALLBACK_INSTRUCTIONS = (
  "Merci de reconditionner l'article dans son emballage d'origine, avec tous ses accessoires.\n\n"
  + "Vous disposez de 30 jours après réception pour nous le retourner. Dès réception de votre colis, "
  + 'nous procédons au remboursement ou à l\'échange sous 5 jours ouvrés.\n\n'
  + "Si une étiquette de retour est jointe à cet e-mail, il vous suffit de l'imprimer et de déposer le "
  + "colis au point relais indiqué. Si elle n'est pas encore disponible, notre équipe vous la fera "
  + 'parvenir séparément.'
);

async function draftReturnInstructions({ orderNumber, items, reason }) {
  if (!config.ai.ready) return FALLBACK_INSTRUCTIONS;
  try {
    const itemsText = (items || []).map((i) => `- ${i.name}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join('\n');
    const text = await askModel({
      system: (
        'Tu rédiges, en français, la marche à suivre pour un retour client d\'une boutique en ligne de jouets/mode. '
        + 'Ton chaleureux et clair, 3 à 5 phrases courtes, jamais de markdown ni de listes à puces (texte brut '
        + 'uniquement, il sera inséré tel quel dans un e-mail). Toujours : reconditionner l\'article, mentionner le '
        + 'délai de remboursement (5 jours ouvrés après réception), et remercier le client pour sa patience. '
        + 'N\'invente jamais de détail (numéro de dossier, date précise, montant) qui ne t\'est pas donné.'
      ),
      prompt: `Commande ${orderNumber}. Articles concernés :\n${itemsText}\n\nMotif donné par le client : "${reason}"`,
      maxTokens: 400,
    });
    return text?.trim() || FALLBACK_INSTRUCTIONS;
  } catch {
    // Une panne IA ne doit jamais priver le client d'une marche à suivre —
    // le texte par défaut, honnête et déjà correct, part à sa place.
    return FALLBACK_INSTRUCTIONS;
  }
}

/** Best effort : l'échec de l'étiquette ne doit jamais empêcher l'envoi de l'e-mail. */
async function tryCreateReturnLabel(order) {
  if (!isSendcloudConfigured()) return null;
  try {
    const method = await cheapestSendcloudMethod({ toCountry: 'FR', weightKg: DEFAULT_RETURN_WEIGHT_KG });
    if (!method) return null;
    const parcel = await createReturnParcel({
      fromName: order.name,
      fromAddress: order.address,
      fromCity: order.city,
      fromPostalCode: order.zip,
      fromCountry: 'FR',
      fromEmail: order.email,
      shippingMethodId: method.id,
      weightKg: DEFAULT_RETURN_WEIGHT_KG,
      orderNumber: order.id,
    });
    return parcel.labelUrl || null;
  } catch {
    return null;
  }
}

async function handleOneReturn(order, connector) {
  const instructions = await draftReturnInstructions({
    orderNumber: order.id,
    items: order.items,
    reason: order.returnReason || 'Non précisé',
  });
  const labelUrl = await tryCreateReturnLabel(order);

  const { subject, html } = returnEmailTemplate({
    customerName: order.name,
    orderNumber: order.id,
    instructionsText: instructions,
    labelUrl,
  });

  if (isEmailConfigured()) {
    try {
      await sendTransactionalEmail({ toEmail: order.email, toName: order.name, subject, html });
      await logActivity('EMAIL_ENVOYE', `E-mail "retour" envoyé pour la commande ${order.id} à ${order.email}${labelUrl ? ' (avec étiquette)' : ' (sans étiquette — à suivre manuellement)'}.`);
    } catch (error) {
      // L'e-mail n'est pas parti : on ne fait PAS avancer le statut, pour que
      // le prochain passage retente plutôt que de laisser le client sans
      // réponse avec un statut qui prétend que c'est réglé.
      await logActivity('EMAIL_ECHEC', `E-mail "retour" pour la commande ${order.id} : échec d'envoi — ${error.message}`);
      return { ok: false };
    }
  } else {
    await logActivity('EMAIL_IGNORE', `E-mail "retour" pour la commande ${order.id} non envoyé : Brevo non configuré (BREVO_API_KEY / BREVO_SENDER_EMAIL).`);
    return { ok: false };
  }

  await connector.markReturnHandled(order.id, {
    returnStatus: labelUrl ? 'label_sent' : 'instructions_sent',
    returnLabelUrl: labelUrl,
  });
  return { ok: true, labelUrl: Boolean(labelUrl) };
}

/**
 * Repère les demandes de retour non encore traitées et envoie l'e-mail SAV
 * pour chacune. Chaque retour est isolé (un échec n'empêche pas les
 * suivants), comme processProductImages pour le studio photo.
 */
export async function processPendingReturns({ registry = connectors } = {}) {
  const connector = registry.own_site;
  if (!connector?.isConfigured?.()) {
    throw new Error('Connecteur site propre non configuré — impossible de lire les demandes de retour (OWN_SITE_API_URL + OWN_SITE_API_KEY).');
  }

  const orders = await connector.listOrders();
  const pending = orders.filter((o) => o.returnStatus === 'requested');

  const results = { handled: 0, withLabel: 0, errors: [] };
  for (const order of pending) {
    try {
      const outcome = await handleOneReturn(order, connector);
      if (outcome.ok) {
        results.handled += 1;
        if (outcome.labelUrl) results.withLabel += 1;
      }
    } catch (error) {
      results.errors.push({ orderId: order.id, message: error.message });
    }
  }

  if (pending.length) {
    await logActivity(
      'RETOURS_TRAITES',
      `Retours traités : ${results.handled}/${pending.length} (dont ${results.withLabel} avec étiquette réelle)${results.errors.length ? `, ${results.errors.length} erreur(s)` : ''}.`,
    );
  }
  return results;
}
