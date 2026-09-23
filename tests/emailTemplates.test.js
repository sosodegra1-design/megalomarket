import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingEmailTemplate, returnEmailTemplate, thankYouEmailTemplate } from '../src/emails/templates.js';

test('shippingEmailTemplate embeds the real carrier and tracking link, escapes the customer name', async () => {
  const { subject, html } = shippingEmailTemplate({
    customerName: 'Ada <script>alert(1)</script>',
    orderNumber: 'BB123',
    items: [{ name: 'Puzzle 3D', qty: 2 }],
    carrier: 'Colissimo',
    trackingNumber: '6A12345',
    trackingUrl: 'https://laposte.fr/track/6A12345',
  });
  assert.match(subject, /BB123/);
  assert.match(html, /Colissimo/);
  assert.match(html, /6A12345/);
  assert.match(html, /href="https:\/\/laposte\.fr\/track\/6A12345"/);
  assert.match(html, /Puzzle 3D × 2/);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must never appear unescaped');
  assert.match(html, /&lt;script&gt;/);
});

test('returnEmailTemplate shows the AI-drafted instructions and the label link when present', async () => {
  const { html } = returnEmailTemplate({
    customerName: 'Ada',
    orderNumber: 'BB123',
    instructionsText: "Emballez l'article dans son carton d'origine.\n\nDéposez le colis en point relais.",
    labelUrl: 'https://panel.sendcloud.sc/return/456.pdf',
  });
  assert.match(html, /Emballez l'article/);
  assert.match(html, /Déposez le colis/);
  assert.match(html, /href="https:\/\/panel\.sendcloud\.sc\/return\/456\.pdf"/);
  assert.ok(!html.includes('en cours de préparation'), 'must not show the "label not ready" fallback when a label exists');
});

test('returnEmailTemplate is honest when no label could be generated yet', async () => {
  const { html } = returnEmailTemplate({
    customerName: 'Ada',
    orderNumber: 'BB123',
    instructionsText: 'Merci de nous contacter pour la suite.',
    labelUrl: null,
  });
  assert.match(html, /en cours de préparation/);
  assert.ok(!html.includes('Télécharger l\'étiquette'), 'must not claim a download link that does not exist');
});

test('thankYouEmailTemplate lists real items and up to 3 real product recommendations', async () => {
  const { html } = thankYouEmailTemplate({
    customerName: 'Ada',
    orderNumber: 'BB123',
    items: [{ name: 'Puzzle 3D', qty: 1 }],
    recommendedProducts: [
      { name: 'Jeu A', url: 'https://bbhappy.onrender.com/jouets.html?product=p2' },
      { name: 'Jeu B', url: 'https://bbhappy.onrender.com/jouets.html?product=p3' },
      { name: 'Jeu C', url: 'https://bbhappy.onrender.com/jouets.html?product=p4' },
      { name: 'Jeu D (ignoré, au-delà de 3)', url: 'https://bbhappy.onrender.com/jouets.html?product=p5' },
    ],
  });
  assert.match(html, /Jeu A/);
  assert.match(html, /Jeu B/);
  assert.match(html, /Jeu C/);
  assert.ok(!html.includes('Jeu D'), 'only the first 3 recommendations should be rendered');
});

test('thankYouEmailTemplate omits the recommendations block entirely when there are none', async () => {
  const { html } = thankYouEmailTemplate({
    customerName: 'Ada', orderNumber: 'BB123', items: [{ name: 'Puzzle 3D', qty: 1 }], recommendedProducts: [],
  });
  assert.ok(!html.includes('Ça pourrait vous plaire aussi'));
});
