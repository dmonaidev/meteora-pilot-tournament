import { createTelegramTransport } from './telegram-transport.mjs';
import { accessStatusText } from './access-status.mjs';
// Runs after the response and committed writes. Telegram failures never affect API success.
export function registerNotifications(app, pool, config) {
  const transport = createTelegramTransport(config);
  const administrators = [...new Set(config.adminTgIds || [])].filter(id => !(config.localDemo && [900001, 900002].includes(Number(id))));
  const isSynthetic = id => Number(id) === 800000000000026 || (config.localDemo && [900001, 900002, 100001, 100002, 100003, 100004, 100005, 100006].includes(Number(id)));
  const logFailure = code => app.log?.warn({ code: typeof code === 'number' || code === 'TOKEN_MISSING' ? code : 'DELIVERY_FAILED' }, 'Telegram notification delivery failed');
  async function send(id, text) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0 || isSynthetic(id)) return;
    try {
      const result = await transport({ chat_id: Number(id), text });
      if (!result?.ok) logFailure(result?.error_code);
    } catch { logFailure('DELIVERY_FAILED'); }
  }
  const statuses = {
    VALID: 'Проверка пройдена.', INVALID: 'Проверка не пройдена. Откройте личный кабинет для подробностей.', UNDER_REVIEW: 'Ожидает проверки.',
  };
  async function deliver(event) {
    const ids = event.type === 'scoring' ? [...new Set(event.userIds || [])] : [event.userId];
    if (!ids.length || !ids.every(id => typeof id === 'string')) return;
    const { rows } = await pool.query(`SELECT u.id, u.tg_id, u.display_name, u.registration_status,
      w.validation_status, r.uid_status FROM users u
      LEFT JOIN wallets w ON w.user_id=u.id
      LEFT JOIN partner_rewards r ON r.user_id=u.id
      WHERE u.id = ANY($1::uuid[])`, [ids]);
    const user = rows[0];
    if (!user) return;
    switch (event.type) {
      case 'registration':
      case 'wallet': {
        if (isSynthetic(user.tg_id)) return;
        const name = String(user.display_name || 'Участник').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 80);
        const text = event.type === 'registration'
          ? `Новая регистрация: ${name}. Telegram ID: ${user.tg_id}. Проверьте заявку в админке.`
          : `Кошелёк подан на проверку: ${name}. Telegram ID: ${user.tg_id}. Откройте очередь кошельков в админке.`;
        await Promise.all(administrators.map(id => send(id, text)));
        if (event.type === 'registration') await send(user.tg_id, accessStatusText(user.registration_status));
        break;
      }
      case 'registration_status':
        await send(user.tg_id, accessStatusText(user.registration_status)); break;
      case 'wallet_status':
        await send(user.tg_id, `Кошелёк: ${statuses[user.validation_status] || 'статус обновлён.'}`); break;
      case 'uid_status':
        await send(user.tg_id, `UID биржи: ${statuses[user.uid_status] || 'статус обновлён.'}`); break;
      case 'scoring':
        for (const recipient of rows) await send(recipient.tg_id, 'Ваш результат турнира обновлён. Откройте личный кабинет и лидерборд.'); break;
    }
  }
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300 || !request.tournamentEvent) return;
    await deliver(request.tournamentEvent).catch(() => logFailure('DELIVERY_FAILED'));
  });
}
