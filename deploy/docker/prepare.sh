#!/bin/sh
set -eu

env_file=${1:-.env.docker}
[ -f "$env_file" ] || {
  echo "$env_file is missing; run 'make docker-configure' or copy .env.docker.example." >&2
  exit 2
}

# The validator is the single source of truth for every .env.docker check.
script_dir=$(dirname "$0")
python3 "$script_dir/../../tools/docker_env_validate.py" "$env_file"

value() {
  awk -F= -v wanted="$1" '$1 == wanted {sub(/^[^=]*=/, ""); value=$0} END {print value}' "$env_file"
}

for key in APP_DATA_DIR QBITTORRENT_CONFIG_DIR DOWNLOADS_DIR; do
  mkdir -p "$(value "$key")"
done
mkdir -p "$(value DOWNLOADS_DIR)/.incomplete"
chmod u+rwX "$(value APP_DATA_DIR)" "$(value QBITTORRENT_CONFIG_DIR)" "$(value DOWNLOADS_DIR)" "$(value DOWNLOADS_DIR)/.incomplete"

docker compose --env-file "$env_file" config --quiet
echo "Docker paths and Compose configuration are ready."
