# Telegram-бот для сборки новостных видео

Self-hosted Telegram-бот принимает текст новости, делает короткий сценарий на 30 или 60 секунд, принимает видео и изображения, позволяет вручную менять их порядок и собирает вертикальный MP4 с локальной озвучкой и субтитрами.

## Что уже входит в MVP

- проекты и продолжение незаконченной работы после перезапуска;
- два стиля сценария: новостная сводка и популярная подача;
- локальная переработка текста через Ollama;
- версии автоматически сгенерированного и ручного сценария;
- приём видео, изображений и медиа-документов из Telegram;
- проверка файла через `ffprobe`, метаданные, поиск дублей и предупреждение о горизонтальном кадре;
- просмотр футажей, перестановка, замена и удаление;
- три локальных голоса Piper;
- выбор шрифта, цвета и размера субтитров;
- очередь BullMQ, прогресс рендера, отмена и отправка готового MP4 в Telegram;
- PostgreSQL, Redis, Ollama, FFmpeg и все сервисы в Docker Compose.

Подробный продуктовый и технический план: [docs/TELEGRAM_BOT_PLAN.md](docs/TELEGRAM_BOT_PLAN.md).

## Что нужно получить перед запуском

1. Создать бота через `@BotFather` и получить token.
2. Узнать числовой Telegram ID редактора, например через `@userinfobot`.
3. Знать новый пароль PostgreSQL.
4. Для первого теста использовать короткие исходники до лимита официального Telegram Bot API. Для больших файлов вторым шагом разворачивается локальный Bot API.

Секреты не добавляются в Git.

## Запуск на сервере

Создайте `.env` рядом с `docker-compose.server.yml` по образцу `.env.example`:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-me
ALLOWED_TELEGRAM_IDS=123456789
ALLOWED_TELEGRAM_USERNAMES=aslandevx
TELEGRAM_API_ROOT=https://api.telegram.org
POSTGRES_DB=video_factory
POSTGRES_USER=video_factory
POSTGRES_PASSWORD=replace-with-a-long-random-password
REDIS_URL=redis://redis:6379
OLLAMA_MODEL=qwen3.5:4b
API_PORT=8080
```

Запуск:

```powershell
docker compose -f docker-compose.server.yml up -d --build
```

Первый запуск дольше обычного: Docker скачивает Ollama-модель и три модели голоса. Логи бота:

```powershell
docker compose -f docker-compose.server.yml logs -f bot worker
```

Проверка контейнеров:

```powershell
docker compose -f docker-compose.server.yml ps
Invoke-RestMethod http://localhost:8080/health
```

После запуска откройте бота и отправьте `/start`.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Секретный token от BotFather |
| `ALLOWED_TELEGRAM_IDS` | Разрешённые Telegram ID через запятую |
| `TELEGRAM_API_ROOT` | Официальный или локальный Bot API endpoint |
| `OLLAMA_MODEL` | Локальная модель для редакторской ужимки текста |
| `POSTGRES_*` | База проектов и состояний диалога |
| `REDIS_URL` | Очередь рендера |

Если `ALLOWED_TELEGRAM_IDS` пуст, бот доступен всем — это допустимо только для локальной разработки.

## Архитектура

- `bot` — Telegram-интерфейс, FSM, проекты, текст, медиа и настройки;
- `worker` — Piper, субтитры и FFmpeg;
- `api` — health endpoint и временная совместимость со старой версией;
- `postgres` — проекты, версии сценария, медиа, настройки и jobs;
- `redis` — BullMQ;
- `ollama` — локальная языковая модель;
- `media-data` — исходники и результаты.

Старый `apps/web` пока оставлен только для безопасного перехода. После серверного smoke-теста Telegram-сценария его можно удалить вместе с устаревшими API поиска стоков.

## Локальные проверки

```bash
npm install
npm run typecheck
npm test
```

Для локального запуска самого бота дополнительно нужны работающие PostgreSQL, Redis, Ollama, FFmpeg и заполненный `.env`.

## Формат результата

- 1080×1920;
- 30 fps;
- H.264/yuv420p;
- AAC;
- MP4 faststart;
- длительность определяется фактической локальной озвучкой.
