#!/bin/sh
set -eu

env_file=${1:-.env.docker}
compose="docker compose --env-file $env_file"

$compose exec -T qbittorrent /usr/local/bin/filelist-qbittorrent-healthcheck
$compose exec -T server curl -fsS http://127.0.0.1:8097/api/v1/system/info >/dev/null
$compose exec -T server sh -c 'ffmpeg -hide_banner -h full 2>/dev/null | grep -q copypriorss' || {
  echo "container FFmpeg lacks -copypriorss (needs >= 6.1): browser compat streams will desync"
  exit 1
}
$compose exec -T server curl -fsS -X POST http://127.0.0.1:8097/api/v1/dependencies/qbittorrent/test >/dev/null
$compose exec -T server test -r /downloads
# The sidecar answers without credentials from its allowed subnets (ADR-0005).
# Probe from inside the container, from the server container across the compose
# network, and from the host against the published port.
$compose exec -T qbittorrent sh -c '
  curl -fsS -H "Referer: http://127.0.0.1:${QBT_WEBUI_PORT:-8080}" \
    "http://127.0.0.1:${QBT_WEBUI_PORT:-8080}/api/v2/app/version" >/dev/null
'
$compose exec -T server sh -c 'curl -fsS "$FILELIST_STREAMING_QBITTORRENT_URL/api/v2/app/version" >/dev/null'
webui_bind=$(awk -F= '$1 == "QBITTORRENT_WEBUI_BIND_IP" {print $2}' "$env_file")
webui_port=$(awk -F= '$1 == "QBITTORRENT_WEBUI_HOST_PORT" {print $2}' "$env_file")
webui_bind=${webui_bind:-0.0.0.0}
webui_port=${webui_port:-8080}
if [ "$webui_bind" = "0.0.0.0" ] || [ "$webui_bind" = "::" ]; then
  webui_bind=127.0.0.1
fi
if command -v curl >/dev/null 2>&1; then
  curl -fsS "http://${webui_bind}:${webui_port}/api/v2/app/version" >/dev/null
else
  echo "host curl not found; skipped the published-port probe (in-container probes already passed)" >&2
fi
$compose exec -T qbittorrent sh -c '
  curl -fsS "http://127.0.0.1:${QBT_WEBUI_PORT:-8080}/api/v2/app/preferences"
' | python3 -c '
import json, sys
prefs = json.load(sys.stdin)
expected = {
  "temp_path": "/downloads/.incomplete",
  "temp_path_enabled": True,
  "preallocate_all": False,
  "queueing_enabled": False,
  "bypass_auth_subnet_whitelist_enabled": True,
}
wrong = {key: prefs.get(key) for key, want in expected.items() if prefs.get(key) != want}
if wrong: raise SystemExit(f"qBittorrent streaming preferences drifted from policy: {wrong}")
if "0.0.0.0/0" not in str(prefs.get("bypass_auth_subnet_whitelist", "")):
    raise SystemExit("qBittorrent LAN auth bypass does not include 0.0.0.0/0")
'
echo "Server, credential-free qBittorrent WebUI access, shared storage, and streaming config checks passed."
