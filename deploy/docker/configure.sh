#!/bin/sh
set -eu

env_file=${1:-.env.docker}
if [ ! -f "$env_file" ]; then
  cp .env.docker.example "$env_file"
  chmod 0600 "$env_file"
  echo "Created $env_file from the documented template."
fi

current_value() {
  awk -F= -v wanted="$1" '$1 == wanted {sub(/^[^=]*=/, ""); value=$0} END {print value}' "$env_file"
}

set_value() {
  FILELIST_ENV_FILE=$env_file FILELIST_ENV_KEY=$1 FILELIST_ENV_VALUE=$2 python3 -c '
import os
from pathlib import Path
path = Path(os.environ["FILELIST_ENV_FILE"])
key = os.environ["FILELIST_ENV_KEY"]
value = os.environ["FILELIST_ENV_VALUE"]
lines = path.read_text(encoding="utf-8").splitlines()
replacement = f"{key}={value}"
for index, line in enumerate(lines):
    if line.split("=", 1)[0] == key:
        lines[index] = replacement
        break
else:
    lines.append(replacement)
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
'
}

ask() {
  key=$1
  label=$2
  old=$(current_value "$key")
  printf '%s [%s]: ' "$label" "$old"
  IFS= read -r answer
  [ -n "$answer" ] || answer=$old
  set_value "$key" "$answer"
}

ask_secret() {
  key=$1
  label=$2
  old=$(current_value "$key")
  if [ -n "$old" ] && [ "$old" != CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD ]; then
    prompt='configured; Enter keeps it'
  else
    prompt='required'
  fi
  printf '%s [%s]: ' "$label" "$prompt"
  stty -echo
  IFS= read -r answer
  stty echo
  printf '\n'
  [ -n "$answer" ] || answer=$old
  set_value "$key" "$answer"
}

echo "Values are stored in ignored file $env_file and offered again on future runs."
ask APP_DATA_DIR "Application data directory (absolute path)"
ask QBITTORRENT_CONFIG_DIR "qBittorrent config directory (absolute path)"
ask DOWNLOADS_DIR "Downloads directory on the large disk (absolute path)"
ask SERVER_BIND_IP "Server bind address"
ask SERVER_HOST_PORT "Server port"
ask SERVER_INSTANCE_NAME "Server discovery name"
ask PUID "Container user ID"
ask PGID "Container group ID"
ask QBITTORRENT_USERNAME "qBittorrent username"
ask_secret QBITTORRENT_PASSWORD "qBittorrent password"
ask FILELIST_USERNAME "FileList username (optional now)"
ask_secret FILELIST_PASSKEY "FileList passkey (optional now)"
chmod 0600 "$env_file"
echo "Saved Docker deployment configuration to $env_file."
