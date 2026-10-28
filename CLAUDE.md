# Вега — голосовой ассистент (тестовое задание «Горький код»)

Отдельный проект, не связан с eerk-* в соседних папках. Сдача до 30.10.2026.

- Стек: Node.js (ESM) + Express, SQLite (better-sqlite3 13), Luxon, zod; фронт — ванильный JS в `web/`, отдаётся тем же сервером.
- Запуск: `npm install`, `npm run dev` → http://localhost:3000. Тесты: `npm test`.
- Ключи только в `.env` (шаблон `.env.example`), `.env` не коммитим.
- LLM-цепочка в `server/nlu/adapter.js`: OpenRouter → YandexGPT → GigaChat → RuleBased. Без ключей работает RuleBased.
- Принцип: LLM возвращает только intent + слоты (дата — «временной объект»), даты считает `server/dates/resolver.js`.
- Контракт API и требования — `docs/requirements.pdf` (выгрузка доски Miro Вари).
