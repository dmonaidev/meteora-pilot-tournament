import test from 'node:test';
import assert from 'node:assert/strict';
import { BotError, replyBody, processUpdates } from './polling.mjs';
test('local website returns plain text without Telegram inline URL', () => {
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://192.168.1.2:3000']) {
    const body = replyBody(123, 'Подтверждено', new URL(url));
    assert.equal(body.reply_markup, undefined);
    assert.ok(body.text.includes('исходную вкладку'));
  }
  assert.equal(replyBody(123, 'OK', new URL('https://synergyhub.top')).reply_markup.inline_keyboard[0][0].url, 'https://synergyhub.top/');
});
test('permanent reply rejection acknowledges first update and processes next token', async () => {
  const processed = [], acknowledged = [], warnings = [];
  await processUpdates([{ update_id: 1 }, { update_id: 2 }], async update => {
    processed.push(update.update_id);
    if (update.update_id === 1) throw new BotError(400, undefined, 'sendMessage');
  }, offset => acknowledged.push(offset), warning => warnings.push(warning));
  assert.deepEqual(processed, [1, 2]); assert.deepEqual(acknowledged, [2, 3]);
  assert.deepEqual(warnings, [{ method: 'sendMessage', code: 400 }]);
});
test('transient rejection preserves failed update for retry while keeping prior acknowledgement', async () => {
  for (const code of [429, 500, 'NETWORK']) {
    const acknowledged = [];
    await assert.rejects(processUpdates([{ update_id: 1 }, { update_id: 2 }], async update => {
      if (update.update_id === 2) throw new BotError(code, 10, 'sendMessage');
    }, offset => acknowledged.push(offset), () => {}), BotError);
    assert.deepEqual(acknowledged, [2]);
  }
});
test('auth and conflict failures propagate rather than silently skipping', async () => {
  for (const code of [401, 409]) await assert.rejects(processUpdates([{ update_id: 1 }], async () => { throw new BotError(code, undefined, 'sendMessage'); }, () => assert.fail('must not acknowledge'), () => {}), BotError);
});
