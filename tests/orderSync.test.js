import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncOrdersFromAllChannels,
  SYNC_OVERLAP_MS,
  COLD_START_WINDOW_MS,
} from '../src/services/orderSync.js';

/**
 * Harnais sans base ni réseau : le curseur temporel est testé sur l'état injecté
 * (`state`), les appels au connecteur (`registry`) et une horloge contrôlée.
 */
function makeHarness({ fail = false, orders = [] } = {}) {
  const calls = [];
  const logged = [];
  const registry = {
    ebay: {
      listOrders: async (options) => {
        calls.push(options);
        if (fail) throw new Error('eBay injoignable');
        return orders;
      },
    },
  };
  const db = {
    get: async () => null,
    run: async () => ({ changes: 0 }),
  };
  const log = async (kind, message) => { logged.push({ kind, message }); };
  return { calls, logged, state: {}, registry, db, log };
}

function run(harness, at, extra = {}) {
  return syncOrdersFromAllChannels({
    channels: ['ebay'],
    registry: harness.registry,
    db: harness.db,
    log: harness.log,
    now: () => at,
    state: harness.state,
    ...extra,
  });
}

test('a cold start uses the bounded fallback window instead of all history', async () => {
  const now = Date.parse('2024-06-01T12:00:00.000Z');
  const harness = makeHarness();
  await run(harness, now);

  assert.equal(harness.calls.length, 1);
  assert.equal(
    harness.calls[0].since,
    new Date(now - COLD_START_WINDOW_MS).toISOString(),
    'sans curseur, on repart de la fenêtre bornée (24 h), jamais de tout l’historique',
  );
});

test('the cursor stores the run start and the next run replays it with the overlap margin', async () => {
  const t0 = Date.parse('2024-06-01T12:00:00.000Z');
  const harness = makeHarness();

  await run(harness, t0);
  assert.equal(harness.state.lastSuccessfulSyncStartedAt, t0);

  const t1 = t0 + 5 * 60 * 1000;
  await run(harness, t1);

  assert.equal(harness.calls.length, 2);
  assert.equal(
    harness.calls[1].since,
    new Date(t0 - SYNC_OVERLAP_MS).toISOString(),
    'la 2e passe repart du DÉBUT de la 1re (pas de sa fin), avec la marge de recouvrement',
  );
  assert.equal(harness.state.lastSuccessfulSyncStartedAt, t1);
});

test('a failed run does not advance the cursor', async () => {
  const t0 = Date.parse('2024-06-01T12:00:00.000Z');
  const harness = makeHarness({ fail: true });
  const result = await run(harness, t0);

  assert.equal(result.errors.length, 1);
  assert.equal(harness.state.lastSuccessfulSyncStartedAt, undefined, 'l’échec ne doit pas brûler la fenêtre');

  // La passe suivante réessaie donc la même fenêtre plutôt que de sauter les
  // commandes apparues pendant la panne.
  await run(harness, t0);
  assert.equal(harness.calls[1].since, new Date(t0 - COLD_START_WINDOW_MS).toISOString());
});

test('a channel without listOrders is skipped without blocking the cursor', async () => {
  const t0 = Date.parse('2024-06-01T12:00:00.000Z');
  const state = {};
  const calls = [];
  const registry = {
    ebay: { listOrders: async (options) => { calls.push(options); return []; } },
    // Canal configuré mais sans route de commandes : il est ignoré, pas en échec.
    own_site: {},
  };
  const result = await syncOrdersFromAllChannels({
    channels: ['ebay', 'own_site'],
    registry,
    db: { get: async () => null, run: async () => ({ changes: 0 }) },
    log: async () => {},
    now: () => t0,
    state,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(state.lastSuccessfulSyncStartedAt, t0);
});
