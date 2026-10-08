# API криптотурнира

## Дополнение1.3 — название турнира

`GET /api/v1/public/tournament/name` возвращает `{tournament_name: string}`. Администратор читает и сохраняет этот объект через GET/POST `/api/v1/admin/tournament/name`. Схема POST строгая: trim,1–80символов, запрет пустого текста и C0/C1; нарушения422, права401/403. Запись меняет только название. Подробности — [контракт1.3](../decisions/tournament-name-v1.3.md).

## Дополнение 1.2 — ссылка партнёра

Полный контракт: [квалификация Special Gift](../decisions/partner-qualification-v1.2.md). Префикс всех путей — `/api/v1`.

| Метод и путь | Доступ | Запрос / ответ |
| --- | --- | --- |
| GET /public/partner | Гость | Ответ `{referral_url: string или null}` |
| GET /admin/tournament/partner | Администратор | Тот же объект |
| POST /admin/tournament/partner | Администратор | Строго `{referral_url: string или null}`, ответ — сохранённый объект |

Пустая строка после trim очищает ссылку. Непустая ссылка — абсолютная HTTPS URL до2048 символов без credentials и управляющих символов; нарушение —422 VALIDATION_ERROR. Запись меняет только настройку ссылки. Прежнее подтверждение `/admin/rewards/validate` VALID выполняется после ручной проверки условий партнёра; автоматическая проверка биржи не создаётся.

## Приоритетное дополнение 1.0: правила и согласие

Полный актуальный контракт: [правила, согласие и архив](../decisions/rules-v1.0.md). `POST /auth/register` требует `rules_accepted: true` и `rules_version_id` текущей ACTIVE редакции. В новом users сохраняются nullable `accepted_rules_version_id` и `rules_accepted_at`; эти ключи обязательны в ответах profile/admin/users. Старые аккаунты остаются с null, существующий вход не требует повторного согласия.

- `GET /public/rules` и `GET /public/rules/:id`: текущая редакция и опубликованный архив; черновики недоступны.
- `GET /admin/rules`: все неудалённые версии. `POST /admin/rules`: новый черновик.
- `POST /admin/rules/:id/save`, `/publish`, `/delete`: редактирование черновика, атомарная публикация с архивированием, явное удаление неактивного текста.
- Ошибки: `RULES_UNAVAILABLE`, `RULES_CHANGED`, `RULES_NOT_FOUND`, `RULES_VERSION_LOCKED`, `RULES_ACTIVE_DELETE_FORBIDDEN`; формат и HTTP-коды — в контракте 1.0.

Историческое тело регистрации ниже используется с двумя обязательными полями согласия. Приложенный исходный черновик не опубликован автоматически.

Действующие изменения исходного контракта зафиксированы в [0.3](../decisions/current-contract-v0.3.md), [0.4: административные данные](../decisions/admin-data-v0.4.md) и [0.5: Telegram-код](../decisions/telegram-code-v0.5.md). Для затронутых полей и путей применять эти дополнения; описание 0.2.1 ниже является базовым историческим контрактом.

Версия 0.2.1. Базовый путь /api/v1. Все JSON-ключи используют имена из data-dictionary.md. Пути register/session/bot/profile/wallet/rewards/leaderboard и модерации исходной модели сохранены. Неописанные ранее формы ответов конкретизированы ниже.

## Общие правила

Content-Type: application/json. User- и admin-маршруты требуют Authorization: Bearer <JWT>. JWT sub содержит users.id, подпись и exp проверяет сервер. Admin-маршруты дополнительно требуют доверенную серверную роль admin.

bot/verify принимает X-Bot-Secret: <BOT_API_SECRET>, а не пользовательское право администратора. Фронтенд этот секрет не получает.

UUID передаётся строкой, tg_id числом, pnl и капитал decimal-строкой, справочный ROI number/null. Для запросов, меняющих собственные данные, user_id определяется из JWT; поле user_id в теле не принимается.

Поле с неизвестным enum или неверным типом → 422. Успешный JSON не содержит скрытых вариантов ключей. Клиент валидирует схему и не пытается угадать reward_tag по другому полю.

### Ошибка

    {
      "error": {
        "code": "VALIDATION_ERROR",
        "message": "Некорректные данные",
        "fields": [
          {"row": 2, "field": "current_capital", "message": "Неверный decimal"}
        ]
      }
    }

