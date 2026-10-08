# База данных криптотурнира

[Дополнение1.3](../decisions/tournament-name-v1.3.md): миграция010 добавляет tournament_settings.tournament_name TEXT NOT NULL DEFAULT 'PILOT TOURNAMENT'. Отдельная настройка названия не меняет расписание, ссылку, профили или число таблиц.

[Дополнение1.2](../decisions/partner-qualification-v1.2.md): миграция009 добавляет nullable TEXT `tournament_settings.partner_referral_url`, первоначально null. API маппит его на referral_url. Отдельная форма админки не меняет даты или профили, число таблиц остаётся девять. Проверка условий партнёра фиксируется прежним partner_rewards.uid_status после ручной проверки.

[Уникальность 0.9](../decisions/duplicates-v0.9.md): миграция007 добавляет уникальный wallets.wallet_address и уникальный непустой partner_rewards.exchange_uid. NULL UID допускается у нескольких участников, собственные значения повторно сохраняются. Дубликат не удаляется автоматически; отказ409 откатывает всю операцию.

Действующая схема имеет девять таблиц: к шести исходным добавлены tournament_settings, auth_sessions и tournament_rules. [Миграция 008 и правила 1.0](../decisions/rules-v1.0.md) добавляют версии правил и nullable FK/время согласия в users и pending_sessions; прежние записи остаются без выдуманного согласия. Приоритет имеют [сессии 0.7](../decisions/session-v0.7.md) и [расписание/показатели 0.8](../decisions/schedule-stats-v0.8.md). Миграция 006 добавляет registration_start_at/registration_end_at/end_at в tournament_settings и nullable NUMERIC(20,6) lp_volume >= 0 в tournament_scoring. Существующие даты и результаты сохраняются; новые поля изначально null.

Версия 0.2.1. PostgreSQL, шесть исходных таблиц. Каждому созданному пользователю соответствуют максимум одна wallet, одна partner_rewards и одна tournament_scoring.

## Связи

    initial_users.tg_id -- поиск при регистрации --> users.tg_id UNIQUE
    pending_sessions.tg_id -- подтверждение --> users.tg_id
    users.id --> wallets.user_id UNIQUE
    users.id --> partner_rewards.user_id PRIMARY KEY
    users.id --> tournament_scoring.user_id PRIMARY KEY

initial_users — справочник допуска, а не обязательный FK профиля: неизвестный Telegram ID тоже создаёт users с PENDING_VALIDATION. users не удаляется, если строки списка нет. Username не участвует в отношениях.

## initial_users

| Поле | Тип | Ограничение |
| --- | --- | --- |
| tg_id | BIGINT | PRIMARY KEY, положительный Telegram ID |
| tg_username | VARCHAR(255) | NULL допустим, без @ |
| group_name | VARCHAR(100) | NOT NULL, непустой |
| subgroup_1 | VARCHAR(255) | NULL допустим; CSV CommunityEcosystem |
| subgroup_2 | VARCHAR(255) | NULL допустим; CSV MeteoraPlus |
| subgroup_3 | VARCHAR(255) | NULL допустим; CSV MeteoraPro |
| system_notes | TEXT | NULL допустим |

Импорт обновляет только эту таблицу по tg_id. Удаление отсутствующих в очередном файле участников не предусмотрено.

## users

| Поле | Тип | Ограничение |
| --- | --- | --- |
| id | UUID | PRIMARY KEY, серверная генерация |
| tg_id | BIGINT | UNIQUE NOT NULL |
| tg_username | VARCHAR(255) | NULL допустим |
| display_name | VARCHAR(100) | NOT NULL; внешний контракт 3–20 символов |
| registration_status | RegistrationStatus enum | NOT NULL |
| admin_notes | TEXT | NULL допустим; обязателен для ручного решения |

Enum: APPROVED_AUTO, APPROVED_MANUAL, PENDING_VALIDATION, REJECTED. Новый профиль получает только APPROVED_AUTO либо PENDING_VALIDATION. Ручные статусы задаёт admin/moderate.

UNIQUE tg_id — защита от повторной и параллельной регистрации. display_name и tg_username не уникальны.

## wallets

| Поле | Тип | Ограничение |
| --- | --- | --- |
| id | UUID | PRIMARY KEY |
| user_id | UUID | FK users.id, UNIQUE NOT NULL |
| wallet_address | VARCHAR(44) | NOT NULL; формат проверяет приложение |
| withdrawal_tx_hash | VARCHAR(255) | NOT NULL; непустой текст после trim |
| validation_status | WalletStatus enum | NOT NULL DEFAULT UNDER_REVIEW |
| rejection_reason | TEXT | NULL допустим; непустой для INVALID |

Enum: UNDER_REVIEW, VALID, INVALID. Глобальная уникальность wallet_address или withdrawal_tx_hash не добавляется. До старта разрешённая смена адреса обновляет ту же строку; после старта обычная смена запрещена. Хэш относится к текущему адресу; при разрешённой смене адреса явно подаётся хэш вывода на новый адрес, прежний не переносится автоматически.

Обычная смена адреса до старта, смена хэша и закрытое исключение администратора сохраняют scoring по прежнему user_id. Сайт не удаляет и не пересчитывает загруженные результаты при изменении wallet; при необходимости администратор корректирует их следующей загрузкой.

