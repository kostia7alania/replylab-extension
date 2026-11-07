# Возможности и границы проверки

[Главная](../README.md) · [Результаты проверок](validation.md) · Сборка **0.4.0** · 07.11.2026

**Код реализован ≠ проверен на живом аккаунте.** Браузерные fixtures используют синтетические данные. Серверные функции реализованы заново, историческая база и закрытые серверные исходники не восстановлены.

| Возможность | Реализация | Проверка / граница |
|---|---|---|
| Панель у поля сообщения, SPA | `content.js`, `page-adapter.js` | Chrome fixture: mount, navigation, modal/ambiguous composer |
| Текущий диалог, bio, профиль, фото | `site-bridge.js`, `site-context.js` | Rich/own profiles сохраняют interests, descriptors, prompts и Spotify; только загруженная часть |
| Вставка, copy, защита черновика | `page-adapter.js`, `content.js` | Native input/contenteditable, stale confirmation, ноль отправок |
| AI streaming, cancel, JSON/tools | `generation.js`, `providers.mjs` | Mock contracts и отдельный реальный Ollama smoke; неполный поток отклоняется |
| Styles CRUD, duplicate, preview, model/temp/tokens | `library.js`, `workspace.js` | Integrity tests и browser CRUD |
| Условия opener/incoming/stale/empty, 1–3 ответа | `site-context.js`, `content.js` | Fixtures и полный streaming-сценарий на 2 ответа |
| Общие стили | `/catalog` и `/templates` своего сервера | Постоянный CRUD, версии шаблонов, явный refresh/import; чужого публичного каталога нет |
| Фото, память, заметки, поиск прошлых ответов | `prepareTask` + provider attachments | Фото только opt-in; scoped local pairs и модельный searchPastReplies с видимыми результатами |
| AI-помощник, сохранённые сессии | `workspace.js`, `library.js` | Structured cards, просмотр стиля, edit/regenerate в новых ветках; лимиты 20 чатов × 40 сообщений |
| Системный prompt, память, вложения, стиль из диалога | Studio + provider | Раздельные base/chat/profile prompts, preview/default reset, text/image contracts и реальная локальная модель |
| Bio copy/translate/language hint/Instagram | Панель | Эвристика подписана; перевод требует AI; URL allowlist |
| Transcript, export, внешние помощники | Панель | Copy + явное открытие сайта, текст в URL не передаётся |
| Заметки с автосохранением | Studio / панель | Flush до JSON-экспорта, включая экспорт отдельного чата |
| Share с TTL, revoke | Свой сервер | Настоящие HTTP 200 → 404; localhost-ссылка локальна |
| Повторный профиль | Локальный счётчик других сохранённых диалогов | Только ваша библиотека, не глобальная база людей |
| Размытие фото | Панель / settings | Локальный CSS, включается отдельно |
| Дата из ID профиля | `objectIdTimestamp` | Ограниченный inference; не подтверждённая регистрация |
| Capture, import/export, sync | Общая валидируемая библиотека и сервер | Continuous update только явно сохранённого известного аккаунта; bulk loaded import, receipts, merge и identity-conflict guards |
| Swipe analytics | Общий `aggregate90days` | 90 календарных дней, timezone/DST, hours/days/streak/trend, known/unknown age/city |
| WhatsApp companion | Optional MAIN + isolated scripts | Chrome fixture: active chat, insert, две unverified local labels с раздельными архивами; auto/continuous off |
| Провайдеры, модели, OpenRouter usage | Сервер + Studio | Mock contracts. Usage относится к текущему ключу; ChatGPT numeric usage API не выдумывается |
| ChatGPT / OpenRouter OAuth | `oauth.mjs` | PKCE/state/nonce/JWKS/issued client ID, refresh race, private persistence; live login отдельно |
| Настройки по функциям | Studio | Providers/models, count, visibility, UI/reply languages отдельно, AI Enter shortcut, diagnostics |
| Schedule/reschedule/cancel/variation | Библиотека + страница + server claim | Serial queue, countdown/waiting, exact claim, observed outgoing acknowledgement; нет автоматического повтора uncertain send |
| Геопозиция | Opt-in wrapper + events | Валидация координат, возврат native API, журнал до 100 обращений на вкладку без записи координат; не история перемещений |
| Языки и onboarding | Studio/панель, 11 языков | Проверки переводов; интерактивный старт с явным добавлением синтетического диалога |
| Локальные состояния доступа | `core.js` | Код `REPLYLAB-LOCAL`, active/trial/expired/signed-out; без внешних прав |

Автоматическая отправка по умолчанию выключена. Для Tinder требуется определённый self account ID, тот же chat/snapshot, точная версия записи и видимая страница. Для WhatsApp она блокируется до подтверждённого источника self account ID. Подсказки, ручная вставка и очередь на проверку доступны.

Не восстанавливались сторонняя телеметрия и чужая система учётных прав. Самостоятельная сборка не означает разрешения платформы на интеграцию. [Источники ограничений](research.ru.md).

## Воспроизводимые проверки

| Команда | Что доказывает |
|---|---|
| `npm test` | Контракты библиотеки/worker/provider/OAuth/server, merge, доступ, timestamps, расписание, переводы |
| `node tests/browser.mjs` с указанными в инструкции путями | Реальный worker + loopback server, MAIN bridge, streaming mock, два хода AI, sync/search/share/revoke/export, WhatsApp insert, guards очереди |

Отдельный браузерный прогон проверяет существующий draft и неподдерживаемые поля. Синтетические screenshots лежат в `docs/images/`. Реальная доступность сайта, аккаунтов, model IDs, новых DOM-селекторов и post-login endpoint остаётся отдельной runtime-проверкой.
