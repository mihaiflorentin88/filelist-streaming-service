# Installation and upgrades

This guide covers a fresh scripted server, routine scripted deployment, installation from a precompiled GitHub release, a fully manual setup, initial browser configuration, and Samsung Tizen installation. The server is intended for a trusted private LAN and has no client login.

## Choose an installation method

| Method | Best for | Builds on the target? | Installs packages? |
| --- | --- | --- | --- |
| Fresh-server bootstrap | A new dedicated Linux media server | Yes, using a private verified Go toolchain | Yes, on the server only |
| Routine `make deploy-pi` | Updating an existing ARM64 Raspberry Pi | Cross-builds on the development machine | No |
| GitHub release binary | Installing without Go or Node.js | No | Only runtime packages you install |
| Manual source install | Custom distributions, users, paths, or service policy | Yes | You control every package |

Do not run the fresh-server bootstrap on a workstation. The normal server needs qBittorrent-nox, FFmpeg/ffprobe for embedded subtitles, Python 3 for deployment helpers, CA certificates, and logrotate. SQLite is embedded in the Go binary. Node.js is not needed at runtime.

## Storage and credentials

Choose the final storage paths before installation. On the current Raspberry Pi, the large disk layout is:

```text
download root:    /mnt/sda1/torrent
incomplete files: /mnt/sda1/torrent/.incomplete
application data: /var/lib/filelist-streaming
```

The incomplete path must be inside the download root and must be on a filesystem with enough free space for the selected torrents. qBittorrent and the `filelist-streaming` service must both be able to traverse and read that tree.

Never put FileList passkeys, qBittorrent passwords, TMDB tokens, or subtitle-provider keys in Git, shell history, service files, deployment profiles, or the sanitized qBittorrent template. Enter them later through browser Settings. Runtime settings are stored as `/var/lib/filelist-streaming/data/settings.json` with restrictive permissions.

## Method 1: fresh-server bootstrap

Clone the repository on the Linux media server, review the script, and preview the exact package and service actions:

```bash
git clone https://github.com/mihaiflorentin88/filelist-streaming-service.git
cd filelist-streaming-service
sudo sh deploy/bootstrap-server.sh \
  --confirm-server-install \
  --dry-run \
  --download-root=/mnt/sda1/torrent \
  --qb-temp-path=/mnt/sda1/torrent/.incomplete
```

If the preview is correct, remove `--dry-run`:

```bash
sudo sh deploy/bootstrap-server.sh \
  --confirm-server-install \
  --download-root=/mnt/sda1/torrent \
  --qb-temp-path=/mnt/sda1/torrent/.incomplete
```

The bootstrap supports `apt`, `dnf`, `pacman`, and `zypper`. It installs server runtime packages, creates dedicated `qbittorrent` and `filelist-streaming` accounts, downloads the exact Go version from `go.mod` into a private directory after SHA-256 verification, builds the server, installs the systemd/logrotate files, prepares the selected storage paths, and enables both services. It does not configure a firewall or write application credentials.

Find qBittorrent's temporary Web UI password in its journal, then continue with [Initial configuration](#initial-configuration):

```bash
sudo journalctl -u qbittorrent-nox --no-pager | grep -i password
```

## Method 2: routine Raspberry Pi deployment

Use this after the server and qBittorrent already exist. From a development checkout:

```bash
make deploy-pi PI_HOST=mihai@192.168.50.2
```

The command prompts for the SSH target, qBittorrent service/config path, download root, incomplete path, backup directory, and application binary path. Non-secret answers are remembered in the ignored `deploy/.deploy.local.conf` and offered as defaults on the next run.

Every deployment:

1. cross-compiles the ARM64 server;
2. stages only the binary, service files, sanitized qBittorrent template, and merge helper;
3. stops qBittorrent and creates a new mode-`0600` timestamped config backup;
4. merges only the four storage/streaming keys from `deploy/qbittorrent/qBittorrent.streaming.conf`;
5. preserves Web UI credentials, tokens, bindings, ports, save paths, and unknown settings;
6. restarts and checks qBittorrent;
7. atomically replaces and restarts the application, rolling back on failure.

The deployment template does not configure global, alternative, or per-torrent speed limits. Sequential download and first/last-piece priority are enabled through qBittorrent's API for each managed torrent when it is prepared for playback.

For unattended deployment with previously saved answers:

```bash
DEPLOY_NON_INTERACTIVE=true make deploy-pi PI_HOST=mihai@192.168.50.2
```

## Method 3: precompiled GitHub release

Tagged builds publish precompiled archives at the project's [GitHub Releases page](https://github.com/mihaiflorentin88/filelist-streaming-service/releases). The release workflow builds:

- Linux `amd64`, `arm64`, and `armv7` archives;
- Windows `amd64` and macOS `amd64`/`arm64` archives;
- the unsigned `FileListTV-<version>.wgt` Tizen package;
- `SHA256SUMS`, CycloneDX/SPDX SBOMs, and build-provenance attestations.

