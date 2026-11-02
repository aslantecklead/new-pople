# Развёртывание Telegram-бота на Windows-сервере

Эта инструкция поднимает весь MVP на одном Windows-сервере через Docker Desktop. После запуска бот работает по long polling: пользоваться им можно с телефона через обычный Telegram, открывать порты в интернет и держать компьютер редактора включённым не нужно.

## 1. Что потребуется

- Windows 10/11 или Windows Server с включённой виртуализацией;
- Docker Desktop в режиме Linux containers;
- Git;
- минимум 25 ГБ свободного места на диске;
- Telegram-токен от `@BotFather`;
- числовой Telegram ID владельца (можно узнать через `@userinfobot`).

Репозиторий: <https://github.com/aslantecklead/new-pople>

## 2. Установка и клонирование

Откройте PowerShell от обычного пользователя, под которым работает Docker Desktop:

```powershell
git clone https://github.com/aslantecklead/new-pople.git C:\Users\aleck\news-video-factory
Set-Location C:\Users\aleck\news-video-factory
Copy-Item .env.example .env
notepad .env
```

Если каталог уже существует:

```powershell
Set-Location C:\Users\aleck\news-video-factory
git pull --ff-only
```

## 3. Настройка `.env`

Заполните файл `.env` рядом с `docker-compose.server.yml`:

```dotenv
TELEGRAM_BOT_TOKEN=PASTE_BOTFATHER_TOKEN_HERE
ALLOWED_TELEGRAM_IDS=123456789
ALLOWED_TELEGRAM_USERNAMES=aslandevx
TELEGRAM_API_ROOT=https://api.telegram.org

API_PORT=8080
POSTGRES_DB=video_factory
POSTGRES_USER=video_factory
POSTGRES_PASSWORD=PASTE_A_LONG_RANDOM_PASSWORD_HERE
REDIS_URL=redis://redis:6379
OLLAMA_MODEL=qwen3.5:4b
```

Важное:

- токен и пароль не отправляйте в Git;
- лучше указывать `ALLOWED_TELEGRAM_IDS`: числовой ID не меняется вместе с username;
- `ALLOWED_TELEGRAM_USERNAMES` можно оставить как запасной способ входа;
- если оба списка доступа пустые, бот будет доступен любому пользователю;
- при смене пароля уже созданной PostgreSQL-базы значение в volume автоматически не изменится. Для действующего сервера оставляйте текущий пароль.

## 4. Первый запуск

Убедитесь, что Docker Desktop полностью запущен, затем выполните:

```powershell
Set-Location C:\Users\aleck\news-video-factory
docker compose -f docker-compose.server.yml up -d --build
```

Первый запуск может занять 10–30 минут: будут загружены контейнеры, локальная Ollama-модель и три русских голоса Piper. Закрывать PowerShell после завершения команды можно — контейнеры продолжат работать в фоне и автоматически поднимутся после перезапуска Docker.

Проверьте состояние:

```powershell
docker compose -f docker-compose.server.yml ps
Invoke-RestMethod http://127.0.0.1:8080/health
docker compose -f docker-compose.server.yml logs --tail 100 bot worker ollama-pull
```

Ожидаемый результат:

- `postgres`, `redis`, `ollama`, `api`, `bot` и `worker` запущены;
- `ollama-pull` завершён с кодом `0` — это одноразовый загрузчик модели;
- `/health` возвращает JSON с `"ok": true`;
- в логах `bot` нет повторяющихся ошибок авторизации Telegram.

Теперь откройте созданного бота с телефона и отправьте `/start`.

## 5. Как пользоваться ботом

1. Нажмите «Новый проект».
2. Отправьте исходный текст новости.
3. Выберите 30 или 60 секунд, стиль и вариант переработки текста.
4. При необходимости перегенерируйте или отредактируйте итоговый текст.
5. Отправляйте видео и изображения по одному или группой.
6. Откройте «Материалы»: там доступны порядок, описание кадра, обрезка начала/конца, кадрирование, замена и удаление.
7. В «Настройках» выберите голос, шрифт, цвет и размер субтитров.
8. Нажмите «Сгенерировать видео» и дождитесь MP4 в чате.

Кнопки просмотра текущего текста, материалов, настроек и проектов постоянно доступны в нижнем меню. По умолчанию используется приятный женский голос, светло-голубые анимированные субтитры и логотип «Новых людей».

## 6. Обновление с GitHub

```powershell
Set-Location C:\Users\aleck\news-video-factory
git pull --ff-only
docker compose -f docker-compose.server.yml up -d --build
docker compose -f docker-compose.server.yml ps
Invoke-RestMethod http://127.0.0.1:8080/health
```

Обычное обновление не удаляет проекты, медиа, базу и Ollama-модель: они хранятся в именованных Docker volumes.

## 7. Полезные команды

Логи в реальном времени:

```powershell
docker compose -f docker-compose.server.yml logs -f bot worker
```

Перезапуск только бота и рендера:

```powershell
docker compose -f docker-compose.server.yml restart bot worker
```

Остановка и повторный запуск без удаления данных:

```powershell
docker compose -f docker-compose.server.yml down
docker compose -f docker-compose.server.yml up -d
```

Не используйте `docker compose down -v`: ключ `-v` удалит базу проектов, исходники и локальную модель.

## 8. Резервная копия

Создайте каталог для бэкапов и выгрузите PostgreSQL:

```powershell
Set-Location C:\Users\aleck\news-video-factory
New-Item -ItemType Directory -Force .\backups | Out-Null
docker compose -f docker-compose.server.yml exec -T postgres `
  pg_dump -U video_factory -d video_factory `
  | Set-Content -Encoding utf8 .\backups\video_factory.sql
```

Для полного бэкапа медиа дополнительно экспортируйте volume `media-data` либо копируйте каталог из временного контейнера. Имя volume сначала можно увидеть командой:

```powershell
docker volume ls
```

## 9. Если закончилось место

Проверьте свободное место:

```powershell
Get-Volume -DriveLetter C
docker system df
```

Безопасно удалить только кэш незавершённых сборок:

```powershell
docker builder prune -af
```

После полного заполнения диска Docker Desktop иногда не запускает Linux engine. Освободите несколько гигабайт на диске, затем:

```powershell
wsl --shutdown
Restart-Service com.docker.service
Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
```

Не удаляйте Docker volumes, пока не сделали резервную копию.

## 10. Ограничение размера файлов Telegram

По умолчанию используется официальный Bot API. Для первого MVP отправляйте короткие исходники. Если нужны большие видеофайлы, следующим этапом разверните локальный Telegram Bot API и поменяйте `TELEGRAM_API_ROOT` в `.env`; остальная архитектура бота останется прежней.

## 11. Безопасность

- не публикуйте `.env`, токен, пароль базы и SSH-ключи;
- оставьте доступ только своему числовому Telegram ID;
- API-порт `8080` не нужен телефону и не должен быть открыт в интернет;
- при случайной публикации токена сразу перевыпустите его через `@BotFather`;
- регулярно проверяйте свободное место: рендеры и загруженные исходники остаются в `media-data`.
