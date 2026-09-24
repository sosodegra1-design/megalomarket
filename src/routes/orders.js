import { Router } from 'express';
import { connectors } from '../connectors/index.js';
import { logActivity } from '../db/database.js';
import { config } from '../config/env.js';
import { createParcel, verifyWebhookSignature } from '../services/sendcloud.js';
import { sendTransactionalEmail, isEmailConfigured } from '../services/email.js';
import { shippingEmailTemplate, thankYouEmailTemplate } from '../emails/templates.js';
import { categoryPageFile } from '../utils/siteCategoryPages.js';

/*
 * Cycle de vie des commandes du site propre : expédition réelle (colis +
 * étiquette Sendcloud), livraison (webhook transporteur ou repli manuel),
 * et les e-mails 1 et 3 qui en découlent. L'e-mail 2 (SAV/retour) est géré
 * par le job planifié de services/scheduler.js, pas ici — il réagit à une
 * demande de retour déjà enregistrée côté site, pas à une action de
 * transport.
 *
 * Principe tenu partout : un e-mail ne part JAMAIS sur un minuteur ou une
 * supposition, seulement en réaction à un événement réel déjà survenu
 * (colis réellement créé, livraison réellement confirmée). Un échec d'envoi
 * d'e-mail est journalisé mais ne défait jamais l'action réelle qui vient
 * d'avoir lieu (le colis part quand même si l'e-mail échoue).
 */

export const ordersRouter = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

function requireOwnSite() {
  const connector = connectors.own_site;
  if (!connector?.isConfigured?.()) {
    throw new Error('Connecteur site propre non configuré — impossible de lire les commandes (OWN_SITE_API_URL + OWN_SITE_API_KEY).');
  }
  return connector;
}

/** Lien produit sur le site, même format que routes/site.js (non exporté de là pour ne pas coupler les deux modules pour deux lignes). */
function productUrl(product) {
  const base = config.ownSite.apiUrl ? String(config.ownSite.apiUrl).replace(/\/+$/, '') : null;
  return base && product.category && product.id ? `${base}/${categoryPageFile(product.category)}?product=${encodeURIComponent(product.id)}` : null;
}

/**
 * Jusqu'à 3 produits de la même catégorie que la commande, hors articles déjà
 * achetés — le cross-sell de l'e-mail de remerciement. Best effort : si le
 * catalogue est illisible, l'e-mail part quand même, simplement sans
 * recommandations plutôt que d'échouer entièrement pour un bonus marketing.
 */
async function recommendedProducts(order) {
  try {
    const catalog = await connectors.own_site.listProducts();
    const purchasedIds = new Set((order.items || []).map((i) => i.productId));
    const categories = new Set((order.items || [])
      .map((i) => catalog.find((p) => p.id === i.productId)?.category)
      .filter(Boolean));
    const candidates = catalog.filter((p) => !purchasedIds.has(p.id) && categories.has(p.category));
    return candidates.slice(0, 3).map((p) => ({
      name: p.name,
      url: productUrl(p),
      imageUrl: Array.isArray(p.images) ? p.images[0] : null,
    }));
  } catch {
    return [];
  }
}

async function sendOrderEmail(kind, { toEmail, toName, subject, html }, orderNumber) {
  if (!isEmailConfigured()) {
    await logActivity('EMAIL_IGNORE', `E-mail "${kind}" pour la commande ${orderNumber} non envoyé : Brevo non configuré (BREVO_API_KEY / BREVO_SENDER_EMAIL).`);
    return;
  }
  try {
    await sendTransactionalEmail({ toEmail, toName, subject, html });
    await logActivity('EMAIL_ENVOYE', `E-mail "${kind}" envoyé pour la commande ${orderNumber} à ${toEmail}.`);
  } catch (error) {
    await logActivity('EMAIL_ECHEC', `E-mail "${kind}" pour la commande ${orderNumber} : échec d'envoi — ${error.message}`);
  }
}

// --- Liste des commandes du site propre, pour le tableau de bord ---
ordersRouter.get(
  '/own-site',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    res.json(await connector.listOrders({ since: req.query.since, status: req.query.status }));
  }),
);

ordersRouter.get(
  '/own-site/:id',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    res.json(await connector.getOrder(req.params.id));
  }),
);

