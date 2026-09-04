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
| `filelist-streaming-windows-arm64.exe` | Windows, 64-bit ARM |

Releases also contain `SHA256SUMS` (`sha256sum -c SHA256SUMS --ignore-missing`), SBOMs, and the unsigned Tizen `FileListTV-<version>.wgt`.

The archives follow the `filelist-streaming-<os>-<arch>[.exe]` naming scheme. Every binary except `filelist-streaming-linux-armv7` contains both the desktop app and the headless server. macOS releases additionally ship a universal (Apple Silicon + Intel) `FileList Streaming.app` bundle; `filelist-streaming-linux-armv7` is a pure headless build with the GUI excluded.

## First run

One binary runs two modes:

- Launch it without arguments (double-click, or run it from a terminal) to open the desktop app: a window plus a system-tray icon. See [Desktop app](#desktop-app) below.
- Run `filelist-streaming serve` for the headless server. It creates its `data/` folder next to the executable — or wherever `--data-dir` points:

```sh
./filelist-streaming serve           # Linux / macOS
.\filelist-streaming.exe serve       # Windows PowerShell
```

The first headless start asks three questions:

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

**Linux (amd64, arm64, armv7).** Headless services without a terminal skip the prompts: set `FILELIST_STREAMING_DOWNLOAD_ROOT`, `FILELIST_STREAMING_FILE_LIST_USERNAME`, and `FILELIST_STREAMING_FILE_LIST_PASSKEY` instead.

**macOS (Apple Silicon, Intel).** If a browser downloaded the binary, macOS may block it once. Remove the quarantine with `xattr -d com.apple.quarantine filelist-streaming-darwin-*` or allow it under System Settings → Privacy & Security.

**Windows (amd64).** SmartScreen warns about the unsigned binary on first run: choose **More info → Run anyway**.

## Desktop app

Every binary except `filelist-streaming-linux-armv7` includes the desktop app: a native window plus a system-tray icon, with the HTTP server running inside the same process. Launch the binary without arguments to open it.

### First launch

On the first launch the window opens on setup: the Settings page shows a banner with the required settings still missing (download root, FileList username, passkey). Saving a complete configuration auto-starts the server — no extra step. Afterwards the Server page shows the status with Start/Stop controls, and closing the window hides it to the tray; quit from the tray menu (*Quit*, or Cmd+Q on macOS).

### Autostart

Toggle **Start at login** on the GUI's Server page. It starts minimized to the tray. The entry lives at:

| OS | Entry |
| --- | --- |
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `FileList Streaming` |
| macOS | `~/Library/LaunchAgents/com.filelist-streaming.plist` |
| Linux | `~/.config/autostart/filelist-streaming.desktop` (XDG autostart) |

The OS artifact is the source of truth: removing it disables autostart, and the toggle always reflects the actual OS state.

### Data directory

The desktop app does not use `data/` next to the binary. Defaults:

| OS | Default data directory |
| --- | --- |
| Linux | `/var/lib/filelist-streaming-service` when it exists and is writable, otherwise `~/.local/share/filelist-streaming` |
| Windows | `%APPDATA%\FileList Streaming` |
| macOS | `~/Library/Application Support/FileList Streaming` |

Change the location from the GUI (Server page → data folder → *Change…*); the contents move and the new path is recorded in a `data.location` pointer file next to the executable. See [CONFIGURATION.md](CONFIGURATION.md) for the full resolution order and relocation rules.

### Linux runtime packages

The Linux binaries are dynamically linked against GTK 3 and WebKitGTK 4.1 and need those runtime packages installed — including for `serve`, because the dynamic linker loads them even when no window opens. Install the same packages the server bootstrap uses:

| Distro | Packages |
| --- | --- |
| Debian/Ubuntu/Raspberry Pi OS (`apt`) | `libgtk-3-0 libwebkit2gtk-4.1-0 libayatana-appindicator3-1` |
| Fedora/RHEL (`dnf`) | `gtk3 webkit2gtk4.1 libayatana-appindicator-gtk3` |
| Arch (`pacman`) | `gtk3 webkit2gtk-4.1 libayatana-appindicator` |
| openSUSE (`zypper`) | `gtk3 webkit2gtk-4_1 libayatana-appindicator3-1` |

`deploy/bootstrap-server.sh` installs these automatically on a fresh server.

### macOS Gatekeeper and Windows SmartScreen

The app bundles are ad-hoc signed but not notarized, so both operating systems warn once:

- **macOS:** if opening the app is blocked, either clear the quarantine flag once (`xattr -cr "/Applications/FileList Streaming.app"`) or right-click the app and choose **Open**, then confirm in the dialog.
- **Windows:** SmartScreen shows **Windows protected your PC** on first run — choose **More info → Run anyway**.

The desktop app renders through the platform webview: WKWebView on macOS, WebView2 on Windows (preinstalled on Windows 11 and current Windows 10; on older systems install the [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)), WebKitGTK on Linux.

## Run as a service (Linux, optional)

For an always-on server, install the reviewed systemd and logrotate files from `deploy/systemd/`:

```bash
sudo install -m 0755 filelist-streaming /usr/local/bin/filelist-streaming
sudo install -m 0644 deploy/systemd/filelist-streaming.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/filelist-streaming.logrotate /etc/logrotate.d/filelist-streaming
sudo systemctl daemon-reload
sudo systemctl enable --now filelist-streaming.service
```

Adjust the download root in the unit file first if it is not `/srv/filelist-downloads`. The unit runs the binary in headless mode — `filelist-streaming serve --data-dir /var/lib/filelist-streaming/data` — so a bare launch on the server never opens a GUI. Because services run without a terminal, provide the required settings through environment variables (see the headless note above) or a prepared settings file.

### Upgrading

Older service files ran a bare `ExecStart=/usr/local/bin/filelist-streaming` with no `serve` argument. Copying a new binary over the old one onto such a unit breaks the service: with no arguments the binary now attempts the desktop app, and on a headless server it prints the `serve` direction and exits 1 — which `Restart=on-failure` turns into a permanent restart loop. Re-run `make deploy-pi` (it stages the corrected unit), or fix the unit by hand:

```bash
sudo systemctl edit --full filelist-streaming.service
# ExecStart=/usr/local/bin/filelist-streaming serve --data-dir /var/lib/filelist-streaming/data
sudo systemctl daemon-reload
sudo systemctl restart filelist-streaming
```

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