fields — массив, при общей ошибке []. row есть только у загрузок и считается с 1 по rows. Если источник CSV, UI прибавляет строку заголовка при отображении номера файла. Номер не означает частичное применение: ошибочный импорт не пишет никаких строк.

| HTTP | code | Когда |
| --- | --- | --- |
| 401 | UNAUTHORIZED | JWT отсутствует, неверен или истёк; неверный секрет бота |
| 403 | FORBIDDEN | Авторизованный участник обращается к admin API |
| 404 | USER_NOT_FOUND | users отсутствует |
| 404 | USER_NOT_REGISTERED | AUTHORIZATION для tg_id без users |
| 404 | SESSION_NOT_FOUND | token не найден |
| 404 | WALLET_NOT_FOUND / REWARDS_NOT_FOUND | Нет объекта для модерации |
| 409 | SESSION_ALREADY_BOUND | token уже подтверждён другим tg_id |
| 409 | WALLET_CHANGED / UID_CHANGED | Админ проверил уже изменённое значение |
| 409 | UID_NOT_REQUIRED | Попытка проверки UID при RESPECT |
| 409 | WALLET_CHANGE_LOCKED | Смена любого существующего адреса при now >= TOURNAMENT_START_AT |
| 410 | SESSION_EXPIRED | Прошло 15 минут от created_at |
| 422 | VALIDATION_ERROR | Поле/строка не проходит схему |
| 500 | INTERNAL_ERROR | Непредвиденная ошибка сервера; транзакция откатилась |

## Создание регистрации

POST /auth/register. Публичный.

    {"display_name":"CryptoKing"}

display_name обязателен, string, trim, 3–20 символов. Ответ 201:

    {
      "token":"reg_example",
      "bot_link":"https://t.me/TournamentBot?start=reg_example",
      "expires_at":"2026-10-08T12:15:00Z"
    }

Token и имя бота здесь пример, фактически их генерирует сервер по ALG-01. expires_at вычисляется из created_at.

## Создание входа

POST /auth/login. Публичный. Тело {}. Ответ 201 аналогичен register, но token имеет auth_ prefix и session_type=AUTHORIZATION.

## Проверка сессии

GET /auth/session/{token}. Требует секретный token данного входа.

Ожидание, 200:

    {"is_used":false}

Подтверждение, 200:

    {
      "is_used":true,
      "access_token":"<JWT>",
      "token_type":"Bearer",
      "registration_status":"APPROVED_AUTO"
    }

registration_status может иметь любой из четырёх статусов существующего users. Polling не требует APPROVED. JWT не выдаётся для неподтверждённой или истёкшей session.

## Подтверждение ботом

POST /bot/verify. Только X-Bot-Secret.

    {
      "token":"reg_example",
      "tg_id":70000002,
      "tg_username":"PrivateAccount_003"
    }

Все три ключа обязательны, tg_username допускает null. Ответ 200:

    {"status":"success","registration_status":"APPROVED_AUTO"}

При повторе того же token/tg_id ответ не создаёт второй users. При auth_ используется тот же маршрут и форма ответа.

## Профиль пользователя

GET /user/profile. User JWT. Ответ 200:

    {
      "id":"11111111-1111-4111-8111-111111111111",
      "tg_id":70000002,
      "tg_username":null,
      "display_name":"CryptoKing",
      "registration_status":"PENDING_VALIDATION",
      "wallet_address_locked":false,
      "wallet":null,
      "rewards":null,
      "scoring":null
    }

Форма вложенных объектов:

    {
      "wallet":{
        "id":"22222222-2222-4222-8222-222222222222",
        "wallet_address":"11111111111111111111111111111111",
        "withdrawal_tx_hash":"example_withdrawal_tx_hash",
        "validation_status":"VALID",
        "rejection_reason":null
      },
      "rewards":{
        "reward_type":"PARTNER_GIFTS",
        "exchange_uid":"00887711",
        "uid_status":"UNDER_REVIEW"
      },
      "scoring":{
        "pnl":"100.000000",
        "initial_capital":"1000.000000",
        "current_capital":"1100.000000",
        "in_positions_amount":"300.000000",
        "roi_percentage":10.0
      }
    }

Адрес и хэш примера иллюстрируют форму JSON. Scoring object возвращается только при VALID wallet и существующей строке. В scoring pnl обязателен при наличии записи, остальные четыре ключа всегда присутствуют со значением или null. Значения загружены администратором, сайт не выводит их из примера формулой. admin_notes в собственном профиле не передаётся.

