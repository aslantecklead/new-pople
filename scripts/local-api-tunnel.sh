#!/bin/zsh
set -euo pipefail

exec /usr/bin/ssh -N \
  -L 127.0.0.1:18080:127.0.0.1:8080 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=20 \
  -o ServerAliveCountMax=3 \
  -o BatchMode=yes \
  -i /Users/aslanasalbekov/.ssh/news-video-factory-deploy \
  aleck@100.78.232.27
