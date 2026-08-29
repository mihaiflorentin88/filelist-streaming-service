#!/bin/sh
set -eu

[ -f /tmp/filelist-qbittorrent-ready ] || exit 1
api_host=$(hostname -i 2>/dev/null | awk '{print $1}')
[ -n "$api_host" ] || api_host=127.0.0.1
case "$api_host" in *:*) api_host="[$api_host]" ;; esac
base_url="http://${api_host}:${QBT_WEBUI_PORT:-8080}"
# The sidecar answers without credentials from its allowed subnets (ADR-0005);
# a 401/403 here means the no-auth posture drifted and the container is unhealthy.
curl -fsS -H "Referer: $base_url" "$base_url/api/v2/app/version" >/dev/null
