import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramTransport } from './telegram-transport.mjs';
test('injected notification transport is shared unchanged', () => {
  const transport = async () => ({ ok: true });
  assert.equal(createTelegramTransport({ notifyTransport: transport }), transport);
});
test('native transport sends JSON with timeout and returns no Telegram response payload', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { chat_id: 123456789, text: 'PRIVATE_CODE', reply_markup: { inline_keyboard: [[{ text: 'Confirm', callback_data: 'PRIVATE_CHALLENGE' }]] } });
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ ok: true, result: { text: 'PRIVATE_CODE' } }) };
    };
    assert.deepEqual(await createTelegramTransport({ botToken: 'TEST_SECRET' })({ chat_id: 123456789, text: 'PRIVATE_CODE', reply_markup: { inline_keyboard: [[{ text: 'Confirm', callback_data: 'PRIVATE_CHALLENGE' }]] } }), { ok: true });
  } finally { globalThis.fetch = original; }
});
test('API rejection and fetch errors return safe codes without secrets', async () => {
  const original = globalThis.fetch;
  try {
    const transport = createTelegramTransport({ botToken: 'TEST_SECRET' });
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: 'TEST_SECRET PRIVATE_CODE' }) });
    assert.deepEqual(await transport({ chat_id: 123456789, text: 'PRIVATE_CODE' }), { ok: false, error_code: 403 });
    globalThis.fetch = async () => { throw new Error('TEST_SECRET PRIVATE_CODE'); };
    assert.deepEqual(await transport({ chat_id: 123456789, text: 'PRIVATE_CODE' }), { ok: false, error_code: 'DELIVERY_FAILED' });
  } finally { globalThis.fetch = original; }
});
