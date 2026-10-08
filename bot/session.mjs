export async function handleSessionCallback(query, { backend, secret, telegram, signal, fetchImpl = fetch }) {
  if (!query || typeof query.id !== 'string' || !/^sr_[A-Za-z0-9_-]{43}$/.test(query.data || '') ||
    !Number.isSafeInteger(query.from?.id) || query.from.id <= 0 || query.from.is_bot ||
    (query.message && query.message.chat?.type !== 'private')) return false;
  let text = 'Не удалось подтвердить сессию. Попробуйте ещё раз.';
  let remove = false;
  try {
    const response = await fetchImpl(new URL('/api/v1/bot/session/confirm', backend), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': secret },
      body: JSON.stringify({ token: query.data.slice(3), tg_id: query.from.id }), signal,
    });
    const result = await response.json();
    if (response.ok && result.status === 'confirmed') {
      text = 'Сессия продлена на 30 минут'; remove = true;
    } else if (response.status === 410 && result.error?.code === 'RENEWAL_EXPIRED') {
      text = 'Время подтверждения истекло. Войдите на сайте по коду'; remove = true;
    } else if (response.status === 403) text = 'Эту сессию может подтвердить только её владелец.';
  } catch { /* Do not expose backend URLs, challenge tokens or response bodies. */ }
  try { await telegram('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: true }); } catch { /* A stale callback must not block polling. */ }
  if (remove && query.message?.chat && Number.isInteger(query.message.message_id)) {
    try {
      await telegram('editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    } catch { /* Server expiry protects the session even if Telegram cannot edit the message. */ }
  }
  return true;
}
