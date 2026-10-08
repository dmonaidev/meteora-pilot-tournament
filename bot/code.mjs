export const codeUnavailable = 'Не удалось получить код. Попробуйте отправить /start через минуту.';
export async function requestCodeText({ backend, secret, from, signal, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(new URL('/api/v1/bot/code', backend), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': secret },
      body: JSON.stringify({ tg_id: from.id, tg_username: from.username?.trim() || null }), signal,
    });
    const result = await response.json();
    if (response.status === 429 && result.error?.code === 'CODE_COOLDOWN' &&
      Number.isInteger(result.retry_after_seconds) && result.retry_after_seconds > 0 && result.retry_after_seconds <= 90) {
      return `Код уже был отправлен. Подождите ${result.retry_after_seconds} сек. перед новым /start. Ранее полученный код остаётся действующим до своего срока.`;
    }
    if (!response.ok || typeof result.code !== 'string' || !/^\d{6}$/.test(result.code) ||
      typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at)) ||
      typeof result.telegram_identifier !== 'string' || !/^(?:@[A-Za-z0-9_]{1,32}|[1-9]\d{0,15})$/.test(result.telegram_identifier)) return codeUnavailable;
    const expiry = new Date(result.expires_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return `Код для входа: ${result.code}\nВаш Telegram: ${result.telegram_identifier}\nКод одноразовый, действует 5 минут (до ${expiry} UTC).\n\nНа сайте укажите этот Telegram username или ID и введите код в поле «Код из Telegram». Если бот открыт на телефоне, введите код на компьютере.\nНе передавайте код другим людям. Новый код можно получить через /start спустя 90 секунд после выдачи предыдущего.`;
  } catch {
    // Backend errors may contain private URLs or payloads. Never log their contents.
    return codeUnavailable;
  }
}
