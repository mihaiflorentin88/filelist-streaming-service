# Portal Integration and Self-Update Design

Date: 2026-09-05
Status: Approved design, pending implementation plan

## Summary

The server gains a self-update mechanism and a server-side integration hub
for an external promotion and update service. One internal adapter talks to
the external service; the hub it feeds re-exposes everything through neutral
`/api/v1/portal/*` and `/api/v1/updates/*` endpoints and pushes changes over
the existing SSE stream. The webapp and GUI webview share one frontend; the
Tizen client gets its own surfaces. Every external feature degrades to
invisible when the upstream is unreachable or switched off. The GUI also
auto-starts the embedded server on launch, closing a gap left by the desktop
GUI implementation (the 2026-09-04 GUI spec listed auto-update as a
non-goal; this design supersedes that line).

The external platform is never named in the UI, in documentation, or in the
client-visible API surface. Internals use the neutral umbrella "portal";
promoted creatives are "promotions" in code paths.

## Goals

- Feature gating from the upstream public settings: when accounts are
  enabled, web and GUI show Login/Register and the API-key Settings field;
  when promotions are enabled and the viewer is not a donor, the left nav
  rail shows the promoted-content card; the main menu shows an Other
  Projects section from the links feed. When disabled or unreachable, no
  trace of the surface remains in any UI.
- Self-update of the server binary: automatic at program start, hourly
  check with notify-only messaging, and on-demand application via the
  `--update` headless flag, the GUI button, or the webapp/TV update button.
- Update-available messaging on GUI, webapp, and TV: version, notes,
  an Update now control where application is possible, a link to the GitHub
  releases page, and the standing note that this updates the server only —
  TV apps are updated manually from the releases page.
- The GUI starts the embedded server automatically on launch whenever the
  required settings are complete; the setup window flow is unchanged.
- Raspberry Pi / systemd layout adaptation so the service user can replace
  its own binary in place.

## Non-goals

- Changes to the external service itself (filelist-ads-server).
- `supporter_plans.enabled` gating; the switch belongs to the external
  service's own checkout flow.
- Login/Register on the TV client (v1 ships web + GUI only).
- Automatic installation on the hourly check; the hourly tick notifies only.
- Configurability of the external base URL; it is a hardcoded constant.
- Donor perks beyond hiding the promoted-content slot.

## Decisions

| Decision | Choice |
| --- | --- |
| Integration architecture | Server-side hub: only the Go server talks to the external service; web, GUI, and TV consume only their own server |
| External base URL | Hardcoded constant in the Go adapter; not a setting |
| API-key storage | Server settings file (existing store, mode 0600); the server polls account status and exposes donor state, so every client including the TV benefits |
| Login session | JWT kept client-side (localStorage, 24 h upstream expiry); identity display only; TV excluded in v1 |
| Donor signal | `donor: true` from account status hides the promotion slot household-wide |
| Update feed | `GET /updates` upstream; per-platform binaries keyed `GOOS-GOARCH`; strict semver compare; newer-only |
| `linux/armv7` builds | No feed entry exists; permanently notify-only |
| Non-writable binary (Docker, root-owned installs) | Capability probe at startup; notify-only; apply endpoint answers 409 with the reason |
| Restart strategy | systemd: graceful exit 0, `Restart=always` relaunches; plain headless: `syscall.Exec`; GUI: re-exec whole app; Windows: rename running exe, spawn new, exit |
| Systemd layout | Binary moves to `/var/lib/filelist-streaming/bin/filelist-streaming` owned by the service user; unit becomes `Restart=always` |
| Live updates to clients | SSE kinds `portal.state` and `updates.available` on the existing `/api/v1/events` stream |
| Check cadence | On start (async, fail-open), hourly with jitter, plus on demand |
| Naming | `portal` / `promotions` internally and on the wire; the external platform is never mentioned in UI or docs |

## Architecture

```
internal/adapters/portalclient/  HTTP client for the external service
internal/application/portal/     hub: cached flags/links, ad proxy, donor
internal/application/updates/    orchestrator: identity, probe, check,
                                 install, restart
internal/adapters/httpapi/       new /api/v1/portal + /api/v1/updates
                                 routes, SSE kinds
internal/composition/            wiring in assemble(); App fields
internal/gui/                    auto-start fix, tray items, bindings
web/                             shared frontend surfaces (webapp + GUI)
clients/tizen/, clients/shared/  TV surfaces
deploy/systemd/, deploy/pi-deploy.sh
```

### Portal hub (`internal/application/portal`)

