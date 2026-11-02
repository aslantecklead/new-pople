# Удалённая работа: сервер, панель и туннель

## Что где запускается

| Компонент | Где работает | Адрес |
| --- | --- | --- |
| API, очередь, PostgreSQL, Redis, Ollama, файлы проектов | Windows-сервер в Docker | `127.0.0.1:8080` на сервере |
| Панель редактора | Mac или рабочий компьютер | `http://127.0.0.1:5173` |
| SSH-туннель | Компьютер редактора | `127.0.0.1:18080` → сервер `127.0.0.1:8080` |

Компьютер и сервер не обязаны находиться в одной Wi-Fi-сети. Они должны быть
авторизованы в одном tailnet Tailscale и быть доступны друг другу.

## Развёртывание сервера один раз

На Windows установите Docker Desktop, Git, Tailscale и OpenSSH Server. Затем
в PowerShell:

```powershell
git clone https://github.com/aslantecklead/new-pople.git C:\Users\aleck\news-video-factory
Set-Location C:\Users\aleck\news-video-factory
Copy-Item .env.example .env
# Откройте .env и задайте уникальный POSTGRES_PASSWORD и COVERR_API_KEY.
docker compose -f docker-compose.server.yml up -d --build
docker compose -f docker-compose.server.yml exec -T ollama ollama pull qwen2.5:3b
Invoke-RestMethod http://127.0.0.1:8080/health
```

`/health` должен вернуть JSON с `"ok": true`. Проекты и медиа находятся в
именованных Docker volumes, поэтому переживают пересборку контейнеров.

Первая загрузка `qwen2.5:3b` занимает около 1,9 ГБ. Её можно запустить в фоне,
чтобы не держать SSH-окно открытым:

```powershell
Start-Process docker -ArgumentList @(
  'compose', '-f', 'docker-compose.server.yml', 'exec', '-T',
  'ollama', 'ollama', 'pull', 'qwen2.5:3b'
) -WorkingDirectory (Get-Location) `
  -RedirectStandardOutput .\ollama-pull.log `
  -RedirectStandardError .\ollama-pull.err

Get-Content .\ollama-pull.log -Wait
docker compose -f docker-compose.server.yml exec -T ollama ollama list
```

Модель готова, когда `ollama list` показывает `qwen2.5:3b`. После этого
`POST /api/keywords` использует её для выделения поисковых тем.

## Подключение нового Mac или рабочего компьютера

1. Войдите в Tailscale под тем же аккаунтом и убедитесь, что виден Windows-сервер.
2. Добавьте публичный SSH-ключ рабочего компьютера в
   `C:\ProgramData\ssh\administrators_authorized_keys` на Windows.
3. Склонируйте этот репозиторий и установите зависимости:

   ```bash
   git clone https://github.com/aslantecklead/new-pople.git
   cd new-pople
   npm install
   ```

4. Откройте постоянный туннель. Замените путь к ключу и Tailscale IP на свои:

   ```bash
   ssh -N \
     -L 127.0.0.1:18080:127.0.0.1:8080 \
     -o ExitOnForwardFailure=yes \
     -o ServerAliveInterval=20 \
     -o ServerAliveCountMax=3 \
     -i ~/.ssh/news-video-factory-deploy \
     aleck@100.78.232.27
   ```

5. В другом окне запустите панель:

   ```bash
   npm run dev:web
   ```

   Откройте `http://127.0.0.1:5173`. Проверка должна пройти по адресу
   `http://127.0.0.1:5173/health`.

## Постоянный туннель на macOS

На основном Mac туннель уже установлен как LaunchAgent
`com.newpeople.news-video-factory-tunnel`: он стартует при входе в систему и
перезапускается при обрыве SSH. Его состояние и лог:

```bash
launchctl print gui/$(id -u)/com.newpeople.news-video-factory-tunnel
tail -f /tmp/news-video-factory-tunnel.log
```

Для другого Mac скрипт установит такой же LaunchAgent:

```bash
SERVER=100.78.232.27 SSH_USER=aleck SSH_KEY="$HOME/.ssh/news-video-factory-deploy" \
  ./scripts/install-macos-tunnel.sh
```

Важно привязывать локальный порт к `127.0.0.1`, а не к `0.0.0.0`.

## Проверка связи

На Mac:

```bash
tailscale ping 100.78.232.27
curl http://127.0.0.1:18080/health
curl http://127.0.0.1:5173/health
```

Первый тест проверяет Tailscale, второй — SSH-туннель и серверный API, третий —
полную цепочку через Vite-прокси. Если первый тест не отвечает, локальная сеть
не имеет значения: перезапустите службу Tailscale на Windows и проверьте, что
компьютер не ушёл в сон.

## Обновление после `git push`

На Windows:

```powershell
Set-Location C:\Users\aleck\news-video-factory
git pull --ff-only
docker compose -f docker-compose.server.yml up -d --build
Invoke-RestMethod http://127.0.0.1:8080/health
```

Не публикуйте порт `8080` в интернет и не коммитьте `.env` или SSH-ключи.

## Текущее развёртывание

Windows-сервер использует каталог `C:\Users\aleck\news-video-factory`, ветку
`main` и Docker Compose. Обновление выполняется командами из раздела выше;
данные PostgreSQL, Redis, медиафайлы и модели Ollama лежат в Docker volumes и
не удаляются при `git pull` или пересборке `api` и `worker`.