wallet_address_locked всегда присутствует в корне: wallet существует AND now >= TOURNAMENT_START_AT. Без wallet — false. Этот признак управляет полем адреса в UI; сервер отдельно проверяет запрет при записи.

## Запись кошелька

POST /user/wallet. User JWT.

    {
      "wallet_address":"11111111111111111111111111111111",
      "withdrawal_tx_hash":"example_withdrawal_tx_hash"
    }

Оба поля обязательны. wallet_address проходит формат ALG-05; withdrawal_tx_hash — непустой string после trim, max 255, без управляющих символов. Hash является пользовательским сведением для ручной проверки, не доказательством, которое система автоматически подтверждает.

Signature отсутствует в запросе и не требуется. Адрес и хэш сохраняются атомарно в wallets. Новый адрес до старта или новый хэш → UNDER_REVIEW; идентичная пара в VALID/UNDER_REVIEW сохраняет статус. Идентичная пара после INVALID отправляется на новую проверку.

Ответ 200: объект wallet той же формы, что profile.wallet, включая withdrawal_tx_hash. При now >= TOURNAMENT_START_AT попытка изменить существующий адрес → 409 WALLET_CHANGE_LOCKED, никаких записей. Правило действует и для INVALID/UNDER_REVIEW, и без scoring. Первая подача без wallet и повтор того же адреса не являются сменой и разрешены этим ограничением.

В пользовательском запросе нет поля для обхода блокировки. Закрытое исключение администратора не является режимом этого endpoint.

## Выбор награды

POST /user/rewards. User JWT.

    {"reward_type":"RESPECT","exchange_uid":null}

или:

    {"reward_type":"PARTNER_GIFTS","exchange_uid":"00887711"}

reward_type обязателен; RESPECT допускает отсутствующий или null exchange_uid (любое другое значение, включая пустую строку, → 422); PARTNER_GIFTS требует строку 1–50 после trim. Ответ 200: объект rewards той же формы, что profile.rewards. При RESPECT uid_status=NOT_REQUIRED.

## Лидерборд

GET /public/leaderboard. Публичный. Ответ 200 — массив:

    [
      {
        "user_id":"11111111-1111-4111-8111-111111111111",
        "display_name":"CryptoKing",
        "pnl":"100.000000",
        "initial_capital":"1000.000000",
        "current_capital":"1100.000000",
        "in_positions_amount":"300.000000",
        "roi_percentage":10.0,
        "reward_tag":"RespectGift"
      }
    ]

Нет scoring у допущенного участника → pnl и четыре справочные метрики null. Нет допущенных участников → []. Порядок: pnl DESC NULLS LAST, затем user_id ASC для равных значений. Сортировать числовой PNL, не decimal-строку; ROI не влияет на порядок. withdrawal_tx_hash и exchange_uid не публикуются.

## Административный список

GET /admin/users. Admin JWT. Ответ 200 — массив пользователей с корневыми полями profile, дополнительным admin_notes и вложенными wallet/rewards/scoring.

В админке scoring не скрывается из-за статуса wallet. Это позволяет увидеть загруженные значения до допуска. Нет дочерней записи → null. Список используется для существующих действий модерации; отдельные сложные фильтры не требуются.

## Модерация регистрации

POST /admin/users/moderate. Admin JWT.

    {
      "tg_id":70000002,
      "action":"APPROVE",
      "admin_notes":"Пользователь проверен"
    }

action APPROVE/REJECT; непустой admin_notes обязателен. Ответ 200:

    {
      "tg_id":70000002,
      "registration_status":"APPROVED_MANUAL",
      "admin_notes":"Пользователь проверен"
    }

REJECT возвращает REJECTED. Не менять wallet/rewards/scoring.

## Валидация кошелька

POST /admin/wallets/validate. Admin JWT.

    {
      "user_id":"11111111-1111-4111-8111-111111111111",
      "wallet_address":"11111111111111111111111111111111",
      "withdrawal_tx_hash":"example_withdrawal_tx_hash",
      "action":"INVALID",
      "rejection_reason":"Адрес не соответствует данным участника"
    }

