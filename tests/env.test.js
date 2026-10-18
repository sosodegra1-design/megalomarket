import { test } from 'node:test';
import assert from 'node:assert/strict';

const { config } = await import('../src/config/env.js');

test('lumivita.ready is false when the catalogue file is missing', () => {
  const saved = process.env.LUMIVITA_CATALOG_PATH;
  process.env.LUMIVITA_CATALOG_PATH = '/chemin/inexistant/lumivita.json';
  try {
    assert.equal(config.lumivita.ready, false);
  } finally {
    if (saved === undefined) delete process.env.LUMIVITA_CATALOG_PATH;
    else process.env.LUMIVITA_CATALOG_PATH = saved;
  }
});

test('amazon.ready is false with no keys configured', () => {
  assert.equal(config.amazon.ready, false);
});

test('config exposes a default port', () => {
  assert.equal(typeof config.port, 'number');
});
