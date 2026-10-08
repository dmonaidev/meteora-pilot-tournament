# Алгоритмы обработки данных криптотурнира

Актуальные изменения алгоритмов: [Telegram-код 0.5](../decisions/telegram-code-v0.5.md), [управляемая сессия 0.7](../decisions/session-v0.7.md), [серверное окно регистрации, неизменяемые наступившие даты и агрегирование показателей 0.8](../decisions/schedule-stats-v0.8.md). Они имеют приоритет над исходной моделью ниже.

Версия 0.2.1. Все операции выполняются сервером приложения. Бот и фронтенд не обращаются к таблицам напрямую. Входные поля сначала валидируются; в транзакцию попадают только нормализованные данные.

## ALG-01 Создание pending session

Вход: REGISTRATION + display_name либо AUTHORIZATION без имени.

1. Для регистрации выполнить trim, проверить длину 3–20 и отсутствие управляющих символов. Для входа display_name=null.
2. Получить случайный token: префикс reg_ или auth_ плюс 32 криптографически случайных байта в Base64url без padding. При конфликте PK сгенерировать заново.
3. Создать pending_sessions с tg_id=null, is_used=false, created_at=UTC now.
4. Построить https://t.me/{BOT_USERNAME}?start={token}.
5. Вернуть token, bot_link и expires_at=created_at+15 минут. expires_at вычисляется, новое поле БД не требуется.

