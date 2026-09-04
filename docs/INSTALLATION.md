# Installation

## Requirements

| Requirement | Where to get it | Used for |
| --- | --- | --- |
| FileList account | [filelist.io](https://filelist.io) — username and passkey from your profile page | Browsing and downloading. The passkey authorizes the tracker; treat it like a password. |
| FFmpeg and ffprobe (optional) | macOS: `brew install ffmpeg` · Debian/Ubuntu/Raspberry Pi OS: `sudo apt install ffmpeg` · Fedora: `sudo dnf install ffmpeg` · Windows: `winget install Gyan.FFmpeg` or [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) | Embedded subtitle probing/extraction and browser audio fallback. Detected automatically on PATH at first start. |
| TMDB API key (optional) | [themoviedb.org → Settings → API](https://www.themoviedb.org/settings/api) (free account) | Artwork and metadata. |
| SubDL API key (optional) | [subdl.com API panel](https://subdl.com/panel/api) (free account) | Extra subtitles. |
| qBittorrent (optional) | [qbittorrent.org](https://www.qbittorrent.org) | Only if you switch the download engine from the built-in one to qBittorrent in Settings. |

The server listens on `8097` (web) and `42069` (torrent peers). Both are configurable in Settings.

## Download

Binaries for every supported platform are on the [releases page](https://github.com/mihaiflorentin88/filelist-streaming-service/releases). Each release ships an archive per platform; the binary is inside.

| Binary | Platform |
| --- | --- |
| `filelist-streaming-linux-amd64` | Linux, 64-bit x86 |
| `filelist-streaming-linux-arm64` | Linux, 64-bit ARM (Raspberry Pi 4/5) |
| `filelist-streaming-linux-armv7` | Linux, 32-bit ARM |
| `filelist-streaming-darwin-arm64` | Mac with Apple Silicon |
| `filelist-streaming-darwin-amd64` | Intel Mac |
| `filelist-streaming-windows-amd64.exe` | Windows, 64-bit x86 |

Releases also contain `SHA256SUMS` (`sha256sum -c SHA256SUMS --ignore-missing`), SBOMs, and the unsigned Tizen `FileListTV-<version>.wgt`.

## First run (every operating system)

Run the binary from a terminal, in the directory where you want its data:

```sh
./filelist-streaming           # Linux / macOS
.\filelist-streaming.exe       # Windows PowerShell
```

The first start asks three questions:

```text
Download root [/srv/filelist-downloads]: /home/you/media
FileList username: you
FileList passkey:
```

- **Download root** — where downloads are stored; must be writable. Enter accepts the default.
- **FileList username / passkey** — from your filelist.io profile; the passkey is typed hidden.
- Answers are saved to `data/settings.json` (mode `0600`), and ffmpeg/ffprobe are auto-detected from PATH.

Then open `http://localhost:8097`. Press `Ctrl+C` to stop the server.

### Platform notes

**Linux (amd64, arm64, armv7).** Nothing extra to configure. Headless services without a terminal skip the prompts: set `FILELIST_STREAMING_DOWNLOAD_ROOT`, `FILELIST_STREAMING_FILE_LIST_USERNAME`, and `FILELIST_STREAMING_FILE_LIST_PASSKEY` instead.

**macOS (Apple Silicon, Intel).** If a browser downloaded the binary, macOS may block it once. Remove the quarantine with `xattr -d com.apple.quarantine filelist-streaming-darwin-*` or allow it under System Settings → Privacy & Security.

**Windows (amd64).** SmartScreen warns about the unsigned binary on first run: choose **More info → Run anyway**.

## Run as a service (Linux, optional)

For an always-on server, install the reviewed systemd and logrotate files from `deploy/systemd/`:

```bash
sudo install -m 0755 filelist-streaming /usr/local/bin/filelist-streaming
sudo install -m 0644 deploy/systemd/filelist-streaming.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/filelist-streaming.logrotate /etc/logrotate.d/filelist-streaming
sudo systemctl daemon-reload
sudo systemctl enable --now filelist-streaming.service
```

Adjust the download root in the unit file first if it is not `/srv/filelist-downloads`. Because services run without a terminal, provide the required settings through environment variables (see the headless note above) or a prepared settings file.

### Fresh-server bootstrap

On a new dedicated Linux server, `deploy/bootstrap-server.sh` installs packages, creates service users, verifies and installs the exact Go toolchain, builds the server, and enables the services:

```bash
git clone https://github.com/mihaiflorentin88/filelist-streaming-service.git
cd filelist-streaming-service
sudo sh deploy/bootstrap-server.sh --confirm-server-install --download-root=/mnt/sda1/torrent
```

Preview first with `--dry-run`. Supports `apt`, `dnf`, `pacman`, and `zypper`. Never run it on a workstation.

## Raspberry Pi deployment

To update an existing ARM64 Raspberry Pi from a development machine:

```bash
make deploy-pi PI_HOST=user@server.lan
```

The command cross-compiles the server, stages binary and service files, creates protected configuration backups, and rolls back automatically if startup fails. Answers are remembered in ignored `deploy/.deploy.local.conf`.

## qBittorrent engine (optional)

The built-in engine is the default and needs nothing external. To use qBittorrent instead: install it from [qbittorrent.org](https://www.qbittorrent.org), enable its Web UI with authentication (Tools → Options → Web UI), then switch **Download engine** in Settings → Storage and fill in the URL and credentials.

## Configuration and troubleshooting

- Settings reference: [CONFIGURATION.md](CONFIGURATION.md). Usage and playback: [USER_GUIDE.md](USER_GUIDE.md).
- Every provider field in browser Settings has a **?** help button with links to the official source of each credential and dependency.

## Upgrade and rollback

Back up before upgrading:

- `data/settings.json`
- `data/filelist.db` (and its WAL/SHM files, or use a SQLite-safe backup while the server is stopped)
- any custom systemd overrides

Replace the binary and restart; settings and catalog survive. On a Raspberry Pi, `make deploy-pi` rolls back automatically when startup fails.

## Samsung Tizen application

Use the unsigned `FileListTV-<version>.wgt` from a tagged release, or build it with `make frontend` and `make validate-tizen-wgt`. The TV client runs on Samsung Tizen 5.0 and newer. See [TIZEN.md](TIZEN.md) for Developer Mode, TV pairing, and Apps2Samsung installation. The TV and server must share the same private LAN.
