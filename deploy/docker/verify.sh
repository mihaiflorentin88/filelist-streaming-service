#!/bin/sh
set -eu

env_file=${1:-.env.docker}
compose="docker compose --env-file $env_file"

$compose exec -T qbittorrent /usr/local/bin/filelist-qbittorrent-healthcheck
$compose exec -T server curl -fsS http://127.0.0.1:8097/api/v1/system/info >/dev/null
$compose exec -T server curl -fsS -X POST http://127.0.0.1:8097/api/v1/dependencies/qbittorrent/test >/dev/null
$compose exec -T server test -r /downloads
$compose exec -T qbittorrent python3 -c '
from pathlib import Path
text=Path("/config/qBittorrent/config/qBittorrent.conf").read_text(encoding="utf-8")
required={
  "Downloads\\TempPath=/downloads/.incomplete/",
  "Downloads\\TempPathEnabled=true",
  "Downloads\\PreAllocation=false",
  "Downloads\\UseIncompleteExtension=false",
}
missing=sorted(required-set(text.splitlines()))
if missing: raise SystemExit("missing qBittorrent streaming settings: "+", ".join(missing))
'
echo "Server, cross-container qBittorrent authentication, shared storage, and streaming config checks passed."
