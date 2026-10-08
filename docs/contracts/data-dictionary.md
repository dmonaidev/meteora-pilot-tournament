# Переменные и маппинг данных криптотурнира

Дополнение1.3: tournament_name — plain text1–80символов, форма администратора → одноимённое поле tournament_settings → public/tournament/name → бренд и заголовок лидерборда. Начальное значение PILOT TOURNAMENT. Идентификаторы/роли/ссылки/время не зависят от названия; [полный контракт](../decisions/tournament-name-v1.3.md).

## Дополнение 1.2 — ссылка и квалификация

| Поле | Источник → получатель | Тип / смысл |
| --- | --- | --- |
| referral_url | Отдельная форма админки → partner_referral_url → публичный API → баннер, ЛК, дорожная карта | HTTPS string до2048 без credentials/control или null; blank очищается |
| partner_referral_url | tournament_settings | Nullable TEXT, единственный источник всех реферальных ссылок |
| uid_status | Ручная проверка администратора → сохранённый профиль | VALID подтверждает UID и условия партнёра; UNDER_REVIEW не доказывает выполнение биржевых шагов |

Краткая номинация заявки определяется сохранённым reward_type/exchange_uid. Итоговый reward_tag лидерборда сохраняет прежние правила; подробности — [контракт1.2](../decisions/partner-qualification-v1.2.md).

## Дополнение 1.0 — правила

| Поле | Источник → получатель | Тип / смысл |
| --- | --- | --- |
| rules_accepted | Незаполненный checkbox регистрации → /auth/register | Только true; отсутствие либо false — 422 |
| rules_version_id | Текущая показанная ACTIVE версия → pending_sessions | UUID, FK tournament_rules.id |
| rules_accepted_at | Серверное время принятия → pending_sessions → новый users | UTC TIMESTAMPTZ; в API ISO/null |
| accepted_rules_version_id | pending_sessions.rules_version_id → новый users → profile/admin/users | UUID/null; старые аккаунты без backfill |
| version / status | БД/админка → публичное окно правил | Последовательный номер; DRAFT, ACTIVE, ARCHIVED; гость не видит DRAFT |
| body / deleted_at | Редактор и явное удаление → tournament_rules | Plain text, после удаления body=null и время удаления; metadata/FK сохраняются |

Детали публикации, архива и согласия: [контракт 1.0](../decisions/rules-v1.0.md).

[Дополнение 0.9](../decisions/duplicates-v0.9.md): wallet_address и ненулевой exchange_uid уникальны среди всех сохранённых участников. POST /user/profile-check передаёт те же ключи, возвращает для каждого null либо `{available:boolean}` без данных владельца; поля сравниваются после trim, регистр и ведущие нули сохраняются.

Актуальные дополнения: [доступ и ЛК 1.0](../product/access-and-cabinet.md), [расписание и показатели 0.8](../decisions/schedule-stats-v0.8.md), [сессии 0.7](../decisions/session-v0.7.md). Они заменяют исторические константы ниже. Даты хранятся в tournament_settings, не в TOURNAMENT_START_AT окружения.

| Новое поле | Источник → получатель | Тип / смысл |
| --- | --- | --- |
| registration_start_at / registration_end_at | Админка → tournament_settings → публичное расписание | nullable UTC TIMESTAMPTZ, начало включительно, конец исключительно |
| start_at / end_at | Админка → tournament_settings → публичное расписание | nullable UTC TIMESTAMPTZ, start_at постоянно блокирует смену существующего кошелька |
| registration_open / registration_status | Сервер → публичное расписание | Boolean / UPCOMING, OPEN, CLOSED; состояние по серверному времени |
| lp_volume | Административный импорт → tournament_scoring → ЛК, админка, публичная сумма | nullable неотрицательная decimal-строка, накопленный оборот открытий LP в SOL |
| participant_count | users + VALID wallets → public/stats | Число допущенных участников |
| initial_capital / current_capital / pnl / lp_volume | SQL SUM по допущенным → public/stats | decimal-строка или null, не смешивать с одноимёнными индивидуальными значениями |
| scored_participant_count / capital_participant_count / lp_participant_count | Сервер → public/stats | Число участников с заполненным соответствующим показателем |

Версия 0.2.1. Используются ключи исходной модели. Переменная не переименовывается между сайтом, ботом и сервером.

## Константы

