#!/bin/sh
set -eu

config=/config/qBittorrent/config/qBittorrent.conf
backup_dir=/config/filelist-backups
temp_path=${QBITTORRENT_INCOMPLETE_PATH:-/downloads/.incomplete}
api_host=$(hostname -i 2>/dev/null | awk '{print $1}')
[ -n "$api_host" ] || api_host=127.0.0.1
case "$api_host" in *:*) api_host="[$api_host]" ;; esac
base_url="http://${api_host}:${QBT_WEBUI_PORT:-8080}"
cookie=/tmp/filelist-qbittorrent-cookie
ready=/tmp/filelist-qbittorrent-ready
fresh=false
bootstrap=false

if [ -z "${QBITTORRENT_USERNAME:-}" ] || [ -z "${QBITTORRENT_PASSWORD:-}" ]; then
  echo "QBITTORRENT_USERNAME and QBITTORRENT_PASSWORD are required." >&2
  exit 64
fi

mkdir -p "$(dirname "$config")" "$backup_dir" "$temp_path"
if [ -f "$config" ]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="$backup_dir/qBittorrent.conf.$stamp.$$"
  cp -p "$config" "$backup"
  chmod 0600 "$backup"
  echo "Backed up the existing qBittorrent config to $backup"
else
  fresh=true
  bootstrap=true
  printf '%s\n' '[BitTorrent]' 'Session\DefaultSavePath=/downloads' 'Session\Port=6881' '[Meta]' 'MigrationVersion=9999' '[Preferences]' "WebUI\Port=${QBT_WEBUI_PORT:-8080}" >"$config"
fi

python3 /usr/local/lib/filelist/qbittorrent_config.py \
  --input "$config" \
  --output /tmp/qBittorrent.streaming.conf \
  --temp-path "$temp_path" \
  --template /usr/local/share/filelist/qBittorrent.streaming.conf
mv /tmp/qBittorrent.streaming.conf "$config"
chmod 0600 "$config"

case "${QBITTORRENT_FORCE_CREDENTIAL_ROTATION:-false}" in
true | TRUE | 1 | yes | YES) bootstrap=true ;;
esac
if [ "$bootstrap" = true ]; then
  python3 /usr/local/lib/filelist/qbittorrent_bootstrap.py --input "$config" --output /tmp/qBittorrent.bootstrap.conf
  mv /tmp/qBittorrent.bootstrap.conf "$config"
  chmod 0600 "$config"
fi

rm -f "$ready" "$cookie"
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
  # Any HTTP response proves that the Web API socket is ready. An existing
  # authenticated config correctly returns 401 until login supplies its SID.
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

login() {
  rm -f "$cookie"
  curl -fsS -c "$cookie" \
    -H "Referer: $base_url" \
    --data-urlencode "username=$QBITTORRENT_USERNAME" \
    --data-urlencode "password=$QBITTORRENT_PASSWORD" \
    "$base_url/api/v2/auth/login" >/dev/null 2>&1
}

if [ "$bootstrap" = true ]; then
  preferences=$(python3 -c 'import json,os; print(json.dumps({"web_ui_username":os.environ["QBITTORRENT_USERNAME"],"web_ui_password":os.environ["QBITTORRENT_PASSWORD"]}))')
  curl -fsS -H "Referer: $base_url" --data-urlencode "json=$preferences" "$base_url/api/v2/app/setPreferences" >/dev/null || stop_with_error "Could not initialize qBittorrent credentials."
  preferences='{"bypass_auth_subnet_whitelist_enabled":false,"bypass_auth_subnet_whitelist":""}'
  curl -fsS -H "Referer: $base_url" --data-urlencode "json=$preferences" "$base_url/api/v2/app/setPreferences" >/dev/null || stop_with_error "Could not disable temporary qBittorrent bootstrap access."
  # qBittorrent persists the new PBKDF2 credential immediately but activates it
  # reliably only after a clean process restart.
  kill -TERM "$child"
  wait "$child" || stop_with_error "qBittorrent failed while activating initialized credentials."
  /entrypoint.sh "$@" &
  child=$!
  wait_until_ready
  login || stop_with_error "qBittorrent rejected the newly configured credentials after temporary subnet bypass was disabled."
  echo "Initialized qBittorrent Web UI credentials and disabled temporary subnet bypass."
elif ! login; then
  stop_with_error "The existing qBittorrent credentials were preserved but do not match QBITTORRENT_USERNAME/QBITTORRENT_PASSWORD. Correct .env.docker or explicitly set QBITTORRENT_FORCE_CREDENTIAL_ROTATION=true for one start."
fi

# qBittorrent 5 moved the progressive-streaming storage policy out of the
# legacy Downloads\* INI keys (temp path, preallocation, queueing), so the
# policy is applied through the Web API on every start and persists in the
# container's own configuration.
curl -fsS -b "$cookie" --data-urlencode 'json={"temp_path_enabled":true,"temp_path":"'"$temp_path"'","preallocate_all":false,"queueing_enabled":false}' \
  "$base_url/api/v2/app/setPreferences" >/dev/null || stop_with_error "Could not apply the progressive-streaming qBittorrent storage policy."

touch "$ready"
if [ "$fresh" = true ]; then
  echo "Created a fresh qBittorrent configuration with progressive-streaming storage policy."
else
  echo "Preserved qBittorrent credentials and merged progressive-streaming storage policy."
fi
wait "$child"
