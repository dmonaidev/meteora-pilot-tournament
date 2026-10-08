import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { BotError, replyBody, processUpdates } from './polling.mjs';
import { requestCodeText } from './code.mjs';
import { accessStatusText } from './access-status.mjs';
import { handleSessionCallback } from './session.mjs';

const { BOT_TOKEN, BOT_API_SECRET, BOT_USERNAME } = process.env;
const backend = new URL(process.env.BACKEND_URL || 'http://127.0.0.1:3000');
const website = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:3000');
if (!BOT_TOKEN || !BOT_API_SECRET) throw new Error('Set BOT_TOKEN and BOT_API_SECRET before starting the bot.');
if (!['http:', 'https:'].includes(backend.protocol) || !['http:', 'https:'].includes(website.protocol)) {
  throw new Error('BACKEND_URL and PUBLIC_BASE_URL must be HTTP(S) URLs.');
}
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());
async function telegram(method, body = {}, timeout = 15_000) {
  let response, result;
  try {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeout)]),
  });
    result = await response.json();
  } catch { throw new BotError('NETWORK', undefined, method); }
  if (!response.ok || !result.ok) throw new BotError(result.error_code || response.status, result.parameters?.retry_after, method);
  return result.result;
}
async function reply(chatId, text) {
  await telegram('sendMessage', replyBody(chatId, text, website));
}
const errors = {
  SESSION_EXPIRED: 'Ссылка истекла. Вернитесь на сайт и начните вход заново.',
  SESSION_NOT_FOUND: 'Ссылка не найдена. Создайте новую ссылку на сайте.',
  SESSION_ALREADY_BOUND: 'Эта ссылка уже подтверждена другим аккаунтом. Начните вход заново на сайте.',
  USER_NOT_REGISTERED: 'Ваш аккаунт ещё не зарегистрирован. Сначала пройдите регистрацию на сайте.',
  REGISTRATION_NOT_OPEN: 'Регистрация ещё не открыта или уже закрыта. Расписание доступно на сайте. Если вы уже зарегистрированы, отправьте /start без параметров и войдите по коду.',
  RULES_CHANGED: 'Правила изменились или принятая версия недоступна. Вернитесь на сайт и подтвердите согласие с действующей версией правил.',
  RULES_UNAVAILABLE: 'Правила ещё не опубликованы. Новая регистрация временно недоступна; существующие участники могут войти по коду через /start.',
  TELEGRAM_ACCOUNT_MISMATCH: 'Ссылка предназначена для другого Telegram-аккаунта. Откройте её в указанном аккаунте или создайте новую регистрацию на сайте.',
};
async function handle(update) {
  if (update.callback_query) {
    await handleSessionCallback(update.callback_query, { backend, secret: BOT_API_SECRET, telegram,
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]) });
    return;
  }
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat?.type !== 'private' || typeof message.text !== 'string') return;
  const command = /^\/(start|code|id)(?:@([A-Za-z0-9_]+))?(?:\s+(.+))?\s*$/.exec(message.text);
  if (!command || (command[2] && BOT_USERNAME && command[2].toLowerCase() !== BOT_USERNAME.replace(/^@/, '').toLowerCase())) return;
  if (command[1] === 'id') {
    await reply(message.chat.id, `Ваш Telegram ID: ${message.from.id}\nПередайте его владельцу для настройки доступа администратора. Команда сама не выдаёт права.`);
    return;
  }
  const token = command[3]?.trim();
  if (!token || command[1] === 'code') {
    const text = await requestCodeText({ backend, secret: BOT_API_SECRET, from: message.from,
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]) });
    if (!shutdown.signal.aborted) await reply(message.chat.id, text);
    return;
  }
  if (!/^(?:reg_|auth_)[A-Za-z0-9_-]{43}$/.test(token)) {
    await reply(message.chat.id, 'Некорректная ссылка. Создайте новую ссылку входа на сайте.'); return;
  }
  let text;
  try {
    const response = await fetch(new URL('/api/v1/bot/verify', backend), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': BOT_API_SECRET },
      body: JSON.stringify({ token, tg_id: message.from.id, tg_username: message.from.username?.trim() || null }),
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]),
    });
    const result = await response.json();
    if (response.ok && result.status === 'success') text = `Telegram подтверждён. ${accessStatusText(result.registration_status)}\nВернитесь на сайт — вход завершится автоматически.`;
    else text = errors[result.error?.code] || 'Подтверждение временно недоступно. Повторите переход по ссылке через минуту.';
  } catch {
    if (shutdown.signal.aborted) return;
    text = 'Сайт временно недоступен. Повторите переход по ссылке через минуту.';
  }
  await reply(message.chat.id, text);
}
async function run() {
  const webhook = await telegram('getWebhookInfo');
  if (webhook.url) throw new Error('A Telegram webhook is configured. Stop its owner and explicitly remove the webhook before enabling polling.');
  const identity = await telegram('getMe');
  if (BOT_USERNAME && identity.username?.toLowerCase() !== BOT_USERNAME.replace(/^@/, '').toLowerCase()) {
    throw new Error('Telegram BOT_USERNAME does not match BOT_TOKEN. Update the configured username.');
  }
  console.info('Telegram bot started (long polling).');
  let offset = 0;
  let failures = 0;
  while (!shutdown.signal.aborted) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 40, allowed_updates: ['message', 'callback_query'] }, 55_000);
      await processUpdates(updates, handle, next => { offset = next; }, details => console.warn('Bot reply skipped:', details));
      failures = 0;
    } catch (error) {
      if (shutdown.signal.aborted) break;
      if (error instanceof BotError && [401, 409].includes(error.code)) {
        throw new Error(error.code === 401 ? 'Telegram rejected BOT_TOKEN. Check its configuration.' : 'Telegram polling conflict: stop the other bot process or resolve the configured webhook.');
      }
      failures++;
      const seconds = Math.min(300, Math.max(error.retryAfter || 0, Math.min(60, 2 ** Math.min(failures, 6))));
      console.warn('Bot request failed:', { method: error instanceof BotError ? error.method : 'internal', code: error instanceof BotError ? error.code : 'INTERNAL', retrySeconds: seconds });
      await delay(seconds * 1000, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  }
}
run().catch((error) => {
  if (shutdown.signal.aborted) return;
  // Never print fetch errors: they can contain the Bot API URL and token.
  console.error(error.message.startsWith('Telegram ') || error.message.startsWith('A Telegram ') ? error.message : 'Bot startup failed. Check network access and configuration.');
  process.exitCode = 1;
});
