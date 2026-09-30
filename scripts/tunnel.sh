#!/usr/bin/env bash
# Runs one public session (ADR 0015, docs/ops/tunnel.md): builds the site, starts apps/server on
# 127.0.0.1 serving site + API + WebSocket on one origin, and puts the operator's ngrok in front.
#
#   scripts/tunnel.sh https://<your-dev-domain>.ngrok-free.app [--dry-run]
#
# ngrok is the operator's own install, never a repo dependency. It reads its authtoken from
# NGROK_AUTHTOKEN (a Paperclip secret) or from the operator's own ngrok config. This script never
# reads, prints or passes the token. Stop it (Ctrl-C) when the session ends: the URL is public.
set -euo pipefail

usage() {
  echo "usage: scripts/tunnel.sh https://<dev-domain> [--dry-run]" >&2
  exit 2
}

public_url="${1:-}"
dry_run=0
[[ "${2:-}" == "--dry-run" ]] && dry_run=1
# A bare https origin: the server refuses anything else, so fail here with a clearer message.
[[ "$public_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || usage

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${PORT:-8787}"
[[ "$port" =~ ^[0-9]+$ ]] || usage
static_dir="$root/apps/web/dist"
server_env=(PUBLIC_ORIGIN="$public_url" TRUST_PROXY=loopback HOST=127.0.0.1 PORT="$port" STATIC_DIR="$static_dir")
# Point ngrok at 127.0.0.1 explicitly: its default "localhost" may resolve to ::1 first.
tunnel=(ngrok http "127.0.0.1:$port" --url "$public_url")

if (( dry_run )); then
  echo "bun run --filter @omega/web build"
  echo "${server_env[*]} bun apps/server/src/index.ts"
  echo "${tunnel[*]}"
  exit 0
fi

command -v ngrok >/dev/null || { echo "ngrok is not installed (see docs/ops/tunnel.md)" >&2; exit 1; }

cd "$root"
bun run --filter @omega/web build
env "${server_env[@]}" bun apps/server/src/index.ts &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM

# Wait for readiness so the first visitor doesn't hit a dead tunnel.
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz" && break
  kill -0 "$server_pid" 2>/dev/null || { echo "server exited; see its error above" >&2; exit 1; }
  sleep 0.1
done

"${tunnel[@]}"