Start-параметр Telegram ограничен 64 символами; такой token укладывается в ограничение. [Telegram Deep Linking](https://core.telegram.org/bots/features#deep-linking).

## ALG-02 Подтверждение ботом

Вход: token, tg_id, tg_username из Telegram update; защищённый запрос бота.

1. Проверить серверный BOT_API_SECRET. Не принимать это действие от обычного JWT участника.
2. Проверить форму token, числовой tg_id и нормализовать username.
3. Начать транзакцию, получить pending_sessions по token с блокировкой FOR UPDATE.
4. Не найден → SESSION_NOT_FOUND. Истёк по серверному времени → SESSION_EXPIRED.
5. Если is_used=true: при том же tg_id вернуть текущий результат без нового users; при другом → SESSION_ALREADY_BOUND.
6. Для AUTHORIZATION найти users по tg_id; отсутствует → USER_NOT_REGISTERED, pending session не менять.
7. Для REGISTRATION найти users. Если нет, проверить initial_users по tg_id, определить статус и выполнить INSERT ... ON CONFLICT (tg_id) DO NOTHING.
8. Повторно получить users с блокировкой. Если другой запрос уже создал профиль, использовать его; не переписать display_name и registration_status.
9. Обновить tg_username только актуальными данными Telegram. Его отсутствие записать как null.
10. Установить pending_sessions.tg_id=tg_id и is_used=true.
11. Commit; только затем вернуть success и registration_status.

В одну транзакцию входят создание/поиск users и подтверждение pending_session. Ошибка не оставляет is_used=true без профиля. Бот сообщает об успехе только после ответа сервера.

## ALG-03 Polling и JWT

Вход: token.

1. Найти pending session, проверить TTL. Неизвестный token → 404, истёкший → 410.
2. is_used=false → 200 с is_used=false.
3. is_used=true → найти users по сохранённому tg_id; отсутствие профиля — серверная ошибка, не повторная регистрация.
4. Подписать JWT с users.id в sub и сроком exp по AUTH_JWT_TTL_SECONDS. Ключ и длительность задаются конфигурацией сервера.
5. Вернуть is_used=true, access_token, token_type=Bearer и registration_status. Записи users/wallets/rewards/scoring не менять.

Token pending session является секретом данного входа. Передавать его по HTTPS, не включать в публичные данные и сообщения об ошибках. Дополнительные cookie и таблицы авторизованных сессий не вводятся.

Сайт не запускает параллельные polling-запросы. После успешного ответа сохраняет JWT для текущего сеанса, останавливает polling и читает profile. Истечение JWT требует повторного входа через Telegram; refresh-механизм не добавляется.

## ALG-04 Модерация регистрации

Вход: tg_id, action, admin_notes; подтверждённое право администратора.

1. Проверить APPROVE/REJECT, непустой admin_notes после trim.
2. В транзакции найти users по tg_id с FOR UPDATE.
3. APPROVE → APPROVED_MANUAL; REJECT → REJECTED.
4. Записать registration_status и admin_notes, commit.
5. Вернуть обновлённый статус.

Повтор той же команды даёт то же состояние. Если приходят разные ручные команды, действует последняя успешно выполненная. Новый импорт initial_users не отменяет ручное решение.

## ALG-05 Запись и ручная проверка wallet

Вход участника: wallet_address и withdrawal_tx_hash. Signature отсутствует.

1. Определить user_id из JWT.
2. Trim адрес, сохранить регистр, проверить max 44 и Base58-декодирование в 32 байта. Хэш: trim, непустой string до 255 символов без управляющих символов.
3. В транзакции заблокировать users владельца, затем прочитать wallet.
4. После блокировки получить текущее UTC-время. Если wallet существует, адрес меняется и now >= TOURNAMENT_START_AT, вернуть WALLET_CHANGE_LOCKED без записи.
5. Нет wallet → INSERT с обоими значениями, UNDER_REVIEW и reason=null.
6. Адрес и хэш не изменились в VALID/UNDER_REVIEW → вернуть прежнюю запись.
7. Та же пара в INVALID → UNDER_REVIEW, reason=null.
8. Изменился адрес до старта → обновить адрес и поданный хэш, UNDER_REVIEW, reason=null; готовый scoring не менять и не пересчитывать.
9. Изменился только хэш → UNDER_REVIEW, reason=null; score сохранить.
10. Commit, вернуть wallet.

Приложение не доказывает владение и не запрашивает подпись/блокчейн. Проверка принадлежности хэша адресу выполняется администратором. Старый хэш не переносится автоматически: при смене адреса пользователь явно подаёт хэш для новой пары.

Проверка администратором:

1. Принять user_id, проверенные wallet_address и withdrawal_tx_hash, action.
2. Заблокировать users, прочитать wallet и сравнить обе строки с проверенными.
3. Несовпадение любого значения → WALLET_CHANGED без записи.
4. VALID → reason=null; INVALID → непустой rejection_reason.
5. Изменить только validation_status/rejection_reason и commit.

Порядок блокировок одинаков: users → wallet. Проверка не изменяет адрес. TOURNAMENT_START_AT обязателен: ISO 8601 с Z в UTC. При отсутствии или неверном формате конфигурации запуск приложения завершается ошибкой; параметр не трактуется как «турнир ещё не начался».

## ALG-06 Запись reward и вычисление reward_tag

Вход: user_id из JWT, reward_type, exchange_uid.

1. Проверить RewardType.
2. RESPECT: exchange_uid должен отсутствовать либо быть null. Любое переданное значение, кроме null, включая пустую строку, — VALIDATION_ERROR (422). Записать null и NOT_REQUIRED.
3. PARTNER_GIFTS: trim UID, проверить 1–50 символов, сохранить строкой. Не преобразовывать в число.
4. Заблокировать users, прочитать partner_rewards.
5. Нет записи либо поменялся тип/UID → upsert с новым типом/UID и UNDER_REVIEW для PARTNER_GIFTS.
6. Полностью идентичная подача PARTNER_GIFTS сохраняет uid_status.
7. Commit.

Ручная проверка UID блокирует users, читает partner_rewards и сравнивает текущий exchange_uid с проверенным. При изменении вернуть UID_CHANGED; при RESPECT — UID_NOT_REQUIRED. Затем сохранить VALID/INVALID.

Вычисление reward_tag:

    if reward существует
       and reward.reward_type == PARTNER_GIFTS
       and reward.uid_status == VALID:
        reward_tag = "Special Partner Gift"
    else:
        reward_tag = "RespectGift"

Вычисление выполняет сервер. Фронтенд отображает готовую строку.

## ALG-07 Импорт initial_users

Вход: rows после разбора CSV в админке, поля по словарю.

1. Проверить все строки: tg_id, group_name, длины, nullable поля.
2. Привести username и пустые справочные поля к канонической форме.
3. Повтор tg_id внутри запроса — ошибка всего запроса.
4. Начать транзакцию; сериализовать импорты initial_users блокировкой LOCK TABLE initial_users IN SHARE ROW EXCLUSIVE MODE. После получения блокировки прочитать существующие ключи и определить inserted/updated для этого набора.
5. В этой же транзакции upsert initial_users по tg_id.
6. Не удалять записи, не попавшие в загрузку. Не изменять users.
7. Вернуть inserted и updated.

Если ошибка любой строки выявлена при записи, rollback всего запроса. Повтор одной загрузки не создаёт новые ключи, но может снова считаться updated.

## ALG-08 Загрузка tournament_scoring

Вход: rows с готовыми данными администратора.

1. Проверить право администратора.
2. Проверить все строки до записи: tg_id, обязательный pnl, отсутствие дублей ID.
3. Для каждого tg_id найти users.id. Неизвестный ID отклоняет весь набор.
4. pnl — signed decimal до 14 цифр в целой части и 6 в дробной, в пределах NUMERIC(20,6). Отрицательный и нулевой результат допустимы; null или отсутствие — ошибка. Экспоненциальная запись не принимается, лишние знаки не округляются молча.
5. Необязательные initial_capital/current_capital/in_positions_amount: неотрицательные decimal того же формата либо null. Отсутствующее поле привести к null.
6. Необязательный roi_percentage: finite JSON number либо null. Отсутствующее поле привести к null.
7. В одной транзакции upsert tournament_scoring по user_id. Блокировать users обрабатываемых участников в стабильном порядке users.id, как операции кошелька, чтобы смена адреса и загрузка не оставляли половину операции.
8. После получения блокировок определить inserted/updated по существующим строкам tournament_scoring. Записать готовый pnl и все справочные поля, включая null. Не вычислять ни одну метрику.
9. Commit, вернуть inserted/updated. Пользователей вне набора не менять.

Допуск проверяется при чтении, а не при загрузке. Current capital не увеличивается на positions; ROI не выводится из capital; PNL не выводится из ROI или capital.

## ALG-09 Формирование leaderboard

В одном согласованном SQL-чтении:

1. users JOIN wallets ON wallets.user_id=users.id.
2. Фильтр registration_status IN (APPROVED_AUTO, APPROVED_MANUAL) AND wallets.validation_status=VALID.
3. LEFT JOIN tournament_scoring и LEFT JOIN partner_rewards.
4. reward_tag вычислить CASE по ALG-06.
5. Отсутствующее scoring передать как null в pnl и каждой справочной метрике. Не использовать COALESCE(..., 0).
6. Сортировать по числовому pnl DESC NULLS LAST, users.id ASC. ROI не участвует в сортировке.
7. Сформировать публичные поля из api.md.

SQL View может реализовать пункты 1–5. ORDER BY задаётся запросом, читающим View; сам View не гарантирует порядок выдачи. Никакие таблицы не обновляются при чтении leaderboard.

## ALG-10 Чтение профиля и административные права

Профиль: проверить подпись и exp JWT; получить users по sub и wallet/rewards/scoring одним согласованным SQL-чтением. Административный список также читает связанные данные согласованно. Если wallet отсутствует или не VALID, вернуть scoring=null. Корневой wallet_address_locked = wallet существует AND now >= TOURNAMENT_START_AT. Вернуть withdrawal_tx_hash только в приватном wallet. Не раскрывать чужие записи и admin_notes.

Право администратора: роль admin определяет доверенный серверный контекст. Для минимальной реализации можно настроить ADMIN_TG_IDS на сервере и сверять tg_id авторизованного users с этим списком. Это не новая таблица или продуктовая роль. Нельзя брать admin=true из тела запроса либо group_name CSV.

## ALG-11 Закрытое исключение администратора

Это внутренний порядок для отдельного решения администратора, не обычный сценарий участника. Публичного endpoint/кнопки для обхода блокировки не создавать и возможность переноса участнику не обещать.

1. Администратор отдельно подтверждает исключение для конкретного users.id, старого адреса и нового адреса с хэшем вывода на него.
2. В закрытой административной операции с доверенным доступом к БД заблокировать users, проверить, что прежний wallet_address/withdrawal_tx_hash ещё актуальны.
3. Обновить существующую wallets: новый wallet_address и withdrawal_tx_hash, UNDER_REVIEW, rejection_reason=null. users.id, tg_id и wallets.id сохраняются.
4. tournament_scoring и partner_rewards этого user_id не переносить на другого пользователя и не менять; весь прежний PNL и справочные значения остаются.
5. Commit; затем администратор по обычной ручной проверке ALG-05 выставляет VALID либо INVALID для новой пары.

До VALID пользователь временно исключён из leaderboard. После VALID возвращается с тем же сохранённым прогрессом. Обычный POST user/wallet остаётся заблокирован для смены адреса после старта и не умеет выбирать этот режим. Операция сверяет старый адрес, чтобы не применить исключение к уже заменённому кошельку.