| Имя | Значение | Применение |
| --- | --- | --- |
| DISPLAY_NAME_MIN_LENGTH | 3 | После trim |
| DISPLAY_NAME_MAX_LENGTH | 20 | После trim; предел Agent.md |
| PENDING_SESSION_TTL_SECONDS | 900 | 15 минут после created_at |
| AUTH_POLL_INTERVAL_MS | 3000 | Следующий опрос после завершения предыдущего |
| WALLET_ADDRESS_MAX_LENGTH | 44 | Максимальная длина хранения, не ровно 44 |
| EXCHANGE_UID_MAX_LENGTH | 50 | UID хранится строкой |
| TG_USERNAME_MAX_LENGTH | 255 | username без @ |
| WITHDRAWAL_TX_HASH_MAX_LENGTH | 255 | Текстовый хэш вывода, trim, непустой |
| TOURNAMENT_START_AT | Обязательное значение UTC | Начало запрета смены существующего адреса; серверная настройка |
| REGISTRATION_TOKEN_PREFIX | reg_ | session_type=REGISTRATION |
| AUTHORIZATION_TOKEN_PREFIX | auth_ | session_type=AUTHORIZATION |

## Общие типы

| Значение | БД | JSON | Правило |
| --- | --- | --- | --- |
| Внутренний ID | UUID | string | Генерируется сервером |
| tg_id | BIGINT | integer | Положительный Telegram User.id, без дроби; не chat_id |
| Капитал | NUMERIC(20,6) nullable | decimal string или null | Справочные суммы администратора; отсутствие не равно нулю |
| pnl | NUMERIC(20,6) NOT NULL для загруженного scoring | decimal string или null при отсутствии scoring | Готовый абсолютный результат; отрицательные значения допустимы |
| roi_percentage | FLOAT nullable | number или null | Необязательный справочный процент администратора; сайт не рассчитывает |
| Время | TIMESTAMP по исходной схеме | ISO 8601 string с Z | В приложении использовать UTC |
| Необязательный текст | nullable VARCHAR/TEXT | string или null | Нормализация описана для каждого поля |

