import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runSafely } = await import('../src/services/scheduler.js');

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
