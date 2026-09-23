import { Router } from 'express';
import { dbAll, dbGet, dbRun, logActivity } from '../db/database.js';
import { config } from '../config/env.js';
import { allChannelsStatus } from '../connectors/index.js';
import { generatePriceRecommendations } from '../ai/priceOptimizer.js';
import { generateDescription } from '../ai/descriptionWriter.js';
import { qualifySupportMessage } from '../ai/supportAgent.js';
import { syncStockFromAllChannels } from '../services/stockSync.js';
import { syncOrdersFromAllChannels } from '../services/orderSync.js';
import {
  pushPriceToChannel,
  pushPriceToAllChannels,
  hasSuccessfulPush,
} from '../services/pushSync.js';

export const api = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

/*
 * Décrit la base visée sans jamais exposer le jeton ni l'adresse complète.
 * `persistent` distingue la base locale (perdue à chaque redéploiement) d'une
 * base distante, et l'hôte seul suffit à vérifier d'un coup d'œil qu'on pointe
 * la bonne. Même idée que describeDatabase() dans server.js, recopiée ici :
 * importer server.js depuis une route créerait un cycle (server → routes).
 */
export function describeDatabaseConfig(url) {
  if (String(url).startsWith('file:')) return { persistent: false, host: null };
  try {
    return { persistent: true, host: new URL(url).hostname || null };
  } catch {
    // Adresse illisible : on ne prétend pas connaître l'hôte, mais une base
    // qui n'est pas un fichier local reste une base distante (donc persistante).
    return { persistent: true, host: null };
  }
}

/*
 * Noms des variables encore à renseigner, en français et groupés par fonction.
 * On ne renvoie jamais une valeur : le tableau de bord doit pouvoir dire
 * « ajoute AI_MODEL » sans qu'aucune clé ne transite par le navigateur. La
 * liste est déduite de l'état réel (getters de config), pas d'une liste figée :
 * une variable ajoutée sur la plateforme disparaît d'ici immédiatement.
 */
export function missingConfiguration() {
  const missing = [];

  if (!config.ai.ready) {
    // Nommer précisément ce qui bloque : « IA non configurée » n'aide personne
    // à réparer, alors que « AI_MODEL » se corrige en dix secondes.
    const provider = config.ai.provider;
    if (provider === 'anthropic') {
      missing.push('ANTHROPIC_API_KEY');
    } else if (provider === 'openai') {
      missing.push(['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'].filter((key) => !process.env[key]).join(' + '));
    } else {
      missing.push('ANTHROPIC_API_KEY (ou AI_BASE_URL + AI_API_KEY + AI_MODEL)');
    }
  }

  if (!config.ownSite.ready) {
    missing.push(['OWN_SITE_API_URL', 'OWN_SITE_API_KEY'].filter((key) => !process.env[key]).join(' + '));
  }

  /* eBay est volontairement exclu de cette liste. C'est un canal optionnel,
     dont les clés dépendent d'un compte vendeur et d'une inscription
     développeur : on peut parfaitement ne jamais le configurer. L'y inclure
     rendrait le bandeau d'état définitivement orange, y compris quand tout ce
     dont on a besoin est en place — et un avertissement qu'on ne peut pas faire
     disparaître finit par ne plus être lu. Son état reste visible dans
     `channels.ebay` : c'est une information, pas une alerte. */
  return missing;
}

// --- Supervision ---
api.get('/health', (req, res) => {
  res.json({ ok: true });
});

// --- État des connecteurs ---
api.get('/channels', (req, res) => {
  res.json(allChannelsStatus());
});

/*
 * État de la configuration, à destination du tableau de bord.
 *
 * Sans cette route, une variable oubliée ne se voyait qu'au moment du clic :
 * l'utilisateur lançait une génération et recevait une erreur sans jamais
 * apprendre que le fournisseur IA n'avait jamais été configuré. On expose donc
 * des présences/absences et des NOMS de variables — jamais une valeur secrète.
 */
