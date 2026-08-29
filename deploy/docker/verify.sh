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
$compose exec -T qbittorrent sh -c '
  curl -fsS -c /tmp/filelist-verify-cookie \
    -H "Referer: http://127.0.0.1:${QBT_WEBUI_PORT:-8080}" \
    --data-urlencode "username=${QBITTORRENT_USERNAME}" \
    --data-urlencode "password=${QBITTORRENT_PASSWORD}" \
    "http://127.0.0.1:${QBT_WEBUI_PORT:-8080}/api/v2/auth/login" > /dev/null
  curl -fsS -b /tmp/filelist-verify-cookie \
    "http://127.0.0.1:${QBT_WEBUI_PORT:-8080}/api/v2/app/preferences"
' | python3 -c '
import json, sys
prefs = json.load(sys.stdin)
expected = {
  "temp_path": "/downloads/.incomplete",
  "temp_path_enabled": True,
  "preallocate_all": False,
  "queueing_enabled": False,
}
wrong = {key: prefs.get(key) for key, want in expected.items() if prefs.get(key) != want}
if wrong: raise SystemExit(f"qBittorrent streaming preferences drifted from policy: {wrong}")
'
$compose exec -T qbittorrent rm -f /tmp/filelist-verify-cookie
echo "Server, cross-container qBittorrent authentication, shared storage, and streaming config checks passed."
