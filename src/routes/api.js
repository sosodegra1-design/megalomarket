import { Router } from 'express';
import { db, logActivity } from '../db/database.js';
import { allChannelsStatus } from '../connectors/index.js';
import { generatePriceRecommendations } from '../ai/priceOptimizer.js';
import { generateDescription } from '../ai/descriptionWriter.js';
import { qualifySupportMessage } from '../ai/supportAgent.js';
import { syncStockFromAllChannels } from '../services/stockSync.js';
import { syncOrdersFromAllChannels } from '../services/orderSync.js';

export const api = Router();

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      res.status(400).json({ error: error.message });
    });
  };
}

// --- État des connecteurs ---
api.get('/channels', (req, res) => {
  res.json(allChannelsStatus());
});

// --- Produits ---
api.get('/products', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  const listings = db.prepare('SELECT * FROM channel_listings WHERE product_id = ?');
  res.json(products.map((p) => ({ ...p, listings: listings.all(p.id) })));
});

api.post(
  '/products',
  asyncRoute(async (req, res) => {
    const { sku, name, description = '', costPrice = 0 } = req.body || {};
    if (!sku || !name) throw new Error('sku et name sont obligatoires.');
    if (!Number.isFinite(costPrice) || costPrice < 0) throw new Error('costPrice invalide.');
    const info = db
      .prepare('INSERT INTO products (sku, name, description, cost_price, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sku, name, description, costPrice, Date.now());
    logActivity('PRODUIT_CREE', `Produit ajouté : ${name} (${sku})`);
    res.status(201).json({ id: info.lastInsertRowid });
  }),
);

// --- Commandes ---
api.get('/orders', (req, res) => {
  res.json(db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all());
});

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

// --- Recommandations IA ---
api.get('/recommendations', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM recommendations WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM recommendations ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
});

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

api.post(
  '/recommendations/:id/apply',
  asyncRoute(async (req, res) => {
    const info = db
      .prepare("UPDATE recommendations SET status = 'applied' WHERE id = ? AND status = 'pending'")
      .run(req.params.id);
    if (info.changes === 0) throw new Error('Recommandation introuvable ou déjà traitée.');
    logActivity('RECOMMANDATION_APPLIQUEE', `Recommandation #${req.params.id} marquée comme appliquée.`);
    res.json({ ok: true });
  }),
);

api.post(
  '/recommendations/:id/dismiss',
  asyncRoute(async (req, res) => {
    const info = db
      .prepare("UPDATE recommendations SET status = 'dismissed' WHERE id = ? AND status = 'pending'")
      .run(req.params.id);
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
api.get('/activity', (req, res) => {
  res.json(db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 100').all());
});
