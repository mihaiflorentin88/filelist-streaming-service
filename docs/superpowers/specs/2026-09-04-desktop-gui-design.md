# Desktop GUI Design (Wails v3)

Date: 2026-09-04
Status: Approved design, pending implementation plan

## Summary

The server gains a desktop GUI while keeping every existing headless behavior.
One binary per platform/architecture runs both modes: launched without
arguments it attempts to open the GUI (window plus tray icon) and starts the
embedded HTTP server; headless runs are explicit via the cobra CLI
(`filelist-streaming serve`), with today's semantics unchanged. The framework
is Wails v3 (Go + native webview), chosen for its built-in cross-platform
system tray, embedded assets, and the ability to reuse the existing Preact
settings UI instead of rebuilding it.

## Goals

- Bare launch on Windows/macOS/Linux (amd64 + arm64) opens a GUI that
  auto-starts the server when required configuration is complete.
- GUI configures everything the webapp settings page configures, grouped by
  the existing categories (Tracker, Storage, Playback, Server, Maintenance,
  Test).
- Server start/stop and autostart-on-boot live on the GUI's main page.
- A status indicator is visible from every GUI page (header pill) and
  system-wide (tray icon state).
- Close-to-tray always; `--minimized` starts hidden in the tray.
- Autostart on boot per OS (Windows registry, macOS LaunchAgent, Linux XDG);
  autostarted launches start minimized to tray.
- Binary icon derived from `clients/tizen/icon.png` on every platform.
- `make deploy-pi` keeps working unchanged in interface; headless `serve`
  behavior unchanged.
- Everything required to run is embedded in the binary: web UI, GUI assets,
  icons. User data (settings, database, logs, artwork) stays on disk.

## Non-goals

- Mobile targets, auto-update, multi-instance coordination beyond
  second-launch focus, remote GUI administration, GUI on headless servers,
  in-GUI playback (Downloads hands off to the web player in the browser).

## Decisions

| Decision | Choice |
| --- | --- |
| GUI framework | Wails v3 (pinned to the beta current at implementation start; desktop API declared stable) |
| Linux webview stack | GTK3 + WebKitGTK 4.1 (`-tags gtk3`) for widest distro compat (Ubuntu 22.04, Debian 12, Pi OS); revisit when v3.1 removes the legacy tag |
| Settings screens | Reuse the exported `Settings` Preact component (`web/settings.tsx`) inside the GUI window |
| Artifacts | One binary per platform/arch: `filelist-streaming-<os>-<arch>`, no gui/headless split; `linux-armv7` stays the pure headless exception |
| Data directory | `data/` next to the binary by default; user-changeable in the GUI with automatic data migration |
| CLI framework | cobra (`spf13/cobra`) |

## Architecture

One process per launch. The GUI and the HTTP server share the process; the
server only initializes when started.

```
cmd/server/main.go           cobra root; bare = GUI, subcommands
internal/gui/                Wails app: window, tray, bindings
internal/gui/supervisor.go   server lifecycle state machine
internal/gui/bindings.go     LoadSettings/SaveSettings/SettingsSchema/Autostart/DataDir
internal/platform/autostart/ autostart_{windows,darwin,linux}.go (+ tests)
desktop/                     Preact GUI shell app (new); dist embedded via go:embed
web/                         existing webapp; Settings component imported by desktop/
```

### Supervisor

`internal/gui/supervisor.go` owns server lifecycle behind a small interface so
it is testable without Wails:

- States: `stopped`, `starting`, `running`, `stopping`, `failed(error)`.
- `Start()`: refuses when `settings.MissingRequired()` is non-empty (returns
  the missing keys; the GUI shows setup instead of a failed state); otherwise
  `composition.New(log)` + `ListenAndServe` on a goroutine.
- `Stop()`: `Server.Shutdown` (15 s timeout) + `App.Close()`.
- `Restart()`: Stop then Start (used after restart-required settings change).
- Transitions are serialized (singleflight); every transition emits an event
  to the window (Wails Emit) and updates the tray icon/menu. The state
  machine is the single source of truth for the status pill, tray, buttons.

