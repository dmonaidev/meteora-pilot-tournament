import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSessionCallback } from './session.mjs';
import { createTelegramTransport, createTelegramEditor } from './telegram-transport.mjs';
const query = { id: 'callback-id', data: `sr_${'a'.repeat(43)}`, from: { id: 123456789 }, message: { message_id: 5, chat: { id: 987654321, type: 'private' } } };
async function run(status, result, telegramFailure = false) {
  const calls = []; let body;
  await handleSessionCallback(query, { backend: new URL('http://localhost:3000'), secret: 'PRIVATE_SECRET',
    fetchImpl: async (url, options) => { assert.equal(url.pathname, '/api/v1/bot/session/confirm'); body = JSON.parse(options.body); assert.equal(options.headers['X-Bot-Secret'], 'PRIVATE_SECRET'); return { ok: status === 200, status, json: async () => result }; },
    telegram: async (method, payload) => { calls.push({ method, payload }); if (telegramFailure) throw new Error('PRIVATE_SECRET'); },
  });
  return { calls, body };
}
test('confirmation trusts callback sender, strips prefix and removes used button', async () => {
  const { calls, body } = await run(200, { status: 'confirmed' });
  assert.deepEqual(body, { token: 'a'.repeat(43), tg_id: query.from.id });
  assert.equal(calls[0].payload.text, 'Сессия продлена на 30 минут');
  assert.equal(calls[1].method, 'editMessageReplyMarkup');
  assert.deepEqual(calls[1].payload.reply_markup, { inline_keyboard: [] });
  assert.ok(!JSON.stringify(calls).includes('a'.repeat(43)));
});
test('expired or already used confirmation removes button and requests code login', async () => {
  const { calls } = await run(410, { error: { code: 'RENEWAL_EXPIRED' } });
  assert.ok(calls[0].payload.text.includes('истекло'));
  assert.equal(calls.length, 2);
});
test('foreign sender cannot remove owner button and transient failures allow retry', async () => {
  for (const status of [403, 409, 500]) {
    const { calls } = await run(status, { error: { code: 'PRIVATE_MESSAGE' } });
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(calls).includes('PRIVATE_MESSAGE'));
  }
  await run(200, { status: 'confirmed' }, true);
});
test('group callbacks, bots and invalid challenge never contact backend', async () => {
  for (const bad of [{ ...query, data: 'sr_invalid' }, { ...query, from: { id: 123, is_bot: true } }, { ...query, message: { chat: { type: 'group' } } }]) {
    assert.equal(await handleSessionCallback(bad, { fetchImpl: () => assert.fail('backend must not run') }), false);
  }
});
test('send returns only safe message ID and editor removes keyboard without leaking payloads', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 42, text: 'PRIVATE_CODE', token: 'PRIVATE_SECRET' } }) });
    const sent = await createTelegramTransport({ botToken: 'TEST_SECRET' })({ chat_id: 123, text: 'PRIVATE_CODE' });
    assert.deepEqual(sent, { ok: true, message_id: 42 });
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/editMessageReplyMarkup'));
      assert.deepEqual(JSON.parse(options.body), { chat_id: 123, message_id: 42, reply_markup: { inline_keyboard: [] } });
      return { ok: true, json: async () => ({ ok: true, result: { text: 'PRIVATE_CODE' } }) };
    };
    assert.deepEqual(await createTelegramEditor({ botToken: 'TEST_SECRET' })({ chat_id: 123, message_id: sent.message_id }), { ok: true });
    globalThis.fetch = async () => { throw new Error('PRIVATE_SECRET'); };
    assert.deepEqual(await createTelegramEditor({ botToken: 'TEST_SECRET' })({ chat_id: 123, message_id: 42 }), { ok: false, error_code: 'DELIVERY_FAILED' });
  } finally { globalThis.fetch = original; }
});
test('message ID must be positive safe integer and editor supports injected transport', async () => {
  const original = globalThis.fetch;
  try {
    for (const id of [-1, 0, 2.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: id } }) });
      assert.deepEqual(await createTelegramTransport({ botToken: 'TEST_SECRET' })({ chat_id: 123, text: 'test' }), { ok: true });
    }
    const editor = async () => ({ ok: true });
    assert.equal(createTelegramEditor({ editTransport: editor }), editor);
  } finally { globalThis.fetch = original; }
});
test('already removed keyboard is successful cleanup without exposing Telegram description', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message is not modified PRIVATE_SECRET' }) });
    assert.deepEqual(await createTelegramEditor({ botToken: 'TEST_SECRET' })({ chat_id: 123, message_id: 42 }), { ok: true });
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: unrelated failure PRIVATE_SECRET' }) });
    assert.deepEqual(await createTelegramEditor({ botToken: 'TEST_SECRET' })({ chat_id: 123, message_id: 42 }), { ok: false, error_code: 400 });
  } finally { globalThis.fetch = original; }
});
