#!/bin/zsh
set -euo pipefail

# Installs a per-user LaunchAgent which keeps the API tunnel alive after login.
# Example:
#   SERVER=100.78.232.27 SSH_USER=aleck SSH_KEY=~/.ssh/news-video-factory-deploy ./scripts/install-macos-tunnel.sh

: "${SERVER:?Set SERVER to the server Tailscale IP or MagicDNS name}"
: "${SSH_USER:?Set SSH_USER to the Windows SSH user}"
: "${SSH_KEY:?Set SSH_KEY to the absolute path of the SSH private key}"

label=com.newpeople.news-video-factory-tunnel
uid=$(id -u)
bin_dir="$HOME/.local/bin"
agent_dir="$HOME/Library/LaunchAgents"
tunnel_script="$bin_dir/news-video-factory-tunnel"
plist="$agent_dir/$label.plist"

mkdir -p "$bin_dir" "$agent_dir"
printf '%s\n' '#!/bin/zsh' 'set -euo pipefail' \
  "exec /usr/bin/ssh -N -L 127.0.0.1:18080:127.0.0.1:8080 -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o BatchMode=yes -i '$SSH_KEY' '$SSH_USER@$SERVER'" > "$tunnel_script"
chmod 700 "$tunnel_script"

printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0"><dict>' \
  "<key>Label</key><string>$label</string>" \
  "<key>ProgramArguments</key><array><string>$tunnel_script</string></array>" \
  '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' \
  '<key>StandardOutPath</key><string>/tmp/news-video-factory-tunnel.log</string>' \
  '<key>StandardErrorPath</key><string>/tmp/news-video-factory-tunnel.log</string>' \
  '</dict></plist>' > "$plist"

launchctl bootout "gui/$uid/$label" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$plist"
launchctl kickstart -k "gui/$uid/$label"
echo "Tunnel installed. Test with: curl http://127.0.0.1:18080/health"