Telegram User.id имеет не более 52 значащих битов, поэтому JSON integer сохраняется без перехода на строку. [Telegram Bot API](https://core.telegram.org/bots/api#user).

## Маппинг основных полей

| Ключ | Источник | Запись | Получатель | Проверка и правило |
| --- | --- | --- | --- | --- |
| display_name | Форма регистрации | pending_sessions.display_name → users.display_name | profile, leaderboard | Trim, 3–20 символов; вывод как текст |
| token | Сервер | pending_sessions.token | bot_link, bot/verify, auth/session | Случайный reg_ или auth_ token, max 64 |
| session_type | Сервер | pending_sessions.session_type | Алгоритм bot/verify | REGISTRATION / AUTHORIZATION |
| tg_id | Telegram message.from.id | pending_sessions.tg_id, users.tg_id | Поиск initial_users; профиль; админка | Положительное целое; уникально в users |
| tg_username | Telegram message.from.username | users.tg_username | profile, админка | Trim; удалить начальный @; пусто → null |
| registration_status | Сервер или администратор | users.registration_status | ЛК, bot/verify, фильтр leaderboard | Только RegistrationStatus |
| admin_notes | Администратор | users.admin_notes | Админка | Обязательный непустой комментарий при ручном изменении |
| wallet_address | Поле ЛК | wallets.wallet_address | profile.wallet, админка | Trim; не менять регистр; Base58, декодирование в 32 байта |
| withdrawal_tx_hash | Участник при заполнении регистрации/ЛК | wallets.withdrawal_tx_hash | wallet POST, profile.wallet, админка | Trim, непустой string max 255; вывод с биржи на wallet_address, проверяет админ |
| wallet_address_locked | Сервер | Не хранится, вычисляется | Корневое поле profile и admin/users | Boolean: wallet существует AND now >= TOURNAMENT_START_AT |
| validation_status | Сервер или администратор | wallets.validation_status | ЛК и фильтр leaderboard | Только WalletStatus |
| rejection_reason | Администратор | wallets.rejection_reason | ЛК и админка | Обязательно для INVALID, null для VALID/UNDER_REVIEW |
| reward_type | Выбор ЛК | partner_rewards.reward_type | profile.rewards; расчёт reward_tag | RESPECT / PARTNER_GIFTS |
| exchange_uid | Поле ЛК | partner_rewards.exchange_uid | Приватный ЛК и админка | UID аккаунта на бирже, не внутренний UUID; string max 50, ведущие нули сохраняются |
| uid_status | Сервер или администратор | partner_rewards.uid_status | ЛК; расчёт reward_tag | Только UidStatus |
| reward_tag | Сервер | Не хранится отдельно | leaderboard | Special Partner Gift либо RespectGift |
| initial_capital | Загрузка администратора | tournament_scoring.initial_capital | ЛК и leaderboard | Необязательный неотрицательный decimal или null |
| current_capital | Загрузка администратора | tournament_scoring.current_capital | ЛК и leaderboard | Необязательный неотрицательный decimal или null; сайт не собирает |
| in_positions_amount | Загрузка администратора | tournament_scoring.in_positions_amount | ЛК и leaderboard | Необязательный неотрицательный decimal или null; не добавлять повторно к current_capital |
| pnl | Администратор | tournament_scoring.pnl | ЛК и leaderboard | Обязательный при загрузке готовый signed decimal; главный результат |
| roi_percentage | Администратор по желанию | tournament_scoring.roi_percentage | ЛК и leaderboard | Необязательно, finite number или null, не влияет на порядок |
| is_used | Сервер после bot/verify | pending_sessions.is_used | auth/session | false → ожидание; true → Telegram подтверждён |
| created_at | Сервер | pending_sessions.created_at | Проверка TTL | При now >= created_at + 15 минут сессия истекла |
| id | Сервер | users.id / wallets.id | В соответствующем объекте | ID пользователя и ID кошелька различаются |
| user_id | Сервер из users | FK в wallets/rewards/scoring | Внутренняя связь и админка | Участник не передаёт чужой user_id в свои запросы |


Адрес Solana представлен Base58-строкой, декодируемой в 32 байта. Проверка формата не является ручным одобрением и не устанавливает VALID. [Solana Account Structure](https://solana.com/docs/core/accounts/account-structure).

## Маппинг исходного списка

| Входная колонка | initial_users | Правило |
| --- | --- | --- |
| tg_id | tg_id | Обязательная, ключ upsert |
| tg_username | tg_username | Без @; пусто → null |
| group_name | group_name | Обязательная, max 100 |
| CommunityEcosystem | subgroup_1 | Nullable, max 255 |
| MeteoraPlus | subgroup_2 | Nullable, max 255 |
| MeteoraPro | subgroup_3 | Nullable, max 255 |
| system_notes | system_notes | Nullable |

group_name и subgroup_1–3 — данные списка, не права администратора. Поиск при регистрации выполняется только по tg_id. Username не используется как FK.

## Маппинг загрузки скоринга

Сервер получает rows. В каждой строке обязательны tg_id и pnl. По tg_id находит users.id и записывает tournament_scoring.user_id. Остальные финансовые значения необязательны и справочны; приложение не выводит одно из другого.

| Вход | Запись | Применение |
| --- | --- | --- |
| tg_id | Поиск users.tg_id → tournament_scoring.user_id | Сопоставление пользователя, обязательный |
| pnl | tournament_scoring.pnl | Готовый результат, обязательный signed decimal |
| initial_capital | initial_capital | Необязательный decimal или null |
| current_capital | current_capital | Необязательный decimal или null |
| in_positions_amount | in_positions_amount | Необязательный decimal или null |
| roi_percentage | roi_percentage | Необязательный готовый процент или null |

Полная строка замещает прежние данные данного пользователя: отсутствующее справочное поле становится null. Отсутствующий pnl или pnl=null — ошибка; нулевой pnl — действительный результат. Неизвестный tg_id, повтор ID внутри загрузки, неверный decimal или ROI отклоняют весь запрос до записи. Строки других пользователей сохраняются.

Капитал — неотрицательный; PNL может быть положительным, нулевым или отрицательным. Decimal допускает до 14 цифр в целой части и до 6 в дробной. ROI может быть отрицательным finite number. Все PNL подготавливаются администратором в одной единице сравнения; сайт не выполняет конвертацию.

Сортировка: pnl DESC NULLS LAST, users.id ASC. Справочный ROI не влияет даже при равенстве PNL.

## Enum и зависимости

RegistrationStatus: APPROVED_AUTO, APPROVED_MANUAL, PENDING_VALIDATION, REJECTED.
WalletStatus: UNDER_REVIEW, VALID, INVALID.
RewardType: RESPECT, PARTNER_GIFTS.
UidStatus: NOT_REQUIRED, UNDER_REVIEW, VALID, INVALID.
SessionType: REGISTRATION, AUTHORIZATION.

- leaderboard_eligible: registration_status в APPROVED_AUTO/APPROVED_MANUAL и wallet.validation_status=VALID.
- reward_tag: PARTNER_GIFTS + VALID UID → Special Partner Gift; иначе RespectGift, в том числе при отсутствии partner_rewards.
- scoring_visible: wallet.validation_status=VALID. RegistrationStatus при этом не изменяется.
- Нет wallet/rewards/scoring → соответствующий ключ профиля null.
- Нет scoring в leaderboard → pnl и четыре справочные метрики null.
- wallet_address_locked=true → существующий адрес неизменяем пользователем; первая подача без wallet не является сменой.
- Хэш вывода хранится в wallet и не очищается при смене категории награды/UID.
- Смена хэша для того же адреса отправляет wallet на повторную проверку, включая после старта.
- RESPECT → exchange_uid=null и uid_status=NOT_REQUIRED.
- PARTNER_GIFTS → непустой exchange_uid; новый или изменённый UID получает UNDER_REVIEW.

## Приватные поля

Публичный leaderboard не передаёт tg_id, tg_username, exchange_uid, withdrawal_tx_hash, admin_notes, system_notes и token. В ЛК пользователь видит только собственный профиль. Сервер берёт user_id из JWT, а не из тела пользовательского запроса.
