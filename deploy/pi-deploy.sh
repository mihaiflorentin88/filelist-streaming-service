#!/bin/sh
set -eu

host=${1:?usage: pi-deploy.sh user@host arm64-binary systemd-unit logrotate-config}
binary=${2:?missing ARM64 binary}
unit=${3:?missing systemd unit}
logrotate=${4:?missing logrotate config}
stage="/tmp/filelist-streaming-deploy-$$"

case "$stage" in /tmp/filelist-streaming-deploy-[0-9]*) ;; *) echo "unsafe staging path" >&2; exit 1;; esac
ssh "$host" "install -d -m 700 '$stage'"
cleanup() { ssh "$host" "rm -rf -- '$stage'" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
scp "$binary" "$host:$stage/filelist-streaming"
scp "$unit" "$host:$stage/filelist-streaming.service"
scp "$logrotate" "$host:$stage/filelist-streaming.logrotate"

ssh "$host" "sudo sh -s -- '$stage'" <<'REMOTE'
set -eu
stage=$1
service=filelist-streaming.service
target=/usr/local/bin/filelist-streaming
previous=/usr/local/bin/filelist-streaming.previous

test -f "$stage/filelist-streaming"
test -f "$stage/filelist-streaming.service"
test -f "$stage/filelist-streaming.logrotate"
getent group qbittorrent >/dev/null

if ! id filelist-streaming >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/filelist-streaming --no-create-home --shell /usr/sbin/nologin filelist-streaming
fi
usermod -a -G qbittorrent filelist-streaming
install -d -m 0750 -o filelist-streaming -g filelist-streaming /var/lib/filelist-streaming /var/lib/filelist-streaming/data /var/lib/filelist-streaming/data/logs

had_binary=false
if test -f "$target"; then
  cp -a "$target" "$previous"
  had_binary=true
fi
install -m 0755 "$stage/filelist-streaming" "$target.new"
mv -f "$target.new" "$target"
install -m 0644 "$stage/filelist-streaming.service" /etc/systemd/system/filelist-streaming.service
install -m 0644 "$stage/filelist-streaming.logrotate" /etc/logrotate.d/filelist-streaming
systemctl daemon-reload

if ! systemctl enable --now "$service" || ! systemctl restart "$service" || ! systemctl is-active --quiet "$service"; then
  echo "deployment failed; attempting binary rollback" >&2
  if test "$had_binary" = true && test -f "$previous"; then
    mv -f "$previous" "$target"
    systemctl restart "$service" || true
  fi
  exit 1
fi

rm -f "$previous"
rm -rf -- "$stage"
systemctl --no-pager --full status "$service" | sed -n '1,18p'
REMOTE

trap - EXIT INT TERM
echo "Deployed to $host; open http://<server-lan-address>:8097"