Смысловые ограничения: INVALID требует reason; VALID/UNDER_REVIEW очищают reason. Новый адрес или новый хэш устанавливает UNDER_REVIEW. Ручная проверка сверяет и проверенный адрес, и проверенный withdrawal_tx_hash с текущими.

wallet_address_locked в БД не хранится: вычисляется по наличию wallet и TOURNAMENT_START_AT. Signature отсутствует в схеме и рабочем API.

## partner_rewards

| Поле | Тип | Ограничение |
| --- | --- | --- |
| user_id | UUID | PRIMARY KEY, FK users.id |
| reward_type | RewardType enum | NOT NULL |
| exchange_uid | VARCHAR(50) | NULL допустим; обязателен для PARTNER_GIFTS |
| uid_status | UidStatus enum | NOT NULL DEFAULT UNDER_REVIEW |

RewardType: RESPECT, PARTNER_GIFTS. UidStatus: NOT_REQUIRED, UNDER_REVIEW, VALID, INVALID.

Согласованность: RESPECT → exchange_uid IS NULL AND uid_status=NOT_REQUIRED. PARTNER_GIFTS → непустой exchange_uid AND uid_status в UNDER_REVIEW/VALID/INVALID. Приложение явно пишет NOT_REQUIRED для RESPECT, не полагается на общий DEFAULT.

reward_tag здесь не хранится. Новая причина отказа UID не добавляется.

## tournament_scoring

| Поле | Тип | Ограничение |
| --- | --- | --- |
| user_id | UUID | PRIMARY KEY, FK users.id |
| pnl | NUMERIC(20,6) | NOT NULL, готовый результат администратора; отрицательные значения допустимы |
| initial_capital | NUMERIC(20,6) | NULL допустим, DEFAULT NULL |
| current_capital | NUMERIC(20,6) | NULL допустим, DEFAULT NULL |
| in_positions_amount | NUMERIC(20,6) | NULL допустим, DEFAULT NULL |
| roi_percentage | FLOAT | NULL допустим, DEFAULT NULL; только справочная загрузка администратора |

Строка создаётся только после загрузки pnl. Не создавать нулевой scoring при регистрации. Нулевой PNL допустим и отличается от отсутствия записи.

Вставка/обновление всегда получает готовый pnl. Необязательные справочные значения при отсутствии в строке загрузки устанавливаются null. Не рассчитывать pnl из current_capital/initial_capital или roi_percentage, не рассчитывать ROI и не прибавлять позиции к капиталу.

Для чтения сортировать по числовому pnl, не по строковому представлению JSON. Изменение кошелька не меняет user_id. При закрытом исключении администратора сохраняется прежняя строка scoring без копирования между пользователями.

Изменения исходной схемы по RFC-05: добавлен pnl, у справочных полей DEFAULT 0 заменён на NULL. Если уже существуют старые данные, нельзя автоматически выдавать разность капиталов за PNL: администратор должен загрузить готовый результат до включения NOT NULL. Для старых wallets без хэша получить реальное значение, не создавать фиктивное перед ограничением NOT NULL.

## pending_sessions

| Поле | Тип | Ограничение |
| --- | --- | --- |
| token | VARCHAR(64) | PRIMARY KEY |
| session_type | SessionType enum | NOT NULL |
| display_name | VARCHAR(100) | Для REGISTRATION обязательно; для AUTHORIZATION NULL |
| tg_id | BIGINT | NULL до подтверждения |
| is_used | BOOLEAN | NOT NULL DEFAULT false |
| created_at | TIMESTAMP | NOT NULL DEFAULT NOW(), UTC |

SessionType: REGISTRATION, AUTHORIZATION. Истечение вычисляется как created_at+15 минут. is_used=true требует tg_id и существующий users. FK на initial_users не ставится.

Новый token при повторном входе создаёт новую pending_session. Старые записи не участвуют в текущем допуске пользователя.

## Ограничения и транзакции

- Числовые Telegram ID положительны и соответствуют диапазону API.
- FK wallets/rewards/scoring не допускают записи без users. Каскадное удаление не требуется: сценарий удаления пользователей не задан.
- Регистрация и подтверждение pending_session выполняются в одной транзакции.
- Изменения wallet и reward блокируют users владельца, чтобы сериализовать конкурирующие изменения.
- Импорт списка и импорт scoring — каждый целиком в своей транзакции.
- Строки scoring привязываются по users.id, не по display_name или username; это сохраняет прогресс при разрешённом закрытом исключении.
- TOURNAMENT_START_AT — серверная настройка UTC. Отдельная таблица турниров не добавляется.
- При now >= TOURNAMENT_START_AT изменение существующего адреса пользовательским API запрещено вне зависимости от статуса wallet или наличия scoring.
- Дополнительные таблицы авторизации, администраторов, аудита и version-поля не создаются.
- Существующих ключевых индексов PK/UNIQUE достаточно для начальной реализации; новые индексы добавляются по фактическому запросу и нагрузке.

## Представление leaderboard

View включает users JOIN wallets с фильтром допуска и LEFT JOIN rewards/scoring. Его поля соответствуют публичному ответу API. Строки без scoring не отбрасываются. reward_tag вычисляется CASE.

SELECT из View сортируется по pnl DESC NULLS LAST, users.id ASC. ROI не участвует в порядке. Изменение registration_status или validation_status сразу влияет на следующий SELECT, отдельная синхронизация копии leaderboard не нужна.
