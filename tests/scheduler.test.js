import { test } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';

const { runSafely, startScheduler } = await import('../src/services/scheduler.js');

/**
 * Capture les appels à `schedule` sans installer de vrai timer : `startScheduler`
 * accepte une fonction d'enregistrement en paramètre, donc les tests vérifient
 * les expressions et l'option `noOverlap` sans dépendre de l'état interne de
 * node-cron ni laisser un heartbeat actif après le test.
 */
function captureSchedules() {
  const registered = [];
  return {
    registered,
    schedule: (expression, fn, options) => {
      registered.push({ expression, fn, options });
      return { destroy() {} };
    },
  };
}

/** Capture console.error pour ne pas polluer la sortie du test (et vérifier le repli). */
function silenceConsoleError() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

test('runSafely resolves a successful job without logging anything', async () => {
  let logged = 0;
  await runSafely('stock', async () => {}, async () => { logged += 1; });
  assert.equal(logged, 0);
});

test('a failing job is logged as ERREUR_SYNC instead of escaping the callback', async () => {
  const logs = [];
  await runSafely(
    'stock',
    async () => { throw new Error('eBay injoignable'); },
    async (kind, message) => { logs.push({ kind, message }); },
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'ERREUR_SYNC');
  assert.match(logs[0].message, /synchronisation stock planifiée/);
  assert.match(logs[0].message, /eBay injoignable/);
});

test('a failing logger cannot escape as an unhandled rejection', async () => {
  const silence = silenceConsoleError();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let attempted = false;
    await assert.doesNotReject(() =>
      runSafely('commandes', async () => { throw new Error('sync HS'); }, async () => {
        attempted = true;
        throw new Error('base indisponible');
      }),
    );
    // Laisse le cycle d'événements vider les microtâches avant de conclure.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempted, true, 'la journalisation a bien été tentée');
    assert.deepEqual(unhandled, []);
    assert.match(silence.lines.join('\n'), /base indisponible/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    silence.restore();
  }
});

test('throwing a non-Error value is contained the same way', async () => {
  const logs = [];
  await assert.doesNotReject(() =>
    runSafely('stock', async () => { throw null; }, async (kind, message) => { logs.push(message); }),
  );
  assert.equal(logs.length, 1);
});

test('startScheduler registers both sync jobs with the exact pre-v4 expressions', async () => {
  const { registered, schedule } = captureSchedules();
  const logs = [];
  const logger = async (kind, message) => { logs.push({ kind, message }); };

  await startScheduler({ schedule, stockJob: async () => {}, ordersJob: async () => {}, logger });

  // Les deux cadences historiques ne doivent pas bouger avec le passage en v4.
  assert.deepEqual(
    registered.map((entry) => entry.expression),
    ['*/15 * * * *', '*/5 * * * *'],
  );
  assert.deepEqual(
    registered.map((entry) => entry.options?.noOverlap),
    [true, true],
  );
  // Les expressions sont bien comprises par le node-cron réellement installé.
  for (const { expression } of registered) {
    assert.equal(cron.validate(expression), true, `${expression} doit être valide en v4`);
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'DEMARRAGE');
});

test('the callbacks registered by startScheduler contain a failing job instead of rejecting', async () => {
  const { registered, schedule } = captureSchedules();
  const logs = [];
  const logger = async (kind, message) => { logs.push({ kind, message }); };

  await startScheduler({
    schedule,
    stockJob: async () => { throw new Error('eBay injoignable'); },
    ordersJob: async () => { throw new Error('eBay injoignable'); },
    logger,
  });

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const { fn } of registered) {
      await assert.doesNotReject(() => fn(), 'un callback cron ne doit jamais rejeter');
    }
    // Laisse le cycle d'événements vider les microtâches avant de conclure.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  const errors = logs.filter((entry) => entry.kind === 'ERREUR_SYNC');
  assert.equal(errors.length, 2, 'chaque tick en échec doit être journalisé, sans fuite');
  assert.match(errors[0].message, /synchronisation stock planifiée/);
  assert.match(errors[1].message, /synchronisation commandes planifiée/);
});
