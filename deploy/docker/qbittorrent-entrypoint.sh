#!/bin/sh
set -eu

config=/config/qBittorrent/config/qBittorrent.conf
backup_dir=/config/filelist-backups
temp_path=${QBITTORRENT_INCOMPLETE_PATH:-/downloads/.incomplete}
api_host=$(hostname -i 2>/dev/null | awk '{print $1}')
[ -n "$api_host" ] || api_host=127.0.0.1
case "$api_host" in *:*) api_host="[$api_host]" ;; esac
base_url="http://${api_host}:${QBT_WEBUI_PORT:-8080}"
ready=/tmp/filelist-qbittorrent-ready
fresh=false

mkdir -p "$(dirname "$config")" "$backup_dir" "$temp_path"
if [ -f "$config" ]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="$backup_dir/qBittorrent.conf.$stamp.$$"
  cp -p "$config" "$backup"
  chmod 0600 "$backup"
  echo "Backed up the existing qBittorrent config to $backup"
else
  fresh=true
  printf '%s\n' '[BitTorrent]' 'Session\DefaultSavePath=/downloads' 'Session\Port=6881' '[Meta]' 'MigrationVersion=9999' '[Preferences]' "WebUI\Port=${QBT_WEBUI_PORT:-8080}" >"$config"
fi

# The merge applies the progressive-streaming storage policy and the sidecar's
# no-auth LAN WebUI posture (ADR-0005) before qBittorrent starts, so even an
# older credentialed config becomes credential-free without a login window.
python3 /usr/local/lib/filelist/qbittorrent_config.py \
  --input "$config" \
  --output /tmp/qBittorrent.streaming.conf \
  --temp-path "$temp_path" \
  --template /usr/local/share/filelist/qBittorrent.streaming.conf \
  --noauth-webui
mv /tmp/qBittorrent.streaming.conf "$config"
chmod 0600 "$config"

rm -f "$ready"
/entrypoint.sh "$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' INT TERM

stop_with_error() {
  echo "$1" >&2
  kill -TERM "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  exit 1
}

wait_until_ready() {
  attempt=0
  # Any HTTP response proves that the Web API socket is ready; the merged
  # no-auth posture makes even the first unauthenticated call succeed.
  while ! curl -sS -o /dev/null "$base_url/api/v2/app/version" 2>/dev/null; do
    attempt=$((attempt + 1))
    if ! kill -0 "$child" 2>/dev/null; then
      wait "$child"
      exit $?
    fi
    if [ "$attempt" -ge 90 ]; then
      stop_with_error "qBittorrent Web API did not become ready."
    fi
    sleep 1
  done
}

wait_until_ready

# qBittorrent 5 moved the progressive-streaming storage policy out of the
# legacy Downloads\* INI keys (temp path, preallocation, queueing), so the
# policy is applied through the Web API on every start and persists in the
# container's own configuration. The LAN auth bypass and a benign username
# are re-asserted in the same unauthenticated call.
curl -fsS --data-urlencode 'json={"temp_path_enabled":true,"temp_path":"'"$temp_path"'","preallocate_all":false,"queueing_enabled":false,"web_ui_username":"admin","bypass_auth_subnet_whitelist_enabled":true,"bypass_auth_subnet_whitelist":"0.0.0.0/0"}' \
  "$base_url/api/v2/app/setPreferences" >/dev/null || stop_with_error "Could not apply the progressive-streaming qBittorrent storage policy."

touch "$ready"
if [ "$fresh" = true ]; then
  echo "Created a fresh credential-free qBittorrent configuration with progressive-streaming storage policy."
else
  echo "Preserved qBittorrent settings and enforced the no-auth LAN sidecar policy."
fi
wait "$child"
