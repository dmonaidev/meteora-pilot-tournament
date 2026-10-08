# Административный просмотр данных — дополнение 0.4

Принято оркестратором 8 октября 2026 года по поручению владельца: администратор должен видеть все данные приложения. Дополнение к current-contract-v0.3.md. Одна PostgreSQL, семь таблиц; новых таблиц не требуется. Разработка и проверка остаются локальными.

## Экран

Пункт «Управление» переименован в «Админка». Внутри разделы: «Участники», «Реестр допуска», «Кошельки», «UID и награды», «Результаты», «Сессии входа», «Настройки турнира». Участники сохраняют существующие действия модерации. Реестр допуска и результаты сохраняют загрузку CSV/JSON. Настройки используют существующий TournamentSettings. Остальные разделы показывают текущие записи и поиск, с постраничной навигацией. ID и значения полей отображаются текстом; длинные адреса и хэши не расширяют страницу.

## API только для администратора

GET /api/v1/admin/data/summary → объект с целочисленными счётчиками initial_users, users, wallets, partner_rewards, tournament_scoring, pending_sessions. Счётчики включают все записи соответствующих таблиц.

GET /api/v1/admin/data/:resource, resource строго один из initial-users, wallets, rewards, scoring, sessions. Параметры: page (integer >=1, default 1), limit (integer 1–100, default 50), search (trim string до 100, default пустая). Неизвестный resource → 404 NOT_FOUND; неверные параметры → 422 VALIDATION_ERROR. Проверка JWT и ADMIN_TG_IDS выполняется до чтения любых данных. Без авторизации 401, участник 403.

Ответ: {rows: array, total: integer>=0, page: integer, limit: integer}. total учитывает search. Каждый запрос читает строки и count в одном согласованном снимке. Поиск — буквальная подстрока без учёта регистра; пользовательские %, _ и обратный слэш не являются SQL-шаблоном. SQL-значения параметризованы, имена таблиц не принимаются от клиента.

| resource | Поля одной строки | Поиск | Порядок |
| --- | --- | --- | --- |
| initial-users | tg_id:number, tg_username:string/null, group_name:string, subgroup_1/2/3:string/null, system_notes:string/null | tg_id, username, группа, подгруппы, заметки | tg_id ASC |
| wallets | id:UUID, user_id:UUID, tg_id:number, display_name:string, tg_username:string/null, wallet_address:string, withdrawal_tx_hash:string/null, validation_status:enum, rejection_reason:string/null | tg_id, имя, username, адрес, хэш | tg_id ASC |
| rewards | user_id:UUID, tg_id:number, display_name:string, tg_username:string/null, reward_type:enum, exchange_uid:string/null, uid_status:enum | tg_id, имя, username, UID | tg_id ASC |
| scoring | user_id:UUID, tg_id:number, display_name:string, tg_username:string/null, pnl:decimal string, initial_capital/current_capital/in_positions_amount:decimal string/null, roi_percentage:number/null | tg_id, имя, username | числовой pnl DESC, user_id ASC |
| sessions | session_type:enum, display_name:string/null, expected_tg_username:string/null, tg_id:number/null, is_used:boolean, created_at:ISO UTC, expires_at:ISO UTC, expired:boolean | tg_id, имя, ожидаемый username | created_at DESC, token ASC как внутренний критерий равенства |

sessions не возвращает token, bot_link, access_token или секреты. expires_at = created_at + 15 минут, expired вычисляется по серверному времени. Таблица users читается существующим GET /admin/users, настройки — существующим GET /admin/tournament/settings. Эти два API не меняются.

Новые GET не изменяют БД и не отправляют уведомлений. Модерация и импорт продолжают использовать согласованные POST 0.3. Сессии представлены для диагностики незавершённого входа, а не для выдачи доступа от имени другого пользователя.

## Приёмка

- Реальный администратор видит семь разделов; участник не получает ни один приватный набор.
- Реестр содержит импортированные данные; поиск и переход страницы действительно читают сервер.
- NUMERIC сохраняется decimal string; UID с ведущими нулями остаётся string; nullable хэш отображается «—».
- Токен отсутствует даже в JSON сессий; публичный лидерборд не изменён.
- Неверные resource, page/limit/search не вызывают SQL-инъекцию или чтение произвольной таблицы.
- Сборка и проверка в браузере проходят на большом и мобильном экране.
