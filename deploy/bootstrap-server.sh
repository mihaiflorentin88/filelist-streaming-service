#!/bin/sh
# Fresh-server bootstrap. Do not use this for routine upgrades; make deploy-pi
# deliberately remains package-install-free.
set -eu

confirm=false
dry_run=false
for argument in "$@"; do
	case "$argument" in
		--confirm-server-install) confirm=true ;;
		--dry-run) dry_run=true ;;
		*) echo "unknown argument: $argument" >&2; exit 2 ;;
	esac
done

if [ "$confirm" != true ]; then
	echo "Refusing to modify this host without --confirm-server-install." >&2
	echo "Use --dry-run --confirm-server-install to review commands." >&2
	exit 2
fi
if [ "$(id -u)" -ne 0 ]; then echo "Run as root (for example: sudo $0 --confirm-server-install)." >&2; exit 2; fi

run() { if [ "$dry_run" = true ]; then printf '+ '; printf '%s ' "$@"; printf '\n'; else "$@"; fi; }
need() { command -v "$1" >/dev/null 2>&1; }

if need apt-get; then package_manager=apt; packages="ca-certificates curl ffmpeg logrotate qbittorrent-nox tar";
elif need dnf; then package_manager=dnf; packages="ca-certificates curl ffmpeg logrotate qbittorrent-nox tar";
elif need pacman; then package_manager=pacman; packages="ca-certificates curl ffmpeg logrotate qbittorrent-nox tar";
elif need zypper; then package_manager=zypper; packages="ca-certificates curl ffmpeg logrotate qbittorrent-nox tar";
else echo "Supported package managers: apt, dnf, pacman, zypper." >&2; exit 1; fi

echo "FileList Streaming fresh-server setup"
echo "  package manager: $package_manager"
echo "  packages: $packages"
echo "  qB Web UI: http://127.0.0.1:8080"
echo "  downloads: /srv/filelist-downloads"
echo "  application state: /var/lib/filelist-streaming"
echo "No firewall rules or application secrets will be changed."

case "$package_manager" in
	apt) run apt-get update; run apt-get install -y $packages ;;
	dnf) run dnf install -y $packages ;;
	pacman) run pacman -Sy --needed --noconfirm $packages ;;
	zypper) run zypper --non-interactive install $packages ;;
esac

architecture=$(uname -m)
case "$architecture" in x86_64) go_arch=amd64;; aarch64|arm64) go_arch=arm64;; *) echo "Unsupported Go architecture: $architecture" >&2; exit 1;; esac
go_version=$(awk '$1=="go"{print $2;exit}' go.mod)
go_archive="go${go_version}.linux-${go_arch}.tar.gz"
go_url="https://go.dev/dl/${go_archive}"
go_checksum_url="${go_url}.sha256"
go_root="/var/lib/filelist-streaming/toolchains/go${go_version}"
build_root="/var/lib/filelist-streaming/build"

run install -d -m 0750 /var/lib/filelist-streaming /var/lib/filelist-streaming/data /var/lib/filelist-streaming/data/logs "$build_root" /srv/filelist-downloads
if [ "$dry_run" = true ]; then
	echo "+ download $go_url and $go_checksum_url; verify SHA-256; extract privately to $go_root"
else
	tmp_dir=$(mktemp -d /tmp/filelist-bootstrap.XXXXXX)
	trap 'rm -rf -- "$tmp_dir"' EXIT INT TERM
	curl --fail --location --proto '=https' --tlsv1.2 "$go_url" -o "$tmp_dir/$go_archive"
	curl --fail --location --proto '=https' --tlsv1.2 "$go_checksum_url" -o "$tmp_dir/$go_archive.sha256"
	expected=$(tr -d '[:space:]' < "$tmp_dir/$go_archive.sha256")
	actual=$(sha256sum "$tmp_dir/$go_archive" | awk '{print $1}')
	[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "Go archive checksum mismatch" >&2; exit 1; }
	rm -rf -- "$go_root.new"
	install -d -m 0755 "$go_root.new"
	tar -C "$go_root.new" --strip-components=1 -xzf "$tmp_dir/$go_archive"
	rm -rf -- "$go_root"
	mv "$go_root.new" "$go_root"
	GOCACHE="$build_root/go-cache" CGO_ENABLED=0 "$go_root/bin/go" build -trimpath -ldflags='-s -w' -o "$build_root/filelist-streaming" ./cmd/server
fi

if ! getent group qbittorrent >/dev/null 2>&1; then run groupadd --system qbittorrent; fi
if ! id qbittorrent >/dev/null 2>&1; then run useradd --system --gid qbittorrent --home-dir /var/lib/qbittorrent --create-home --shell /usr/sbin/nologin qbittorrent; fi
if ! id filelist-streaming >/dev/null 2>&1; then run useradd --system --home-dir /var/lib/filelist-streaming --no-create-home --shell /usr/sbin/nologin filelist-streaming; fi
run usermod -a -G qbittorrent filelist-streaming
run chown -R filelist-streaming:filelist-streaming /var/lib/filelist-streaming
run chown -R qbittorrent:qbittorrent /srv/filelist-downloads
qb_config=/var/lib/qbittorrent/.config/qBittorrent/qBittorrent.conf
if [ "$dry_run" = true ]; then
	echo "+ create $qb_config when absent with Web UI 127.0.0.1:8080 and /srv/filelist-downloads save path"
elif [ ! -f "$qb_config" ]; then
	install -d -m 0750 -o qbittorrent -g qbittorrent "$(dirname "$qb_config")"
	printf '%s\n' '[LegalNotice]' 'Accepted=true' '[Preferences]' 'WebUI\Address=127.0.0.1' 'WebUI\Port=8080' 'Downloads\SavePath=/srv/filelist-downloads/' > "$qb_config"
	chown qbittorrent:qbittorrent "$qb_config"
	chmod 0640 "$qb_config"
fi
run install -m 0755 "$build_root/filelist-streaming" /usr/local/bin/filelist-streaming
run install -m 0644 deploy/systemd/qbittorrent-nox.service /etc/systemd/system/qbittorrent-nox.service
run install -m 0644 deploy/systemd/filelist-streaming.service /etc/systemd/system/filelist-streaming.service
run install -m 0644 deploy/systemd/filelist-streaming.logrotate /etc/logrotate.d/filelist-streaming
run systemctl daemon-reload
run systemctl enable --now qbittorrent-nox.service
run systemctl enable --now filelist-streaming.service

echo "Setup complete. Configure qBittorrent's save path as /srv/filelist-downloads and bind its Web UI to 127.0.0.1:8080."
echo "Find qBittorrent's temporary password with: journalctl -u qbittorrent-nox --no-pager | grep -i password"
echo "Then configure FileList Streaming in a browser at http://SERVER_LAN_IP:8097."
