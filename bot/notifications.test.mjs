import test from 'node:test';
import assert from 'node:assert/strict';
import { registerNotifications } from './notifications.mjs';

function fixture(transport, registrationStatus = 'APPROVED_MANUAL', localDemo = true) {
  let hook; const messages = []; const warnings = [];
  const pool = { async query(sql, [ids]) {
    assert.ok(sql.includes('ANY($1::uuid[])'));
    return { rows: ids.map(id => ({ id, tg_id: id === 'demo' ? 100001 : id === 'isolated-demo' ? 800000000000026 : 345678901, display_name: 'Участник', registration_status: registrationStatus, validation_status: 'VALID', uid_status: 'VALID' })) };
  } };
  registerNotifications({ addHook(name, fn) { assert.equal(name, 'onResponse'); hook = fn; }, log: { warn: (...args) => warnings.push(args) } }, pool, {
    localDemo, adminTgIds: [900001, 900002, 123456789, 234567890],
    notifyTransport: transport || (async message => { messages.push(message); return { ok: true }; }),
  });
  return { hook, messages, warnings };
}
test('registration goes to real administrators and participant, without private submission fields', async () => {
  const f = fixture();
  await f.hook({ tournamentEvent: { type: 'registration', userId: 'real', tgId: 345678901, withdrawal_tx_hash: 'PRIVATE_HASH', exchange_uid: 'PRIVATE_UID' } }, { statusCode: 200 });
  assert.deepEqual(f.messages.map(m => m.chat_id), [123456789, 234567890, 345678901]);
  assert.ok(f.messages.slice(0, 2).every(m => m.text.includes('345678901')));
  assert.ok(f.messages.every(m => !m.text.includes('PRIVATE')));
});
test('registration and status changes explain pending/rejected access and administrator contacts', async () => {
  for (const status of ['PENDING_VALIDATION', 'REJECTED', 'APPROVED_AUTO', 'APPROVED_MANUAL']) {
    for (const type of ['registration', 'registration_status']) {
      const f = fixture(undefined, status);
      await f.hook({ tournamentEvent: { type, userId: 'real' } }, { statusCode: 200 });
      const notice = f.messages.find(m => m.chat_id === 345678901).text;
      if (status === 'PENDING_VALIDATION' || status === 'REJECTED') {
        assert.ok(notice.includes('@LeoCryptus') && notice.includes('@D_mOnII'));
        assert.ok(notice.includes(status === 'REJECTED' ? 'отклонён' : 'не допущены'));
      } else assert.ok(notice.includes('Вы допущены'));
    }
  }
});
test('synthetic registration creates no Telegram notifications', async () => {
  const f = fixture();
  await f.hook({ tournamentEvent: { type: 'registration', userId: 'demo' } }, { statusCode: 200 });
  assert.equal(f.messages.length, 0);
});
test('isolated demo never generates notifications in any runtime mode', async () => {
  for (const localDemo of [true, false]) {
    const f = fixture(undefined, 'APPROVED_MANUAL', localDemo);
    for (const type of ['registration', 'wallet', 'registration_status', 'wallet_status', 'uid_status']) {
      await f.hook({ tournamentEvent: { type, userId: 'isolated-demo' } }, { statusCode: 200 });
    }
    await f.hook({ tournamentEvent: { type: 'scoring', userIds: ['isolated-demo'] } }, { statusCode: 200 });
    assert.equal(f.messages.length, 0);
  }
});
test('unsuccessful API requests never notify', async () => {
  const f = fixture();
  await f.hook({ tournamentEvent: { type: 'wallet', userId: 'real' } }, { statusCode: 422 });
  assert.equal(f.messages.length, 0);
});
test('delivery errors preserve completed request and log only safe error code', async () => {
  const f = fixture(async () => { throw new Error('https://api.telegram.org/botSECRET/sendMessage'); });
  await f.hook({ tournamentEvent: { type: 'wallet_status', userId: 'real' } }, { statusCode: 200 });
  assert.equal(f.warnings.length, 1);
  assert.ok(!JSON.stringify(f.warnings).includes('SECRET'));
});
test('moderation notifies own participant and scoring deduplicates recipients', async () => {
  const f = fixture();
  await f.hook({ tournamentEvent: { type: 'registration_status', userId: 'real' } }, { statusCode: 200 });
  await f.hook({ tournamentEvent: { type: 'scoring', userIds: ['real', 'real', 'demo'] } }, { statusCode: 200 });
  assert.equal(f.messages.length, 2);
  assert.ok(f.messages.every(m => m.chat_id === 345678901));
});
