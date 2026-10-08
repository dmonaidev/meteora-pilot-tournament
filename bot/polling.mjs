export class BotError extends Error {
  constructor(code, retryAfter, method) {
    super('Telegram request failed'); this.code = code; this.retryAfter = retryAfter; this.method = method;
  }
}
export function replyBody(chatId, text, website) {
  const host = website.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host === '::1' || host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.') ||
    host.startsWith('192.168.') || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
  if (local) return { chat_id: chatId, text: `${text}\n\nВернитесь в исходную вкладку сайта на компьютере.` };
  return { chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: 'Вернуться на сайт', url: website.href }]] } };
}
export async function processUpdates(updates, handle, acknowledge, warn) {
  for (const update of updates) {
    try { await handle(update); }
    catch (error) {
      if (!(error instanceof BotError) || error.method !== 'sendMessage' || ![400, 403, 404].includes(error.code)) throw error;
      warn({ method: error.method, code: error.code });
    }
    acknowledge(update.update_id + 1);
  }
}