The adapter client (`portalclient`) performs five upstream calls with 5 s
timeouts and tolerant JSON decoding (unknown fields ignored):

- `GET /api/v1/settings` — `accounts.enabled`, `ads.enabled`
- `GET /api/v1/links` — ordered promoted links
- `GET /api/v1/ads?count=N` — weighted-random creatives; each delivery
  counts one impression upstream
- `GET /api/v1/updates` — newest notice, 404 when none published; the hub
  owns this fetch and the update orchestrator consumes it from the snapshot
- `GET /api/v1/account/status` — donor flag, sent only when the user
  configured an API key and accounts are enabled

The hub holds a snapshot: account flag, promotion flag, donor state, links,
update notice, and per-entry freshness. Refresh runs once shortly after
start and then on an hourly jittered ticker. The failure rule is absolute:
any fetch error, timeout, or non-2xx marks that feature inactive in the
snapshot immediately — no stale serving under an active flag. Upstream
`enabled: false` and fetch failure collapse to the same inactive state, so
clients need not distinguish them.

Promoted creatives are not cached. `GET /api/v1/portal/promotions?count=N`
proxies live to the upstream delivery endpoint (preserving its one-impression
per delivery semantics) whenever the promotion flag is active in the
snapshot, and answers 503 otherwise; the UI treats any failure as an empty
slot.

### Update orchestrator (`internal/application/updates`)

Build identity: version from the linker-injected `composition.Version`
(falling back to the repo `VERSION` file for dev runs) plus a platform key
from `runtime.GOOS`-`runtime.GOARCH` (`darwin-arm64`, `windows-amd64`, ...).
`GOARCH=arm` maps to nothing in the feed's closed platform set; those builds
run in notify-only mode permanently.

