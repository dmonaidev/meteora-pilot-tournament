export function createTelegramTransport(config = {}) {
  if (config.notifyTransport) return config.notifyTransport;
  const token = config.botToken || process.env.BOT_TOKEN;
  return async ({ chat_id, text, reply_markup }) => {
    if (!token) return { ok: false, error_code: 'TOKEN_MISSING' };
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, ...(reply_markup === undefined ? {} : { reply_markup }) }), signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (response.ok && result.ok === true) {
        const id = result.result?.message_id;
        return { ok: true, ...(Number.isSafeInteger(id) && id > 0 ? { message_id: id } : {}) };
      }
      return { ok: false, error_code: Number.isInteger(result.error_code) ? result.error_code : response.status };
    } catch { return { ok: false, error_code: 'DELIVERY_FAILED' }; }
  };
}
export function createTelegramEditor(config = {}) {
  if (config.editTransport) return config.editTransport;
  const token = config.botToken || process.env.BOT_TOKEN;
  return async ({ chat_id, message_id }) => {
    if (!token) return { ok: false, error_code: 'TOKEN_MISSING' };
    if (!Number.isSafeInteger(Number(chat_id)) || Number(chat_id) <= 0 || !Number.isSafeInteger(message_id) || message_id <= 0) {
      return { ok: false, error_code: 'INVALID_MESSAGE' };
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: Number(chat_id), message_id, reply_markup: { inline_keyboard: [] } }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (response.ok && result.ok === true) return { ok: true };
      if ((response.status === 400 || result.error_code === 400) && typeof result.description === 'string' && /message is not modified/i.test(result.description)) {
        return { ok: true };
      }
      return { ok: false, error_code: Number.isInteger(result.error_code) ? result.error_code : response.status };
    } catch { return { ok: false, error_code: 'DELIVERY_FAILED' }; }
  };
}
