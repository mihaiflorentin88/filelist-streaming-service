#!/bin/sh
set -eu

[ -f /tmp/filelist-qbittorrent-ready ] || exit 1
api_host=$(hostname -i 2>/dev/null | awk '{print $1}')
[ -n "$api_host" ] || api_host=127.0.0.1
case "$api_host" in *:*) api_host="[$api_host]" ;; esac
base_url="http://${api_host}:${QBT_WEBUI_PORT:-8080}"
cookie=/tmp/filelist-qbittorrent-health-cookie
rm -f "$cookie"
curl -fsS -c "$cookie" \
  -H "Referer: $base_url" \
  --data-urlencode "username=$QBITTORRENT_USERNAME" \
  --data-urlencode "password=$QBITTORRENT_PASSWORD" \
  "$base_url/api/v2/auth/login" >/dev/null
curl -fsS -b "$cookie" "$base_url/api/v2/app/version" >/dev/null