user_id, проверенные wallet_address и withdrawal_tx_hash и action VALID/INVALID обязательны. Для INVALID rejection_reason — непустая строка; для VALID rejection_reason отсутствует или null. Ответ 200: обновлённый wallet. Адрес и хэш сравниваются с текущей записью, не изменяют её. Несовпадение любого из них → 409 WALLET_CHANGED. Ручная модерация доступна после старта и не обходит блокировку смены адреса.

## Валидация UID

POST /admin/rewards/validate. Admin JWT.

    {
      "user_id":"11111111-1111-4111-8111-111111111111",
      "exchange_uid":"00887711",
      "action":"VALID"
    }

Все поля обязательны; action VALID/INVALID. Ответ 200: обновлённый rewards. Проверенный UID сравнивается с текущим. Для RESPECT эта операция не применяется.

## Импорт исходного списка

POST /admin/initial-users/import. Admin JWT.

    {
      "rows":[
        {
          "tg_id":70000002,
          "tg_username":"@PrivateAccount_003",
          "group_name":"ученик",
          "CommunityEcosystem":null,
          "MeteoraPlus":null,
          "MeteoraPro":null,
          "system_notes":null
        }
      ]
    }

rows — непустой массив; tg_id и group_name обязательны. Остальные поля nullable и могут отсутствовать. Админка разбирает исходный CSV и передаёт эти имена. Проверка принадлежит серверу, не только CSV-парсеру.

Ответ 200:

    {"inserted":1,"updated":0}

При ошибке любой строки — 422, без частичной записи. updated — число строк набора, существовавших после получения блокировки импорта и до его записи; inserted — число новых строк. Счётчики определяются в транзакции ALG-07. Повтор одинаковых данных не создаёт дубликаты.

## Загрузка скоринга

POST /admin/scoring/import. Admin JWT. Минимальная загрузка:

    {
      "rows":[
        {
          "tg_id":70000002,
          "pnl":"100.000000"
        }
      ]
    }

Вариант со справочными значениями:

    {
      "rows":[
        {
          "tg_id":70000002,
          "pnl":"100.000000",
          "initial_capital":"1000.000000",
          "current_capital":"1100.000000",
          "in_positions_amount":"300.000000",
          "roi_percentage":10.0
        }
      ]
    }

rows — непустой массив. В строке обязательны tg_id и pnl. pnl — signed decimal string, до 14 цифр в целой части и 6 в дробной; отрицательные значения и 0 допустимы, null запрещён. Необязательные capital-поля — неотрицательные decimal string или null того же размера. ROI — необязательный finite JSON number или null. Экспоненциальная запись decimal не принимается, лишние дробные знаки не округляются молча.

Каждая загружаемая строка полностью замещает scoring данного пользователя: отсутствующее справочное поле становится null. Это позволяет загрузить PNL без ROI и убрать ранее указанный справочный ROI. Приложение не рассчитывает PNL/ROI и не заменяет их разностью капитала или процентной формулой.

По tg_id находит users.id; upsert по user_id. Неизвестный ID, дубликат внутри rows, неверная метрика или отсутствие pnl → 422 и rollback всего запроса. Загрузка не меняет допуск и строки других пользователей.

Ответ 200:

    {"inserted":1,"updated":0}

PNL нормализуется при выдаче до 6 дробных знаков. Все значения PNL администратор загружает в единой единице сравнения. Структура таблицы и null определены в database.md.
# Уточнение API и сессий 0.6

[Автоматическая доставка Telegram-кода и сохранение входа](../decisions/access-v0.6.md): добавлен `POST /api/v1/auth/code/request`; формы существующих ответов сохраняются.

# Последнее уточнение API 0.7

[Сессия 30 минут, серверное продление через Telegram и cooldown 90 секунд](../decisions/session-v0.7.md) имеет приоритет над сроком 24 часа и лимитом 60 секунд из 0.6. Новые маршруты и ответы описаны в этом контракте.

# Дополнение API 0.8

Новейшее [уточнение 0.9](../decisions/duplicates-v0.9.md) добавляет POST /api/v1/user/profile-check и ошибки409 дубликатов wallet_address/exchange_uid. Формы успешного сохранения профиля остаются прежними.

[Расписание и публичные показатели](../decisions/schedule-stats-v0.8.md): четыре даты настроек, серверное окно регистрации, GET /api/v1/public/stats, отдельный lp_volume в результатах. Для lp_volume старый импорт без поля сохраняет прежнее значение, явный null очищает; правила замещения остальных полей остаются прежними.

