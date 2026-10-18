/*
 * Contrôle visuel des photos SANS clé Anthropic : avec un fournisseur
 * « compatible OpenAI » (Ollama, Gemini, Groq…), les images partent en
 * `image_url` vers /chat/completions. global.fetch est remplacé par un stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'http://localhost:11434/v1/';
process.env.AI_API_KEY = 'ollama';
process.env.AI_MODEL = 'llama3.1';
delete process.env.AI_VISION_MODEL;

const { askVision } = await import('../src/ai/client.js');

const IMAGES = [{ source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }];

function stubFetch(responder) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return responder();
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const okReply = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"overallOk": true}' } }] }) });

test('askVision sends images as image_url data URLs to the OpenAI-compatible provider', async () => {
  process.env.AI_VISION_MODEL = 'llama3.2-vision';
  const mock = stubFetch(okReply);
  try {
    const text = await askVision({ system: 'sys', prompt: 'regarde', images: IMAGES });
    assert.equal(text, '{"overallOk": true}');
    assert.equal(mock.calls[0].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(mock.calls[0].body.model, 'llama3.2-vision', 'AI_VISION_MODEL prime sur AI_MODEL');
    const userContent = mock.calls[0].body.messages[1].content;
    assert.deepEqual(userContent[0], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
    assert.deepEqual(userContent[1], { type: 'text', text: 'regarde' });
  } finally {
    delete process.env.AI_VISION_MODEL;
    mock.restore();
  }
});

test('askVision falls back to AI_MODEL when AI_VISION_MODEL is not set', async () => {
  const mock = stubFetch(okReply);
  try {
    await askVision({ system: 'sys', prompt: 'p', images: IMAGES });
    assert.equal(mock.calls[0].body.model, 'llama3.1');
  } finally {
    mock.restore();
  }
});

test('a provider error on vision tells the user to set AI_VISION_MODEL', async () => {
  const mock = stubFetch(() => ({ ok: false, status: 400, text: async () => 'model does not support images' }));
  try {
    await assert.rejects(
      () => askVision({ system: 'sys', prompt: 'p', images: IMAGES }),
      /AI_VISION_MODEL/,
    );
  } finally {
    mock.restore();
  }
});

test('a reasoning model\'s <think> block is stripped from the answer', async () => {
  const { askModel } = await import('../src/ai/client.js');
  const mock = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '<think>je réfléchis…\n{"x":0}</think>\n{"ok": true}' } }] }) }));
  try {
    assert.equal(await askModel({ system: 's', prompt: 'p' }), '{"ok": true}');
  } finally {
    mock.restore();
  }
});

test('a reasoning model that never closes <think> gives a clear error instead of garbage', async () => {
  const { askModel } = await import('../src/ai/client.js');
  const mock = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '<think>\nOkay, the user wants me to' } }] }) }));
  try {
    await assert.rejects(() => askModel({ system: 's', prompt: 'p' }), /AI_NO_THINK/);
  } finally {
    mock.restore();
  }
});

test('AI_NO_THINK appends /no_think for qwen3 text calls only', async () => {
  const { askModel } = await import('../src/ai/client.js');
  const saved = { model: process.env.AI_MODEL, flag: process.env.AI_NO_THINK };
  process.env.AI_MODEL = 'qwen3:8b';
  process.env.AI_NO_THINK = 'true';
  const mock = stubFetch(okReply);
  try {
    await askModel({ system: 's', prompt: 'bonjour' });
    assert.equal(mock.calls[0].body.messages[1].content, 'bonjour\n\n/no_think');
    process.env.AI_MODEL = 'llama3.1:8b';
    await askModel({ system: 's', prompt: 'bonjour' });
    assert.equal(mock.calls[1].body.messages[1].content, 'bonjour', 'autre modèle : prompt inchangé');
  } finally {
    process.env.AI_MODEL = saved.model;
    if (saved.flag === undefined) delete process.env.AI_NO_THINK; else process.env.AI_NO_THINK = saved.flag;
    mock.restore();
  }
});