// --- Marque une commande expédiée : vrai colis + vraie étiquette Sendcloud, puis e-mail 1 ---
ordersRouter.post(
  '/own-site/:id/ship',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    const { shippingMethodId, carrierName, weightKg } = req.body || {};
    if (!shippingMethodId) throw new Error('shippingMethodId manquant — choisis un tarif dans la liste Sendcloud.');
    if (!Number.isFinite(Number(weightKg)) || Number(weightKg) <= 0) throw new Error('Poids du colis invalide.');

    const order = await connector.getOrder(req.params.id);
    if (!order) throw new Error(`Commande introuvable (id=${req.params.id}).`);

    const parcel = await createParcel({
      toName: order.name,
      toAddress: order.address,
      toCity: order.city,
      toPostalCode: order.zip,
      toCountry: 'FR',
      toEmail: order.email,
      shippingMethodId,
      weightKg: Number(weightKg),
      orderNumber: order.id,
    });

    const updated = await connector.markOrderShipped(order.id, {
      carrier: carrierName || parcel.carrier || 'Transporteur',
      trackingNumber: parcel.trackingNumber,
      trackingUrl: parcel.trackingUrl,
      labelUrl: parcel.labelUrl,
    });

    await logActivity('COMMANDE_EXPEDIEE', `Commande ${order.id} marquée expédiée (${carrierName || parcel.carrier}, suivi ${parcel.trackingNumber}).`);

    const { subject, html } = shippingEmailTemplate({
      customerName: order.name,
      orderNumber: order.id,
      items: order.items,
      carrier: carrierName || parcel.carrier || 'Transporteur',
      trackingNumber: parcel.trackingNumber,
      trackingUrl: parcel.trackingUrl,
    });
    await sendOrderEmail('expedition', { toEmail: order.email, toName: order.name, subject, html }, order.id);

    res.json({ order: updated, parcel });
  }),
);

// --- Repli manuel : marque livrée sans passer par le webhook transporteur (test, ou webhook manqué) ---
ordersRouter.post(
  '/own-site/:id/deliver',
  asyncRoute(async (req, res) => {
    const connector = requireOwnSite();
    const result = await connector.markOrderDelivered(req.params.id);
    if (!result.alreadyDelivered) {
      const order = result.order;
      const { subject, html } = thankYouEmailTemplate({
        customerName: order.name,
        orderNumber: order.id,
        items: order.items,
        recommendedProducts: await recommendedProducts(order),
      });
      await sendOrderEmail('remerciement', { toEmail: order.email, toName: order.name, subject, html }, order.id);
      await logActivity('COMMANDE_LIVREE', `Commande ${order.id} marquée livrée (repli manuel).`);
    }
    res.json(result);
  }),
);

// --- Webhook Sendcloud : statut réel du transporteur, dont la livraison (déclenche l'e-mail 3 automatiquement) ---
ordersRouter.post(
  '/sendcloud/webhook',
  asyncRoute(async (req, res) => {
    const signature = req.get('Sendcloud-Signature');
    if (!verifyWebhookSignature(req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body), signature)) {
      res.status(401).json({ error: 'Signature Sendcloud invalide ou absente.' });
      return;
    }

    const parcel = req.body?.parcel;
    const orderNumber = parcel?.order_number;
    const statusMessage = String(parcel?.status?.message || '');
    // La liste exacte des statuts Sendcloud n'a pas pu être vérifiée contre un
    // vrai compte (voir services/sendcloud.js) : on détecte "livré" sur le
    // TEXTE du statut plutôt que sur un identifiant numérique deviné, plus
    // robuste à une hypothèse de départ fausse. Tout statut non reconnu est
    // simplement journalisé, jamais traité en erreur.
    const isDelivered = /delivered|livr/i.test(statusMessage);

    if (!orderNumber) {
      await logActivity('SENDCLOUD_WEBHOOK', `Webhook Sendcloud reçu sans order_number exploitable (statut : "${statusMessage}").`);
      res.json({ ok: true, handled: false });
      return;
    }

    if (!isDelivered) {
      await logActivity('SENDCLOUD_WEBHOOK', `Webhook Sendcloud pour la commande ${orderNumber} : statut "${statusMessage}" (pas une livraison, ignoré).`);
      res.json({ ok: true, handled: false });
      return;
    }

    const connector = requireOwnSite();
    const result = await connector.markOrderDelivered(orderNumber);
    if (!result.alreadyDelivered) {
      const order = result.order;
      const { subject, html } = thankYouEmailTemplate({
        customerName: order.name,
        orderNumber: order.id,
        items: order.items,
        recommendedProducts: await recommendedProducts(order),
      });
      await sendOrderEmail('remerciement', { toEmail: order.email, toName: order.name, subject, html }, order.id);
      await logActivity('COMMANDE_LIVREE', `Commande ${order.id} marquée livrée (webhook Sendcloud).`);
    }
    res.json({ ok: true, handled: true, alreadyDelivered: result.alreadyDelivered });
  }),
);
