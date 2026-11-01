$ErrorActionPreference = 'Stop'
$ProjectPath = 'C:\Users\aleck\news-video-factory'
$EnvPath = Join-Path $ProjectPath '.env'
$Value = 'WEB_ORIGIN=http://localhost:5173,http://127.0.0.1:5173'
$Contents = Get-Content -Raw $EnvPath

if ($Contents -match '(?m)^WEB_ORIGIN=') {
  $Contents = [regex]::Replace($Contents, '(?m)^WEB_ORIGIN=.*$', $Value)
} else {
  $Contents += [Environment]::NewLine + $Value + [Environment]::NewLine
}

[IO.File]::WriteAllText($EnvPath, $Contents)
Set-Location $ProjectPath
docker compose -f docker-compose.server.yml up -d --no-deps api
docker compose -f docker-compose.server.yml ps api