The orchestrator never talks to the upstream service itself. It reads the
update notice from the hub snapshot and asks the hub to refresh for each
check: once shortly after start, on the hub's hourly tick, and immediately
before an on-demand apply. The `--update` flag blocks on that refresh so a
fresh notice backs the decision.
Capability probe: at startup the orchestrator verifies it can rename and
rewrite its own executable (temp file in the executable's directory). Docker
images and root-owned installs fail the probe; the orchestrator then reports
`selfUpdate: "notify-only"` and the apply endpoint returns 409 with the
reason.

Check policy:

- At start: serve first; the first check runs a few seconds after boot with
  a 5 s timeout and fails open. A newer version auto-installs immediately,
  so an update at start needs no prompt while a slow upstream cannot delay
  boot.
- Hourly (jittered): check only. A newer version emits `updates.available`
  over SSE and the UIs show the banner. No auto-install mid-run.
- On demand: `filelist-streaming --update` (blocking check, install,
  restart into the new binary, then serve — runs before binding the port),
  the GUI button, or `POST /api/v1/updates/apply` from webapp or TV.

Version comparison parses loose `X.Y.Z` (pre-release suffixes tolerated) and
treats only strictly greater versions as available.

Install: download over https, preferring `binaries[platform].download_url`;
the generic `download_url` is a fallback only when it is a platform-appropriate
archive (`.tar.gz` on Unix, `.zip` on Windows) the server can unpack to a
single binary, otherwise the build stays notify-only. Downloads are verified
for minimum size and sha256; when the download URL points into this
project's GitHub releases, cross-check the digest against that release's
`checksums.txt`. The payload lands in the data dir,
then swaps atomically: the running binary renames to `<name>.old`, the new
binary takes the original path. A successful boot of the new version removes
`.old`; a failed boot keeps it for manual recovery. One apply runs at a
time; concurrent attempts answer 409. An apply on an already-current
install is a successful no-op that reports the current state.

Restart per mode:

- systemd (Pi, adapted layout): the server completes its normal graceful
  shutdown and exits 0; `Restart=always` brings the new binary up within
  seconds.
- Plain headless (no systemd): `syscall.Exec` re-runs the same executable
  and argv in place.
- GUI: the GUI is the server binary — after the swap the whole app re-execs
  (window closes, reopens on the new version).
- Windows: a running exe cannot be overwritten but can be renamed; rename,
  write the new binary at the original path, spawn it, exit.

`GET /api/v1/updates/current` reports `{currentVersion, available, latest,
notes, releasedAt, releasesUrl, selfUpdate}` where `releasesUrl` is the
project's GitHub releases page and `selfUpdate` distinguishes `capable`
from `notify-only`.

### GUI auto-start fix

`internal/gui/runner.go` builds the supervisor but never starts it. `Run`
gains a `sup.Start()` call after the state-event wiring and boot emit, just
before `app.Run()`. The supervisor's `CanStart` already refuses when required
settings are missing, so a wiped configuration still lands in the setup
window; `--minimized` keeps its existing guard (`minimizedHides`).

## Client surfaces

Shared frontend (webapp + GUI webview; keying off `GET /api/v1/portal/state`
at boot plus SSE for live changes):

- Accounts (gate: accounts enabled): Sign in entry opening a login/register
  dialog — email, password; register adds display name. JWT in localStorage;
  on expiry the UI returns to signed-out. Signed-in state shows the display
  name.
- Settings gains an API-key field (same gate): masked input, stored
  server-side through the existing settings pipeline, following the page's
  existing field/test-button conventions.
- Promoted content (gate: promotions enabled and not donor): compact card at
  the bottom of the left nav rail — image, title, one-liner — rotating on
  the creative's `screen_time`; activation opens the upstream click redirect
  in a new tab. Hidden entirely otherwise.
- Other Projects: section in the main menu listing links (title,
  description); each opens in a new tab.
- Update banner: top strip when a newer version exists — version, notes
  excerpt, Update now button (posts apply, then shows an updating/restarting
  state until the SSE stream reconnects), the releases-page link, and the
  "server only — TV apps update manually" note. Settings gains an About row
  with the running version and a check-now button.

GUI extras: tray menu items "Check for updates" and "Update now"; on apply
the app re-execs.

Tizen client:

- Sidebar bottom slot: promotion card, display-only (no browser to open),
  same gates as web.
- Other Projects rows in the sidebar; OK opens a small dialog showing the
  URL as text.
- Update strip: version, server-only/TV-manual note, the releases URL as
  selectable text, and an Update server now button; after apply the TV shows
  its reconnect state until the server returns.

All surfaces follow DESIGN.md's visual language; implementation runs through
the frontend design skills (frontend-design, ui-design, ui-radar,
anti-ui-slop) agreed for this work.

## Degradation matrix

| Upstream condition | UI result (all surfaces) |
| --- | --- |
| public-settings unreachable | Accounts surfaces off; promotion slot off |
| `accounts.enabled: false` | No Sign in, no API-key field |
| `ads.enabled: false` | No promotion slot |
| account status unreachable or key absent | Slot shown unless promotions off; donor hiding off |
| links unreachable | Other Projects section absent |
| ads delivery unreachable at display time | Slot renders empty/hidden for that cycle |
| updates unreachable | No banner (never a false alarm) |

## Security

- The API key lives only in the server settings file (mode 0600) and is
  proxied server-side; clients never see it. The UI masks the field.
- JWTs stay client-side; the server never persists them.
- Update downloads are https-only, size-checked, checksum-verified, and
  swapped atomically; `.old` retention gives a manual rollback path.
- New endpoints inherit the service's existing trusted-LAN posture; the
  apply endpoint adds its own single-flight guard.
- Upstream URLs are treated as untrusted content: absolute https enforced,
  no redirects followed across schemes.

## Deployment changes

- `deploy/systemd/filelist-streaming.service`: `ExecStart` points at
  `/var/lib/filelist-streaming/bin/filelist-streaming serve ...`;
  `Restart=always`; `RestartSec=5`. `ReadWritePaths` already covers the data
  dir, which now also holds the binary.
- `deploy/pi-deploy.sh`: installs the binary at the new path (ownership
  `filelist-streaming`), keeps the previous-binary rollback relative to it,
  and migrates an existing `/usr/local/bin` install on the first run.
  One-time redeploy required.
- Docker: self-update stays notify-only by the capability probe; image
  updates remain the deployment mechanism.

## Testing

- Go: hub tests with a fake upstream client (flags on/off, fetch failure to
  inactive, donor gating, injectable clock for the ticker); orchestrator
  tests (version-compare table, capability probe in temp dirs, single-flight
  guard, atomic swap, checksum-mismatch rejection, `.old` cleanup);
  httpapi route tests; GUI supervisor auto-start test (Run starts the server
  when configured; setup mode stays stopped — regression for the reported
  bug).
- Frontend (vitest, existing patterns): surfaces render when enabled, leave
  zero trace when disabled; update banner state transitions.
- Tizen: existing physical-TV verification flow extended with the new
  focusables and the update strip.

## Risks

- GUI re-exec must preserve argv and work inside the macOS .app bundle path.
- Apply interrupts any active playback; the banner warns before it runs.
- Upstream schema additions must not break decoding (tolerant fields).
- First Pi redeploy after the layout change must migrate cleanly or fall
  back to the old path with a warning.
