#!/usr/bin/env bash

set -euo pipefail

EXTENSION_IDS="${SSPA_EXTENSION_IDS:-}"
CHROME_PROFILE_PATH="${CHROME_PROFILE_PATH:-}"
PERSIST_ENV=false
KILL_PORT=false
ALLOW_ANY_EXTENSION=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-ids)
      EXTENSION_IDS="$2"
      shift 2
      ;;
    --chrome-profile)
      CHROME_PROFILE_PATH="$2"
      shift 2
      ;;
    --persist-env)
      PERSIST_ENV=true
      shift
      ;;
    --kill-port)
      KILL_PORT=true
      shift
      ;;
    --allow-any-extension)
      ALLOW_ANY_EXTENSION=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

prompt_for() {
  local name="$1"
  local value="$2"
  local prompt="$3"

  if [[ -n "$value" ]]; then
    echo "$value"
    return
  fi

  read -r -p "$prompt" input
  if [[ -z "$input" ]]; then
    echo "Missing required value: $name" >&2
    exit 1
  fi
  echo "$input"
}

if [[ "$ALLOW_ANY_EXTENSION" == "true" ]]; then
  EXTENSION_IDS=""
else
  EXTENSION_IDS="$(prompt_for "SSPA_EXTENSION_IDS" "$EXTENSION_IDS" "Enter SSPA_EXTENSION_IDS (comma-separated extension IDs): ")"
fi
CHROME_PROFILE_PATH="$(prompt_for "CHROME_PROFILE_PATH" "$CHROME_PROFILE_PATH" "Enter CHROME_PROFILE_PATH (Chrome User Data path): ")"

export SSPA_EXTENSION_IDS="$EXTENSION_IDS"
export CHROME_PROFILE_PATH="$CHROME_PROFILE_PATH"
export NODE_OPTIONS="--openssl-legacy-provider"

if [[ "$PERSIST_ENV" == "true" ]]; then
  export SSPA_EXTENSION_IDS="$EXTENSION_IDS"
  export CHROME_PROFILE_PATH="$CHROME_PROFILE_PATH"
  echo "Persisting environment variables is not supported from bash on Windows." >&2
fi

if [[ "$ALLOW_ANY_EXTENSION" == "true" ]]; then
  echo "SSPA_EXTENSION_IDS=<any>"
else
  echo "SSPA_EXTENSION_IDS=$SSPA_EXTENSION_IDS"
fi
echo "CHROME_PROFILE_PATH=$CHROME_PROFILE_PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$KILL_PORT" == "true" ]]; then
  powershell -Command "try { if (Get-NetTCPConnection -State Listen -LocalPort 19989 -ErrorAction SilentlyContinue) { Stop-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 19989 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess) -Force } } catch { }"
else
  powershell -Command "try { if (Get-NetTCPConnection -State Listen -LocalPort 19989 -ErrorAction SilentlyContinue) { exit 1 } } catch { }" || {
    echo "Port 19989 already in use. Rerun with --kill-port or stop the relay process." >&2
    exit 1
  }
fi

echo "Starting hot reload (extension + relay + MCP)..."

pnpm exec concurrently --kill-others-on-fail -s first --names "WPK,COPY,EXT,REL,MCP" -c "magenta,cyan,blue,green,yellow" \
  "pnpm exec webpack --watch" \
  "node scripts/watch-build-chrome.js" \
  "pnpm exec web-ext run --source-dir dist-chrome --target chromium --chromium-profile \"$CHROME_PROFILE_PATH\"" \
  "pnpm --dir mcp exec tsx watch src/relay.ts" \
  "pnpm --dir mcp exec tsx watch src/mcp.ts"
