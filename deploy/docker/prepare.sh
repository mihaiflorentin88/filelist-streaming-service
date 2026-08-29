#!/bin/sh
set -eu

env_file=${1:-.env.docker}
[ -f "$env_file" ] || {
  echo "$env_file is missing; run 'make docker-configure' or copy .env.docker.example." >&2
  exit 2
}

value() {
  awk -F= -v wanted="$1" '$1 == wanted {sub(/^[^=]*=/, ""); value=$0} END {print value}' "$env_file"
}

for key in APP_DATA_DIR QBITTORRENT_CONFIG_DIR DOWNLOADS_DIR; do
  result=$(value "$key")
  [ -n "$result" ] || {
    echo "$key must be set in $env_file" >&2
    exit 2
  }
  case "$result" in CHANGE_ME* | /absolute/path*)
    echo "$key still contains an example value in $env_file" >&2
    exit 2
    ;;
  esac
done

for key in APP_DATA_DIR QBITTORRENT_CONFIG_DIR DOWNLOADS_DIR; do
  result=$(value "$key")
  case "$result" in /*) ;; *)
    echo "$key must be an absolute path: $result" >&2
    exit 2
    ;;
  esac
  mkdir -p "$result"
done
mkdir -p "$(value DOWNLOADS_DIR)/.incomplete"
chmod u+rwX "$(value APP_DATA_DIR)" "$(value QBITTORRENT_CONFIG_DIR)" "$(value DOWNLOADS_DIR)" "$(value DOWNLOADS_DIR)/.incomplete"

docker compose --env-file "$env_file" config --quiet
echo "Docker paths and Compose configuration are ready."
