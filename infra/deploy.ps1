param(
  [string]$ProjectPath = 'C:\Users\aleck\news-video-factory'
)

$ErrorActionPreference = 'Stop'
Set-Location $ProjectPath

if (-not (Test-Path '.env')) {
  throw 'Create .env from .env.example and set POSTGRES_PASSWORD before the first deploy.'
}

git pull --ff-only
docker compose -f docker-compose.server.yml up -d --build --pull never
docker compose -f docker-compose.server.yml ps