Download the archive matching the server architecture and verify it before extraction. Replace `<version>` and `<target>` with an existing tagged release, for example `linux-arm64` for a 64-bit Raspberry Pi:

```bash
curl -fLO https://github.com/mihaiflorentin88/filelist-streaming-service/releases/download/v<version>/filelist-streaming-<version>-<target>.tar.gz
curl -fLO https://github.com/mihaiflorentin88/filelist-streaming-service/releases/download/v<version>/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf filelist-streaming-<version>-<target>.tar.gz
```

Install the binary and use the repository's reviewed service/config files:

```bash
sudo install -m 0755 filelist-streaming /usr/local/bin/filelist-streaming
sudo install -m 0644 deploy/systemd/filelist-streaming.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/filelist-streaming.logrotate /etc/logrotate.d/filelist-streaming
sudo systemctl daemon-reload
sudo systemctl enable --now filelist-streaming.service
```

If your storage root is not `/srv/filelist-downloads`, adjust the service unit's read-only media path before enabling it. Complete the users, groups, directories, qBittorrent config, and ownership steps in the manual section below. The release server binary already embeds the compiled browser UI; Node.js is not required.

## Method 4: fully manual Linux installation

The following outline uses systemd. Adapt package commands and paths for the distribution.

1. Install qBittorrent-nox, FFmpeg/ffprobe, CA certificates, Python 3, and logrotate. Install the Go version declared in `go.mod` only if building from source.
2. Create a `qbittorrent` group and service account, plus a `filelist-streaming` service account. Add the application account to the qBittorrent group.
3. Create `/var/lib/filelist-streaming/data`, the download root, and its incomplete subdirectory with group traverse/read access.
4. Build with `make build`, or install a verified release binary.
5. Copy and review the systemd and logrotate files in `deploy/systemd/`. Replace `/srv/filelist-downloads` in both service units when using another disk.
6. Bind the qBittorrent Web UI to `127.0.0.1:8080`, set its save path to the chosen download root, and keep authentication enabled.
7. Stop qBittorrent and make a protected backup of its actual config before changing it.
8. Merge the repository's credential-free streaming template instead of replacing the config:

```bash
sudo systemctl stop qbittorrent-nox.service
sudo install -d -m 0700 /var/backups/filelist-streaming/qbittorrent
sudo install -m 0600 /var/lib/qbittorrent/.config/qBittorrent/qBittorrent.conf \
  /var/backups/filelist-streaming/qbittorrent/qBittorrent.conf.manual-backup
sudo python3 tools/qbittorrent_config.py \
  --input /var/lib/qbittorrent/.config/qBittorrent/qBittorrent.conf \
  --output /tmp/qBittorrent.conf.merged \
  --template deploy/qbittorrent/qBittorrent.streaming.conf \
  --temp-path /mnt/sda1/torrent/.incomplete
sudo install --owner=qbittorrent --group=qbittorrent --mode=0640 \
  /tmp/qBittorrent.conf.merged /var/lib/qbittorrent/.config/qBittorrent/qBittorrent.conf
sudo systemctl start qbittorrent-nox.service
```

9. Enable the services and verify them:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qbittorrent-nox.service filelist-streaming.service
systemctl is-active qbittorrent-nox.service filelist-streaming.service
curl -fsS http://127.0.0.1:8097/api/v1/system/info
```

## Initial configuration

Open `http://SERVER_LAN_IP:8097` from the private LAN. In Settings, configure:

- FileList URL, username, and passkey;
- qBittorrent Web UI URL, username, password, and the same server-visible download root;
- optional TMDB and SubDL credentials;
- English preferred audio, Romanian preferred subtitles, and English subtitle fallback;
- FFmpeg/ffprobe and cache paths when defaults differ.

Save first, then run the individual FileList, qBittorrent, storage, TMDB, and SubDL tests. Do not expose port 8097 or qBittorrent's Web UI to the public internet.

## Samsung Tizen application

You can use the unsigned WGT from a tagged GitHub release or build it from source with the pinned frontend container:

```bash
make frontend
make validate-tizen-wgt
```

The local artifact is `clients/tizen/.build/artifacts/FileListTV-<version>.wgt`. Apps2Samsung signs it for the selected TV during installation. Follow [TIZEN.md](TIZEN.md) for Developer Mode, TV pairing, Apps2Samsung installation, target-version compatibility, and physical-device checks. The TV and server must be on the same private LAN; enter the full server address, including `http://` and port `8097`, on first launch.

## Upgrade and rollback checklist

Before any upgrade, back up:

- `/var/lib/filelist-streaming/data/settings.json`;
- `/var/lib/filelist-streaming/data/filelist.db` and its WAL/SHM files while the service is stopped, or use a SQLite-safe backup;
- the actual qBittorrent config;
- any custom systemd overrides.

After upgrading, confirm server version, both services, storage access, qBittorrent dependency status, one completed local stream, one incomplete HTTP Range stream, Downloads reconciliation, and Tizen launch/navigation. Routine scripted deployment automatically rolls back the application binary and qBittorrent config if startup fails; a manual or release installation requires restoring the backups yourself.
