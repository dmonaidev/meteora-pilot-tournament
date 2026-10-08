import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCodeText, codeUnavailable } from './code.mjs';
test('code cooldown explains remaining seconds without exposing response code', async () => {
  const text = await requestCodeText({ backend: new URL('http://localhost'), secret: 'secret', from: { id: 123456789 }, fetchImpl: async () => ({ status: 429, ok: false, json: async () => ({ error: { code: 'CODE_COOLDOWN' }, retry_after_seconds: 37, code: '987654' }) }) });
  assert.ok(text.includes('37 сек.') && !text.includes('987654'));
});

test('code request authenticates real Telegram identity and preserves leading zeros', async () => {
  let captured;
  const text = await requestCodeText({ backend: new URL('http://127.0.0.1:3000'), secret: 'PRIVATE_SECRET', from: { id: 123456789, username: 'Alice' }, fetchImpl: async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ code: '000123', expires_at: '2026-10-08T12:05:00Z', telegram_identifier: '@Alice' }) };
  } });
  assert.equal(captured.url.pathname, '/api/v1/bot/code');
  assert.equal(captured.options.headers['X-Bot-Secret'], 'PRIVATE_SECRET');
  assert.deepEqual(JSON.parse(captured.options.body), { tg_id: 123456789, tg_username: 'Alice' });
  assert.ok(text.includes('000123') && text.includes('@Alice') && text.includes('5 минут') && text.includes('компьютере'));
  assert.ok(!text.includes('PRIVATE_SECRET'));
});
test('accounts without username send null and display numeric ID', async () => {
  const text = await requestCodeText({ backend: new URL('http://localhost'), secret: 'secret', from: { id: 123456789 }, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).tg_username, null);
    return { ok: true, json: async () => ({ code: '123456', expires_at: '2026-10-08T12:05:00Z', telegram_identifier: '123456789' }) };
  } });
  assert.ok(text.includes('Ваш Telegram: 123456789'));
});
test('backend failures and malformed responses produce only neutral retry instruction', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('PRIVATE_URL_TOKEN'); },
    async () => ({ ok: false, json: async () => ({ error: { message: 'PRIVATE_SECRET' }, code: '123456' }) }),
    async () => ({ ok: true, json: async () => ({ code: 123456, expires_at: 'invalid', telegram_identifier: '@Alice' }) }),
  ]) assert.equal(await requestCodeText({ backend: new URL('http://localhost'), secret: 'secret', from: { id: 123456789 }, fetchImpl }), codeUnavailable);
});