`App.Close()` currently closes engine + repository; the server shutdown path
moves into the supervisor (today's `main.go` signal handling stays in `serve`).

### Single instance

A lock file in the data dir. A second launch detects the lock and performs a
best-effort "show window" notification to the running instance (loopback
mechanism chosen in the plan), then exits. If notification fails it exits
quietly; a second server never starts.

## CLI (cobra)

```
filelist-streaming                 attempts the GUI; with no display available
                                   it exits with an error directing to
                                   `filelist-streaming serve`
filelist-streaming serve           headless server; today's main.go semantics
                                   including the interactive first-run prompt
filelist-streaming gui [--minimized] [--data-dir DIR]
filelist-streaming serve [--data-dir DIR]
filelist-streaming --version
```

`--minimized` opens no window (tray only). A `--minimized` launch with
incomplete configuration still opens the window on setup — minimized-to-tray
only applies once the server can run.

## Data directory

Uniform resolution for GUI and serve:

1. `--data-dir` flag (absolute or CWD-relative),
2. `data.location` file next to the executable (one absolute path; written
   only after a GUI relocation),
3. `data/` next to the executable (default).

`FILELIST_STREAMING_SETTINGS_PATH` keeps its existing meaning (selects the
settings file itself) and wins for that one file when set.

**Relocation (GUI).** The Server page details row shows the effective data
path with *Change…* and *Open* buttons. Changing it:

1. Requires the server stopped; a running server is stopped first and its
   prior state remembered.
2. Target must not exist or must be empty; otherwise the change is refused
   with a clear error (never merges directories).
3. Moves all contents (settings.json, database, logs/, artwork/, engine
   session files). Same volume: `os.Rename`. Cross volume: copy, verify
   (size + SHA-256 per file), then delete source.
4. Writes `data.location` atomically, then restarts the server if it was
   running.
5. Any failure rolls back (source untouched) and surfaces the error; nothing
   is deleted before verification passes.

**macOS .app:** the binary lives inside the bundle, which is not a data home.
The .app wrapper passes `--data-dir` pointing beside the .app (fallback
`~/Library/Application Support/FileListStreaming` when unwritable). Raw
macOS binary and Windows/Linux binaries use binary-adjacent `data/`.

## Settings transport

The webapp loads `/settings` + `/settings/schema` and saves via the storage
PUT (`web/src.tsx:559,631`). The GUI reuses the same `Settings` component with
a transport that works while the server is stopped:

- Bindings `LoadSettings`, `SaveSettings`, `SettingsSchema` call
  `config.Store` and the same validation code as the HTTP PUT handlers
  (validation extracted to a shared function; not duplicated).
- With the server stopped, provider tests (Test tab) and Maintenance actions
  render a "start the server to run tests" state instead of failing.
- With the server running, the same page talks to `http://127.0.0.1:<port>`
  over HTTP like the browser does.
- Saves that change restart-required fields (listener, download engine, job
  limits) show an inline "restart to apply" action that calls
  `supervisor.Restart()`.
- A save that completes all required settings auto-starts the server. This is
  the GUI form of "starts automatically if all required configuration is set".

## GUI shell

Window 1100×720, minimum 960×600. Extends the existing design language —
`web/style.css` tokens (`--panel #101c24`, `--teal #59d6ad`, ink `#071014`,
system font stack) — so desktop, web, and TV read as one product. Sidebar
navigation: **Server**, **Downloads**, **Jobs**, **Settings** (same sidebar
idiom as the webapp).

**Header (persistent):** app name + status pill — colored dot (running teal,
stopped gray, failed red) + label + address when running. Visible on every
page; satisfies "always displays the server status wherever the user is".

**Server page (landing):**

- Status card (the page's one bold element): large status dot, state line
  (`Running on http://…:8097` / `Stopped` / `Failed — <error>`), one
  contextual button (Start server / Stop server, disabled while
  transitioning), secondary *Open web UI*.
- Autostart card: *Start at login* toggle; caption states it starts minimized
  to the tray. Toggle state is read back from the OS, never from memory.
- Details row: version, settings file path, data folder (with Change…/Open),
  logs folder (reveal in file manager).

**Settings page:** the reused `Settings` component — same tabs, sticky save
bar, help icons — wrapped with the transport above and a banner when required
settings are missing (deep-links to Tracker tab).

**Downloads page:** the webapp's downloads view, reused. The `Downloads`
component (inline in `web/src.tsx`, rendered with the props contract
`{ items, onRefresh, onPlay, onRemove, onAction }`, web/src.tsx:622) moves
to an exported `web/downloads.tsx` together with its reconcile and
scroll-anchor helpers; `src.tsx` imports it back, so the webapp behavior is
unchanged. The desktop page supplies the same plumbing against
`http://127.0.0.1:<port>`: `api.downloads()` polled every 3 s with the same
reconcile and anchor restore, transfer actions (pause / resume / retry /
delete) posted to `/downloads/{id}/{action}`, removal with confirm. *Play*
hands off to the web player by opening the matching watch URL in the
default browser — playback stays on the surfaces built for it (browser,
TV). With the server stopped the page shows a "start the server to see
downloads" empty state.

**Jobs page:** the webapp's Jobs view, reused. The `Jobs` component (inline
in `web/src.tsx`, web/src.tsx:672 — search/state/kind filters, pagination,
retry, and a detail overlay with live `job.log` streaming) moves to an
exported `web/jobs.tsx`; `src.tsx` imports it back unchanged. The desktop
page renders it against the loopback server; the webapp-only route callbacks
(`deepJobId` deep links) go unused there. With the server stopped it shows
the same "start the server" empty state as Downloads.

**Reuse boundary:** only leaf content components are shared — `Settings`,
`Events`, `CacheCoverage`, `Downloads`, and `Jobs` with their private card/row
subcomponents. The webapp's shell never crosses: no left sidebar nav, no
webapp header, no footer, no hero, no route plumbing. Extraction moves zero
shell code and the shared modules take no dependency on the webapp shell;
the webapp keeps rendering its own chrome around them, and the desktop app
wraps them in its own shell (GUI sidebar + status header) only. A vitest
guard renders each shared component and asserts the output contains no
`nav`/sidebar/header/footer elements, so a future refactor cannot leak
webapp chrome into the GUI silently.

Shared components also take the API origin as configuration instead of
building clients from `new API(location.origin)`: the webapp keeps its own
origin, while the desktop app points every shared component — including the
jobs log `EventSource` — at `http://127.0.0.1:<port>`. Without this, a
Wails webview's custom-scheme origin would silently miss the server.

Motion stays minimal and action-driven (state changes animate ≤200 ms,
ease-out; no decorative loops), per the webapp's existing restrained style.

## Tray

- Icons (embedded): teal play = running, gray = stopped, red dot badge =
  failed. Derived from `clients/tizen/icon.png` at 16/24/32 px (+@2x).
- Left-click (Windows/Linux) toggles the window; macOS uses the menu.
- Menu: *Open*, *Start server* / *Stop server* (label follows state),
  *Open web UI*, *Start at login* (checkbox, mirrors OS state), *Quit*.
- State changes rebuild the menu and swap the icon (Wails v3 practice:
  `SetMenu`, no partial updates).
- Window close hides to tray on all platforms. Real quit only via tray *Quit*
  or macOS Cmd+Q.

## Autostart

`internal/platform/autostart` mirrors the existing `diskfree_{os}.go` pattern
(`Enabled() (bool, error)`, `Enable(exePath string, args []string) error`,
`Disable() error`):

| OS | Mechanism | Entry |
| --- | --- | --- |
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `FileList Streaming` | `"…\filelist-streaming-windows-amd64.exe" --minimized --data-dir "…"` |
| macOS | `~/Library/LaunchAgents/com.filelist-streaming.plist` | `RunAtLoad=true`, no `KeepAlive`, `ProgramArguments` with `--minimized --data-dir` |
| Linux | `~/.config/autostart/filelist-streaming.desktop` | XDG autostart; `Exec=` with `--minimized --data-dir` |

The OS artifact is the source of truth: the GUI toggle calls Enable/Disable
and reflects `Enabled()` read-back. Entries pin `--data-dir` at Enable time so
launchd/XDG/registry launches do not depend on a working directory. Windows
uses `golang.org/x/sys/windows/registry` (already a `golang.org/x/sys`
consumer); Linux/macOS are plain file writes. Wayland/GNOME caveat:
appindicator support depends on the session's extension; KDE/XFCE/Windows/
macOS are first-class.

## Icons and embedding

Single master: `clients/tizen/icon.png`.

- Windows: multi-size `.ico` compiled in as `.syso` (icon + version info +
  DPI manifest) — windowsgui subsystem, no console flash.
- macOS: `.icns` in the `.app` bundle.
- Linux: hicolor PNGs (256/128/64/48/32/16) + `.desktop` file in release
  archives.
- Tray state icons: generated PNGs, `go:embed`ed.
- GUI frontend (`desktop/dist`) and web UI: `go:embed`, no runtime fetches.

Assets are generated at build time by a small script (Taskfile/Make target)
from the master PNG; tray PNGs are committed for embedding stability.

## Packaging and artifacts

Seven release artifacts; the six amd64/arm64 binaries are each GUI-capable
and headless-capable:

| Artifact | Build notes |
| --- | --- |
| `filelist-streaming-windows-amd64.exe` / `-arm64.exe` | cgo-free, `-H windowsgui`; `serve` re-attaches to the parent console via `AttachConsole` when launched from a terminal |
| `filelist-streaming-darwin-amd64` / `-arm64` (+ universal `.app` wrapper) | cgo, WKWebView; ad-hoc signed on a macOS runner |
| `filelist-streaming-linux-amd64` / `-arm64` | cgo, GTK3 + WebKitGTK 4.1; needs `webkit2gtk` runtime packages |
| `filelist-streaming-linux-armv7` | unchanged pure headless build — outside the supported GUI matrix (amd64 + arm64) |

- Linux `serve` on headless boxes requires `libwebkit2gtk-4.1-0` + GTK libs
  installed (standard packages on every distro; the dynamic linker needs them
  even when no window opens). Documented in INSTALLATION.md.
- `make build` becomes a host-native build (cgo on macOS/Linux hosts; Windows
  hosts stay cgo-free). `make build-all` produces the six artifacts via the
  Wails Docker cross toolchain (Docker already required by `make web`).
- Release workflow (`release.yml`): the `servers` matrix gains a runner per
  OS — windows builds on ubuntu (cgo-free), darwin on a macOS runner (both
  arches), linux amd64/arm64 on ubuntu via the Wails Docker cross image.
  `linux-armv7` stays a `CGO_ENABLED=0` pure headless build, outside the
  supported GUI matrix (amd64 + arm64). SBOM, checksums, attestations, and
  the publish job are unchanged.
- CI (`ci.yml` backend job): installs `libwebkit2gtk-4.1-dev libgtk-3-dev`
  before `go test` / `make build` so the cgo GUI packages compile on the
  ubuntu runner; frontend and tooling jobs unchanged.

### deploy-pi continuity

`make deploy-pi` keeps its interface and outcome:

1. `build-arm64` now cross-builds the cgo linux/arm64 single binary through
   the Wails Docker cross image (output name unchanged:
   `bin/filelist-streaming-linux-arm64`).
2. The staged unit changes `ExecStart` to
   `/usr/local/bin/filelist-streaming serve --data-dir /var/lib/filelist-streaming/data`
   — explicit `serve` (bare-run must never mean GUI on a server) and an
   explicit data dir that matches today's
   `/var/lib/filelist-streaming/data` path. WorkingDirectory, sandboxing
   (`ProtectSystem=strict`, `ReadWritePaths`), restart policy unchanged.
3. `deploy/bootstrap-server.sh` adds the GTK/WebKitGTK runtime packages to
   all four package-manager lists (apt: `libgtk-3-0 libwebkit2gtk-4.1-0
   libayatana-appindicator3-1`; dnf/pacman/zypper equivalents chosen at
   implementation). This is the fresh-server path; it already installs
   packages.
4. `deploy/pi-deploy.sh` stays package-install-free (its header contract)
   and gains a remote preflight: verify the WebKitGTK 4.1 runtime is
   present before installing the binary; abort with the exact package
   command otherwise. Same arguments, same scp/stage flow, same binary name.

Result: the Pi runs `serve` under systemd exactly as today; the binary it
receives is the same single artifact desktop users get.

### Deployment surfaces audit

| Surface | Impact |
| --- | --- |
| `release.yml` servers matrix | runner split per OS; `linux-armv7` stays pure; packaging/publish jobs unchanged |
| `ci.yml` backend | webkit2gtk/GTK dev packages installed before test and build |
| `Makefile` | `build` host-native (cgo); `build-arm64` / `build-all` via Wails Docker cross; `web`, `frontend`, `tizen-*`, `smoke-tizen-engine`, `check`, `test` unchanged |
| `deploy/systemd/filelist-streaming.service` | `ExecStart` gains `serve --data-dir /var/lib/filelist-streaming/data`; rest of the unit untouched |
| `deploy/bootstrap-server.sh` | GUI runtime packages added to all four distro lists |
| `deploy/pi-deploy.sh` | remote runtime preflight added; still install-free |
| `deploy/docker/Dockerfile.frontend` | unchanged (builds web assets only; no GUI in containers) |
| `deploy/qbittorrent/*`, logrotate config | unchanged |
| Docs | INSTALLATION (runtime deps, GUI/autostart usage), DEVELOPMENT (wails3 prereqs, cross builds), CONFIGURATION (data-dir relocation), README (GUI mention) |

## Error handling

- **Missing required settings (GUI):** no start attempt; setup banner on the
  Settings page listing the missing keys; auto-start after a completing save.
- **Port bind failure / engine start failure:** supervisor → `failed(err)`;
  status card shows the error verbatim; tray shows failed state; menu Start
  retries after the user fixes settings.
- **Autostart write failures:** surfaced as an inline error on the toggle;
  toggle state reflects actual OS state.
- **Data relocation failure:** rollback + error naming the failing path;
  original data untouched (see Data directory).
- **Missing WebView2 (old Windows):** Wails error page; INSTALLATION.md links
  the WebView2 bootstrapper.
- **Unwritable data dir at GUI startup:** error dialog naming the resolved
  path and suggesting `--data-dir` or moving the binary; no silent redirect.

## Testing

- **Go:** supervisor transitions including `failed` and event fan-out (fake
  `App`); missing-settings refusal; autostart Enable/Disable/Enabled per OS
  with injectable paths (temp HOME, real registry on Windows runners);
  data-dir resolution precedence; relocation rename path, cross-volume
  copy+verify+delete, rollback, non-empty-target refusal; cobra wiring and
  the no-display error path (bare without a display exits with guidance,
  never silently serves).
- **Frontend (vitest, `web/` conventions):** status pill states; Server page
  button/label wiring against supervisor events; autostart toggle read-back;
  stopped-server states for Test/Maintenance, Downloads, and Jobs;
  missing-settings banner; downloads and jobs page plumbing (poll, filters,
  pagination, retry, live logs) against a mocked API with a parametrized
  origin; the `web/downloads.tsx` / `web/jobs.tsx` extractions keeping the
  components' props contracts intact; and the reuse-boundary guard — each
  shared component renders no webapp nav, header, or footer.
- **Regression:** existing `make check` stays green; `serve` behavior covered
  by current tests must not change; the webapp with the re-imported
  `Downloads` component renders identically (existing webapp tests cover the
  other views; the extraction is mechanical and covered by the new
  component tests).
- **Manual per-platform checklist** (GUI specifics not unit-testable):
  tray icon states, close-to-tray, `--minimized` boot, autostart-at-login on
  each OS, `serve` console output on Windows, Pi deploy end-to-end.

## Risks

- Wails v3 is beta (RC targeted Sept 2026). Mitigation: pin the exact
  version; all Wails usage confined to `internal/gui` + `desktop/` so a
  migration touches one boundary.
- WebKitGTK legacy tag removal in v3.1 may force GTK4 later, raising the
  minimum distro; pinned beta + documented stack makes the move deliberate.
- Wayland tray support varies by session; documented as best-effort on GNOME.
- macOS Gatekeeper / Windows SmartScreen warn on unsigned binaries;
  INSTALLATION.md documents the one-time bypasses; signing workflows are a
  future addition, not part of this design.
