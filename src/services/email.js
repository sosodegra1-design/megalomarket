import { config } from '../config/env.js';

/*
 * Envoi des e-mails transactionnels post-achat via l'API Brevo (ex-Sendinblue).
 *
 * Un seul point d'entrée (sendTransactionalEmail) — jamais appelé pour un
 * envoi qui n'est pas déclenché par un événement réel (voir routes/orders.js
 * et services/scheduler.js pour les déclencheurs) : ce module ne fait
 * qu'envoyer ce qu'on lui donne, il ne décide jamais QUAND envoyer.
 *
 * Échec fermé mais sans jamais faire tomber l'appelant : un e-mail qui ne
 * part pas doit être visible dans le Journal, pas faire échouer toute une
 * route d'expédition ou de livraison qui, elle, a réellement eu lieu.
 *
 * AVERTISSEMENT — non vérifié en conditions réelles : ce module a été écrit
 * à partir de la documentation publique de l'API Brevo, sans compte pour le
 * tester contre l'API réelle (ce bac à sable bloque api.brevo.com). Si le
 * format diffère, l'erreur inclut un extrait de la réponse brute.
 */

const API_URL = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 15000;

export function isEmailConfigured() {
  return config.brevo.ready;
}

/**
 * Envoie un e-mail transactionnel. Lève une exception UNIQUEMENT en cas de
 * panne réelle (config manquante, réseau, refus de Brevo) — c'est à
 * l'appelant de décider s'il doit bloquer le reste de son flux ou seulement
 * journaliser l'échec (voir le usage dans routes/orders.js : un e-mail raté
 * ne doit jamais annuler une expédition déjà réelle).
 */
export async function sendTransactionalEmail({ toEmail, toName, subject, html }) {
  if (!isEmailConfigured()) {
    throw new Error('Envoi d\'e-mail indisponible : BREVO_API_KEY et BREVO_SENDER_EMAIL doivent être configurées.');
  }
  if (!toEmail || !subject || !html) {
    throw new Error('toEmail, subject et html sont tous requis pour envoyer un e-mail.');
  }

  const body = {
    sender: { name: config.brevo.senderName, email: config.brevo.senderEmail },
    to: [{ email: toEmail, name: toName || undefined }],
    subject,
    htmlContent: html,
  };

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': config.brevo.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('Brevo injoignable (délai dépassé).');
    }
    throw new Error(`Impossible de contacter Brevo : ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Brevo a refusé l'envoi (HTTP ${response.status}) : ${detail.slice(0, 500)}`);
  }
  const data = await response.json().catch(() => ({}));
  return { messageId: data.messageId || null };
}
