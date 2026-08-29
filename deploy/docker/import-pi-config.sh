#!/bin/sh
# Import the live Raspberry Pi configuration into a self-contained Docker
# test deployment under <repo>/docker-runtime:
#   docker-runtime/data/settings.json   copy of the Pi settings, download
#                                       root rewritten to /downloads
#   docker-runtime/downloads/           fresh download target (delete freely)
#   docker-runtime/qbittorrent/         fresh qBittorrent config
#   .env.docker                         compose env with the Pi credentials
#
# Everything generated is disposable: remove docker-runtime/ and .env.docker
# and nothing of the test remains. Both files are git-ignored; secrets are
# transferred over ssh and never printed.
set -eu

PI_HOST=${1:-}
script_dir=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$script_dir/../.." && pwd)
runtime="$root/docker-runtime"

if [ -z "$PI_HOST" ]; then
  conf="$root/deploy/.deploy.local.conf"
  if [ -f "$conf" ]; then
    PI_HOST=$(awk -F= '$1 == "PI_HOST" {print $2}' "$conf" | tr -d '[:space:]')
  fi
fi
[ -n "$PI_HOST" ] || {
  echo "usage: $0 <user@pi-host>" >&2
  exit 2
}

command -v python3 >/dev/null || {
  echo "python3 is required locally" >&2
  exit 2
}

mkdir -p "$runtime/data" "$runtime/downloads/.incomplete" "$runtime/qbittorrent"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Pull the live settings once; parse everything locally.
ssh "$PI_HOST" sudo cat /var/lib/filelist-streaming/data/settings.json >"$tmp/pi-settings.json"

python3 - "$tmp/pi-settings.json" "$tmp/creds.env" "$runtime/data/settings.json" <<'PYEOF'
import json
import sys
from pathlib import Path

source, creds_out, settings_out = (Path(p) for p in sys.argv[1:4])
settings = json.loads(source.read_text(encoding="utf-8"))

creds = {
    "FILELIST_USERNAME": settings.get("fileListUsername", ""),
    "FILELIST_PASSKEY": settings.get("fileListPasskey", ""),
    "TMDB_API_KEY": settings.get("tmdbApiKey", ""),
    "SUBDL_API_KEY": settings.get("subDLApiKey", ""),
    "SERVER_INSTANCE_NAME": settings.get("instanceName", "FileList Streaming"),
}
creds_out.write_text(
    "".join(f"{key}={value}\n" for key, value in creds.items()),
    encoding="utf-8",
)

# The container mounts DOWNLOADS_DIR at /downloads; keep every other value
# from the Pi (database, artwork, subtitle cache use container-relative
# paths that already resolve inside the data volume).
settings["downloadRoot"] = "/downloads"
settings_out.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
PYEOF
chmod 600 "$tmp/creds.env" "$runtime/data/settings.json"

# Generate .env.docker from the documented template with overrides.
python3 - "$root/.env.docker.example" "$root/.env.docker" "$tmp/creds.env" "$runtime" <<'PYEOF'
import sys
from pathlib import Path

template, env_out, creds_file, runtime = (Path(p) for p in sys.argv[1:5])
creds = {}
for line in creds_file.read_text(encoding="utf-8").splitlines():
    if "=" in line:
        key, value = line.split("=", 1)
        creds[key] = value

overrides = {
    "FILELIST_STREAMING_VERSION": "0.2.16",
    "APP_DATA_DIR": f"{runtime}/data",
    "QBITTORRENT_CONFIG_DIR": f"{runtime}/qbittorrent",
    "DOWNLOADS_DIR": f"{runtime}/downloads",
    # Port bumps keep the stack clash-free next to the bare-metal services
    # (8097 server, 8080 qBittorrent Web UI, 6881 torrenting port on the Pi).
    "SERVER_HOST_PORT": "8098",
    "QBITTORRENT_WEBUI_HOST_PORT": "8081",
    "QBITTORRENT_HOST_PORT": "6882",
}
overrides.update(creds)

lines = template.read_text(encoding="utf-8").splitlines()
seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else None
    if key and key in overrides:
        out.append(f"{key}={overrides[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in overrides.items():
    if key not in seen:
        out.append(f"{key}={value}")
env_out.write_text("\n".join(out) + "\n", encoding="utf-8")
PYEOF
chmod 600 "$root/.env.docker"

sh "$script_dir/prepare.sh" "$root/.env.docker"
echo "Imported Pi configuration into docker-runtime/ and .env.docker."
echo "Start the test stack with: make docker-up    (server on port 8098)"
echo "Remove everything afterwards: make docker-down && rm -rf docker-runtime .env.docker"
