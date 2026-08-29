# Installation and upgrades

This guide covers Docker Compose, a fresh scripted server, routine scripted deployment, installation from a precompiled GitHub release, a fully manual setup, initial browser configuration, and Samsung Tizen installation. The server is intended for a trusted private LAN and has no client login.

## Choose an installation method

| Method | Best for | Builds on the target? | Installs packages? |
| --- | --- | --- | --- |
| Docker Compose | One-command, isolated server + qBittorrent on Linux/ARM64 | In containers | Only inside images |
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

### Where to obtain credentials and API keys

Only FileList and qBittorrent are required for catalog downloads. TMDB and SubDL are optional but recommended for artwork/metadata and downloadable subtitles. Obtain each value from its own official service:

| Configuration | Where to get it | Value to use |
| --- | --- | --- |
| `FILELIST_USERNAME` | Sign in at [FileList](https://filelist.io), then open your profile/account page. | The username displayed on your profile. |
| `FILELIST_PASSKEY` | On the same FileList profile/account page, locate your personal passkey. | Copy the passkey, **not** your account password. It authorizes tracker searches and `.torrent` retrieval, so treat it like a password. |
| qBittorrent Web UI credentials (external engines only) | For an existing external qBittorrent instance, open **Tools → Options → Web UI → Authentication**. | The bundled Docker sidecar needs none: it publishes its Web UI to the household LAN without credentials (ADR-0005). For an external engine, enter the username and password in browser Settings; the application uses qBittorrent's session login, not its newer API-key field. See the [official WebUI authentication documentation](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-4.1%29#authentication). |
| `TMDB_API_KEY` | Create a free [TMDB account](https://www.themoviedb.org/signup), then open [Account Settings → API](https://www.themoviedb.org/settings/api), request API access, and accept TMDB's terms. | Either the v3 API key or the v4 API Read Access Token; the server detects the token form automatically. TMDB documents the process in [Getting Started](https://developer.themoviedb.org/v4/docs/getting-started). |
| `SUBDL_API_KEY` | Create or sign in to a [SubDL account](https://subdl.com), then open the [SubDL API panel](https://subdl.com/panel/api). | Generate or copy the key shown under **Your API keys and usage**. Keep `SUBDL_URL=https://api.subdl.com`. |

FFmpeg/ffprobe, SQLite, the Tizen client, and local server discovery do not require API keys. Docker supplies FFmpeg/ffprobe inside the server image, and SQLite is embedded in the Go server. Provider keys can be left blank when that optional integration is not wanted; the related metadata or online-subtitle feature will remain unavailable.

Keep `.env.docker` at mode `0600`, never paste its values into an issue or build log, and never commit it. The checked-in `.env.docker.example` contains placeholders and acquisition links only.

## Method 1: Docker Compose

This method compiles the browser and Go server inside a multi-stage image and runs it with the official multi-architecture qBittorrent image. It does not install Node, Go, FFmpeg, qBittorrent, or Python on the host. Docker and the Compose plugin must already be installed.

Create the private environment file interactively (answers are retained and offered as defaults next time):

```bash
make docker-configure
```

Or configure it manually:

```bash
cp .env.docker.example .env.docker
chmod 0600 .env.docker
```

At minimum, replace `APP_DATA_DIR`, `QBITTORRENT_CONFIG_DIR`, and `DOWNLOADS_DIR`. All three paths must be absolute. `DOWNLOADS_DIR` must point to the large disk; incomplete pieces are stored at its `.incomplete` child. The example documents every supported port, bind address, identity, provider, cache, language, buffer, quota, and worker setting. The [Docker environment reference](DOCKER_ENV.md) lists the meaning, default, and accepted format of every `.env.docker` variable and how to migrate keys removed by earlier releases.

Start and verify everything with one command:

```bash
make docker-up
```

`make docker-up` validates the private env file, creates the host directories, compiles the web client and server from source, builds the qBittorrent wrapper, waits for healthy containers, verifies credential-free qBittorrent WebUI access, verifies shared storage, checks the streaming storage settings, and prints the localhost and detected LAN URLs for the web app. Useful follow-up commands are:

```bash
make docker-check
make docker-urls
make docker-logs
make docker-down
```

The server is published on `SERVER_BIND_IP:SERVER_HOST_PORT`. The qBittorrent sidecar's Web UI is published to the LAN by default (`QBITTORRENT_WEBUI_BIND_IP`, default `0.0.0.0`) and answers without credentials from any household address; torrent TCP/UDP defaults to all interfaces. Everything here assumes a trusted private LAN: never port-forward the server or the Web UIs to the public internet, and set `QBITTORRENT_WEBUI_BIND_IP=127.0.0.1` if the qBittorrent Web UI should stay local.

### Docker qBittorrent sidecar policy (no-auth LAN posture)

On every container start, the wrapper creates a new mode-`0600` timestamped copy of the existing config in `QBITTORRENT_CONFIG_DIR/filelist-backups/` before merging policy. The merge changes only temporary-path enablement/path, preallocation, incomplete-extension behavior, and the WebUI authentication posture. It never sets a global, alternative, or persistent per-torrent speed limit.

- The sidecar runs without Web UI credentials. Every start enforces a trusted-network authentication bypass (`0.0.0.0/0`) plus a benign `admin` username — merged into the config file before boot and re-asserted through the Web API after it — so no password is ever generated, stored, or rotated. Even an older config seeded by a previous release becomes credential-free on the next start.
- Because the bypass is unconditional, the Web UI is reachable from the household LAN only. Keep it off the public internet; `make docker-check` fails if the Web UI ever demands credentials again.
- An external qBittorrent that keeps authentication enabled remains fully supported: point the server at its URL and provide the username and password in browser Settings (or the `FILELIST_STREAMING_QBITTORRENT_*` environment variables). The credential-free error handling applies only to the bundled sidecar posture.

Application values supplied through `.env.docker` are authoritative and appear read-only in browser Settings. They are not copied into `settings.json`. Keep `.env.docker` private; Git ignores it, and Docker build contexts exclude all local env files.

### Docker progressive-stream test

After FileList is configured, use a disposable release that is not already managed:

```bash
make docker-smoke-stream RELEASE_ID=<disposable-release-id>
```

The smoke test confirms qBittorrent sequential download and first/last-piece priority, reads startup and tail HTTP ranges while incomplete, runs ffprobe, and always asks the server to delete the test torrent and files afterward. It temporarily limits only that disposable test torrent to 2 MiB/s so it cannot finish before the incomplete-stream assertions; it resets that per-torrent limit before deletion. Production torrents and qBittorrent's global limits remain unlimited.

### Docker Desktop on Windows

Docker Desktop with the WSL 2 engine is the recommended Windows setup. It keeps the same tested one-command workflow as Linux and does not install Go, Node.js, qBittorrent, FFmpeg, or Python into Windows. Docker builds those dependencies inside containers.

#### Recommended: WSL 2 terminal

1. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) and select the WSL 2 backend during setup. Docker's official requirements describe the supported Windows/WSL versions and virtualization requirements.
2. In Docker Desktop, open **Settings → Resources → WSL integration** and enable the Linux distribution where this repository will be used.
3. Open that WSL distribution and verify the existing installation:

   ```bash
   docker version
   docker compose version
   ```

4. Clone or open this repository from WSL. A checkout under the WSL filesystem, such as `~/src/filelist-streaming-service`, gives substantially better build performance than a source checkout under `/mnt/c`.
5. Run the remembered interactive configuration:

   ```bash
   make docker-configure
   ```

6. Use absolute WSL paths for container bind mounts. Put `DOWNLOADS_DIR` on the large disk. For example, a Windows `D:` drive mounted by WSL is normally represented as `/mnt/d`:

   ```dotenv
   APP_DATA_DIR=/mnt/c/filelist-streaming/data
   QBITTORRENT_CONFIG_DIR=/mnt/c/filelist-streaming/qbittorrent
   DOWNLOADS_DIR=/mnt/d/filelist-downloads
   SERVER_BIND_IP=0.0.0.0
   SERVER_HOST_PORT=8097
   ```

7. Start, compile, wait for health, verify, and print the localhost plus detected LAN URLs:

   ```bash
   make docker-up
   ```

8. Open `http://localhost:8097` on the PC. Use one of the printed non-localhost addresses, such as `http://192.168.1.25:8097`, from the Tizen TV or another LAN device. If Windows prompts for firewall access, allow the server port only on **Private networks**. Do not expose it on Public networks or port-forward it from the router.
9. Reprint addresses, inspect logs, verify, or stop the stack with:

   ```bash
   make docker-urls
   make docker-logs
   make docker-check
   make docker-down
   ```

If Docker Desktop reports that a bind path is not shared, add only the selected application/config/download directories under Docker Desktop file-sharing settings. Do not share an entire drive unless that is intentional. Keep `.env.docker` inside the repository private; its values are remembered for future deployments and Git ignores it.

#### Native PowerShell without `make`

The WSL method above is preferred because it performs all validation and prints every usable address. A native PowerShell deployment can use Compose directly:

```powershell
Copy-Item .env.docker.example .env.docker
notepad .env.docker
```

In `.env.docker`, use forward-slash absolute Windows paths. For example:

```dotenv
APP_DATA_DIR=C:/filelist-streaming/data
QBITTORRENT_CONFIG_DIR=C:/filelist-streaming/qbittorrent
DOWNLOADS_DIR=D:/filelist-downloads
SERVER_BIND_IP=0.0.0.0
SERVER_HOST_PORT=8097
```

Create the directories and start the stack:

```powershell
New-Item -ItemType Directory -Force C:\filelist-streaming\data
New-Item -ItemType Directory -Force C:\filelist-streaming\qbittorrent
New-Item -ItemType Directory -Force D:\filelist-downloads\.incomplete
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up -d --build --wait
docker compose --env-file .env.docker ps
Invoke-RestMethod http://localhost:8097/api/v1/system/info
```

Open `http://localhost:8097`. Obtain the PC's private IPv4 address with `Get-NetIPAddress -AddressFamily IPv4`, then use `http://PRIVATE_IP:8097` from the TV. Allow inbound TCP `8097` only on the Windows Private network profile when LAN clients need it. qBittorrent's Web UI is bound to all interfaces by default and answers without credentials from the LAN; set `QBITTORRENT_WEBUI_BIND_IP=127.0.0.1` in `.env.docker` to keep it local.

For upgrades, keep `.env.docker` and the three mounted directories, pull or unpack the new repository version, and run the same Compose `up -d --build --wait` command. Each qBittorrent container start makes a new config backup before applying the sanitized streaming storage policy. Stop without deleting mounted media/configuration by running:

```powershell
docker compose --env-file .env.docker down
```

## Method 2: fresh-server bootstrap

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

## Method 3: routine Raspberry Pi deployment

Use this after the server and qBittorrent already exist. From a development checkout:

```bash
make deploy-pi PI_HOST=user@server.lan
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
DEPLOY_NON_INTERACTIVE=true make deploy-pi PI_HOST=user@server.lan
```

## Method 4: precompiled GitHub release

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

## Method 5: fully manual Linux installation

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
- qBittorrent Web UI URL and the same server-visible download root; the Docker sidecar has no Web UI credentials, while an external engine also takes its username and password;
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

The local artifact is `clients/tizen/.build/artifacts/FileListTV-<version>.wgt`. Apps2Samsung signs it for the selected TV during installation. Follow [TIZEN.md](TIZEN.md) for Developer Mode, TV pairing, Apps2Samsung installation, target-version compatibility, and physical-device checks. The TV and server must be on the same private LAN. With no saved server, first launch scans at most the TV's local `/24` on port `8097` and any port already present in the manual field. Select a discovered server to verify and save it, or choose **Manual address** for a hostname, HTTPS endpoint, or custom port. A failed connection never replaces the last working saved address.

## Upgrade and rollback checklist

Before any upgrade, back up:

- `/var/lib/filelist-streaming/data/settings.json`;
- `/var/lib/filelist-streaming/data/filelist.db` and its WAL/SHM files while the service is stopped, or use a SQLite-safe backup;
- the actual qBittorrent config;
- any custom systemd overrides.

After upgrading, confirm server version, both services, storage access, qBittorrent dependency status, one completed local stream, one incomplete HTTP Range stream, Downloads reconciliation, and Tizen launch/navigation. Routine scripted deployment automatically rolls back the application binary and qBittorrent config if startup fails; a manual or release installation requires restoring the backups yourself.