api.get('/config', (req, res) => {
  const channels = {};
  for (const { channel, configured } of allChannelsStatus()) channels[channel] = configured;

  res.json({
    database: describeDatabaseConfig(config.turso.url),
    access: { protected: Boolean(config.admin.apiKey) },
    ai: {
      configured: config.ai.ready,
      provider: config.ai.provider,
      model: config.ai.model,
      // La raison est écrite pour être affichée telle quelle : c'est elle qui
      // explique le bandeau rouge, sans que le tableau de bord ait à deviner.
      reason: config.ai.reason,
    },
    channels,
    /* Coefficient de marge global, exposé pour que le tableau de bord puisse
       écrire noir sur blanc quelle marge s'applique quand le partenaire choisi
       n'en a pas de propre. Ce n'est pas un secret : c'est la règle de prix du
       hub, et la cacher obligerait l'interface à deviner ou à mentir. */
    pricing: {
      marginCoefficient: config.pricing.marginCoefficient,
      fixedFee: config.pricing.fixedFee,
    },
    sendcloud: { configured: config.sendcloud.ready },
    missing: missingConfiguration(),
  });
});

// --- Produits ---
api.get(
  '/products',
  asyncRoute(async (req, res) => {
    const products = await dbAll('SELECT * FROM products ORDER BY created_at DESC');
    const withListings = await Promise.all(
      products.map(async (p) => ({
        ...p,
        listings: await dbAll('SELECT * FROM channel_listings WHERE product_id = ?', [p.id]),
      })),
    );
    res.json(withListings);
  }),
);

api.post(
  '/products',
  asyncRoute(async (req, res) => {
    const { sku, name, description = '', costPrice = 0 } = req.body || {};
    if (!sku || !name) throw new Error('sku et name sont obligatoires.');
    if (!Number.isFinite(costPrice) || costPrice < 0) throw new Error('costPrice invalide.');
    const info = await dbRun(
      'INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)',
      [sku, name, description, costPrice, Date.now()],
    );
    await logActivity('PRODUIT_CREE', `Produit ajouté : ${name} (${sku})`);
    res.status(201).json({ id: info.lastInsertRowid });
  }),
);

// --- Commandes ---
api.get(
  '/orders',
  asyncRoute(async (req, res) => {
    res.json(await dbAll('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100'));
  }),
);

api.post(
  '/sync/orders',
  asyncRoute(async (req, res) => {
    res.json(await syncOrdersFromAllChannels());
  }),
);

api.post(
  '/sync/stock',
  asyncRoute(async (req, res) => {
    res.json(await syncStockFromAllChannels());
  }),
);

// --- Push d'un prix vers les canaux ---
api.post(
  '/products/:productId/price',
  asyncRoute(async (req, res) => {
    const productId = Number(req.params.productId);
    const { price, channel } = req.body || {};
    if (!Number.isFinite(price) || price <= 0) throw new Error('Prix invalide.');

    if (channel) {
      res.json(await pushPriceToChannel(productId, channel, price));
      return;
    }
    res.json(await pushPriceToAllChannels(productId, price));
  }),
);

// --- Recommandations IA ---
api.get(
  '/recommendations',
  asyncRoute(async (req, res) => {
    const status = req.query.status;
    const rows = status
      ? await dbAll('SELECT * FROM recommendations WHERE status = ? ORDER BY created_at DESC', [status])
      : await dbAll('SELECT * FROM recommendations ORDER BY created_at DESC LIMIT 100');
    res.json(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
  }),
);

api.post(
  '/recommendations/price/:productId',
  asyncRoute(async (req, res) => {
    const productId = Number(req.params.productId);
    res.json(await generatePriceRecommendations(productId));
  }),
);

api.post(
  '/recommendations/description/:productId/:channel',
  asyncRoute(async (req, res) => {
    const productId = Number(req.params.productId);
    res.json(await generateDescription(productId, req.params.channel));
  }),
);

/*
 * Appliquer une recommandation.
 *
 * Seules les recommandations de type « price » ont quelque chose à pousser : le
 * prix suggéré part réellement vers le canal visé, et le statut ne passe à
 * « applied » que si le canal a accepté. Avant, la route se contentait de
 * changer le statut — le bouton du tableau de bord était décoratif et la
 * promesse « synchroniser automatiquement stock et prix » n'était pas tenue.
 *
 * Les recommandations « description » et « support » n'ont rien à pousser : le
 * texte généré est publié par le module d'import, la réponse de support est
 * envoyée par le vendeur. Elles gardent donc l'ancien comportement (bascule du
 * statut) ; on ne simule pas une synchronisation qui n'existe pas.
 */
api.post(
  '/recommendations/:id/apply',
  asyncRoute(async (req, res) => {
    const recommendation = await dbGet('SELECT * FROM recommendations WHERE id = ?', [req.params.id]);
    if (!recommendation || recommendation.status !== 'pending') {
      throw new Error('Recommandation introuvable ou déjà traitée.');
    }

    if (recommendation.type !== 'price') {
      await dbRun("UPDATE recommendations SET status = 'applied' WHERE id = ?", [recommendation.id]);
      await logActivity('RECOMMANDATION_APPLIQUEE', `Recommandation #${recommendation.id} marquée comme appliquée.`);
      res.json({ ok: true });
      return;
    }

    if (!recommendation.channel) {
      throw new Error(`Recommandation de prix #${recommendation.id} sans canal : impossible de savoir où pousser le prix.`);
    }

    const payload = JSON.parse(recommendation.payload);
    const suggestedPrice = payload.suggestedPrice;
    if (!Number.isFinite(suggestedPrice) || suggestedPrice <= 0) {
      throw new Error(`Recommandation de prix #${recommendation.id} sans prix suggéré exploitable.`);
    }

    // Un échec ici laisse la recommandation « pending » : la base ne connaît
    // pas d'état « echec », et l'utilisateur doit pouvoir réessayer après avoir
    // corrigé la cause (clé du canal, offre supprimée…).
    let result;
    try {
      result = await pushPriceToChannel(recommendation.product_id, recommendation.channel, suggestedPrice);
    } catch (error) {
      throw new Error(`Échec de l'application de la recommandation #${recommendation.id} sur ${recommendation.channel} : ${error.message}`);
    }

    if (!hasSuccessfulPush([result])) {
      const reason = result.error || result.reason || 'canal non pris en charge';
      throw new Error(`Recommandation #${recommendation.id} non appliquée sur ${recommendation.channel} : ${reason}`);
    }

    await dbRun("UPDATE recommendations SET status = 'applied' WHERE id = ?", [recommendation.id]);
    await logActivity(
      'RECOMMANDATION_APPLIQUEE',
      `Recommandation #${recommendation.id} appliquée : prix ${suggestedPrice.toFixed(2)} € poussé sur ${recommendation.channel}.`,
    );
    res.json({ ok: true, price: suggestedPrice, channel: recommendation.channel });
  }),
);

api.post(
  '/recommendations/:id/dismiss',
  asyncRoute(async (req, res) => {
    const info = await dbRun(
      "UPDATE recommendations SET status = 'dismissed' WHERE id = ? AND status = 'pending'",
      [req.params.id],
    );
    if (info.changes === 0) throw new Error('Recommandation introuvable ou déjà traitée.');
    res.json({ ok: true });
  }),
);

// --- Support client ---
api.post(
  '/support/qualify',
  asyncRoute(async (req, res) => {
    const { orderId, customerMessage } = req.body || {};
    res.json(await qualifySupportMessage({ orderId, customerMessage }));
  }),
);

// --- Journal d'activité ---
api.get(
  '/activity',
  asyncRoute(async (req, res) => {
    res.json(await dbAll('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 100'));
  }),
);
